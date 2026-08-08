/**
 * 用户路由：`POST /v1/responses`（OpenAI Responses 协议，Codex CLI 唯一支持的 wire API）。
 *
 * 与 `chat.ts` 的差异（其余流程完全一致，刻意保持镜像以便一起演进）：
 * - **能力门禁**：只有显式声明 `endpoints.openai.endpoints.responses` 的 provider 能服务本路由；
 *   其余一律过滤，全部不支持时回 502。**同协议进出，不做 Responses→Chat 翻译降级** —— 翻译会
 *   静默丢弃 `reasoning` / `prompt_cache_key` 与历史中的 reasoning items，表现为「模型变笨」
 *   而非可诊断的失败，并会掩盖 endpoint URL 配错这类问题。
 *   能力判定不从 `base` 派生（`listConfiguredCapabilities` 在有 `base` 时会返回全部能力，
 *   会把 10/42 个仅配 base 的预设误判为原生可用）。
 * - **调用方身份透传**：`User-Agent` / `originator` 提取后交给驱动闭包
 *   （`DispatchFn` 契约不含请求对象）。中转站常按 UA 放行 Codex。
 * - **脱敏**：Responses 的 prompt 在 `input` 与 **`instructions`** 两处，
 *   后者 chat 的脱敏函数不认识（会把 Codex 完整系统提示词写进请求日志）。
 * - `request_protocol` 仍记 `'openai'`：`UpstreamProtocol` 是路由筛选的核心类型，
 *   新增取值会牵动 failover 与敏感内容熔断的类型面。
 */
import { Hono } from 'hono';
import { providerDeclaresResponsesEndpoint } from '@octafuse/core';
import type { Env } from '../../app';
import { requireApiKey } from '../../middleware/auth';
import {
  resolveRoutesForSurface,
  type RouteResult,
} from '../../services/model-router';
import { resolveModelRouting } from '../../services/resolve-model-route-group';
import { stickyConfigFromSurface } from '../../services/provider-sticky-routing';
import {
  buildAffinityKey,
  buildTierKeyPrefix,
  resolveRouteStrategyPlan,
} from '../../services/route-strategies';
import { proxyResponses, EMPTY_USAGE, type UsageFromStream } from '../../services/proxy';
import { finalizeRequestLogJson } from '../../services/request-log-shared';
import { summarizeOpenAiToolsForLog } from '../../services/request-log-tools-summary';
import { buildRouteRequestBody } from '../../services/route-default-params';
import { recordUsage } from '../../services/usage-tracker';
import { scheduleBackgroundWork } from '../../runtime/schedule-background-work';
import {
  computeRequestLogStatus,
  formatHttpErrorTextForRequestLog,
  materializeNonOkResponse,
} from '../../services/request-log-record-status';
import {
  maybeBlockUserModelCircuit,
  maybeTriggerUserModelCircuitFromUpstream,
  markUserModelSuccess,
} from '../../services/user-model-circuit-route';
import { RequestTimingCollector } from '../../services/request-timing';

/** 与 chat/messages 一致：上游挂死时的记账兜底。 */
const USAGE_SAFETY_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

/**
 * Responses 请求体脱敏：丢掉 `input`、**`instructions`**、`prompt`、`data`；
 * `tools` 走摘要（避免整份 JSON Schema 落库）。
 */
export function responsesBodyRedactedForLog(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'input' || k === 'instructions' || k === 'prompt' || k === 'data') {
      continue;
    }
    if (k === 'tools') {
      Object.assign(out, summarizeOpenAiToolsForLog(v));
      continue;
    }
    out[k] = v;
  }
  if (Array.isArray(body.input)) {
    out._input_count = body.input.length;
  }
  return out;
}

function responsesRequestBodyForLog(body: Record<string, unknown>): string | null {
  return finalizeRequestLogJson(responsesBodyRedactedForLog(body));
}

/** 与驱动一致：`{ ...buildRouteRequestBody, model: providerModelName }` 再脱敏。 */
function responsesUpstreamWireBodyForLog(
  route: RouteResult,
  body: Record<string, unknown>
): string | null {
  const merged = buildRouteRequestBody(route, body);
  const wire = { ...merged, model: route.providerModelName };
  return finalizeRequestLogJson(responsesBodyRedactedForLog(wire));
}

/** 与 chat.ts 同语义（该函数未导出，此处按同一规则重写）。 */
export function hasUsage(u: UsageFromStream): boolean {
  return u.total_tokens > 0 || u.input_tokens > 0 || u.output_tokens > 0;
}

/** 调用方身份：仅取 UA / originator，值为空则不带（网关绝不自造 UA）。 */
function extractClientIdentity(c: {
  req: { header: (name: string) => string | undefined };
}): Record<string, string> {
  const out: Record<string, string> = {};
  const ua = c.req.header('user-agent')?.trim();
  if (ua) out['user-agent'] = ua;
  const originator = c.req.header('originator')?.trim();
  if (originator) out.originator = originator;
  return out;
}

type ResponsesEnv = Env & { Variables: { apiKey: import('../../middleware/auth').ApiKeyContext } };

export const responsesRoutes = new Hono<ResponsesEnv>();

responsesRoutes.use('*', requireApiKey);

responsesRoutes.post('/', async (c) => {
  const repos = c.get('repositories');
  const apiKey = c.get('apiKey');
  const start = Date.now();
  const timing = new RequestTimingCollector();

  let body: { model?: string; [k: string]: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const rawModelId = typeof body.model === 'string' ? body.model.trim() : null;
  if (!rawModelId) {
    return c.json({ error: 'Missing model' }, 400);
  }

  const resolved = await resolveModelRouting(repos, rawModelId);
  if (!resolved) {
    return c.json({ error: 'Model not found' }, 404);
  }
  const { model, baseModelId, explicitGroup } = resolved;
  const effectiveRouteGroup = explicitGroup?.trim() || 'default';

  // `/v1/responses` 不在 middleware/auth 的预算豁免名单里，但那里的检查发生在解析 model 之前，
  // 与 chat 一致地在此复检，保证未知模型返回 404 而不是 403。
  if (apiKey.budgetMax != null && apiKey.budgetSpent >= apiKey.budgetMax) {
    return c.json({ error: 'Budget exceeded' }, 403);
  }

  let routes: RouteResult[];
  let poolStrategy: string | null = null;
  let poolTierStrategies: string | null = null;
  let stickySurface: import('@octafuse/core').ResolvedModelSurfaceRow | null = null;
  try {
    // 与 chat / messages / gemini / images / audio 一致走 surface 解析：否则本路由拿不到
    // route_pool 的 strategy / tier_strategies / sticky 配置。生产库确实存在
    // request_operation='responses' 的 surface（上游无此面，所以上游重构不会带上它）。
    // 无 surface 时 resolveRoutesForSurface 会自动回退到 legacy 选路，行为与旧代码一致。
    const resolvedSurface = await resolveRoutesForSurface(repos, {
      modelId: baseModelId,
      routeGroup: effectiveRouteGroup,
      requestProtocol: 'openai',
      requestOperation: 'responses',
    });
    routes = resolvedSurface.routes;
    poolStrategy = resolvedSurface.surface?.pool_strategy ?? null;
    poolTierStrategies = resolvedSurface.surface?.pool_tier_strategies ?? null;
    stickySurface = resolvedSurface.surface;
    if (routes.length === 0) {
      return c.json(
        { error: `No active routes for route group "${effectiveRouteGroup}" for this model` },
        400
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Model route resolution failed';
    console.error('[Gateway Responses] model route resolution failed', { baseModelId, err });
    return c.json({ error: message }, 502);
  }

  routes = routes.filter((route) => route.upstreamProtocol === 'openai');
  if (routes.length === 0) {
    console.warn('[Gateway Responses] no openai route for model', {
      baseModelId,
      effectiveRouteGroup,
    });
    return c.json(
      { error: `No OpenAI route in route group "${effectiveRouteGroup}" for this model` },
      502
    );
  }

  // 能力门禁：只服务显式声明 `endpoints.openai.endpoints.responses` 的 provider。
  // 同协议进出 —— 不做 Responses→Chat 翻译降级。理由：翻译必然丢弃 `reasoning`
  // （`encrypted_content` 只对产出它的上游有意义）、`prompt_cache_key` 与 input 中的
  // reasoning items，且这些损耗**不报错**，只表现为「模型变笨 + 缓存全 miss」。
  // 让不支持的 provider 显式 502，配置错误才能被发现而不是被静默兜住。
  //
  // 能力判定不从 `base` 派生（`listConfiguredCapabilities` 在有 `base` 时会返回全部能力，
  // 会把 10/42 个仅配 base 的预设误判为原生可用）。
  const unsupportedRoutes = routes.filter(
    (route) => !providerDeclaresResponsesEndpoint(route.providerEndpoints)
  );
  routes = routes.filter((route) => providerDeclaresResponsesEndpoint(route.providerEndpoints));
  if (routes.length === 0) {
    const names = unsupportedRoutes.map((r) => r.providerName).join(', ');
    console.warn('[Gateway Responses] no provider declares a responses endpoint', {
      baseModelId,
      effectiveRouteGroup,
      unsupported: unsupportedRoutes.map((r) => r.providerId),
    });
    return c.json(
      {
        error: `No provider for this model serves the Responses API. Configure endpoints.openai.endpoints.responses for: ${names}`,
      },
      502
    );
  }
  if (unsupportedRoutes.length > 0) {
    console.log('[Gateway Responses] skipping providers without a responses endpoint', {
      baseModelId,
      serving: routes.map((r) => r.providerId),
      skipped: unsupportedRoutes.map((r) => r.providerId),
    });
  }

  console.log(
    `[Gateway Responses] forwarding baseModelId=${baseModelId} clientModel=${rawModelId} providerIds=${routes
      .map((r) => r.providerId)
      .join(',')} keyId=${apiKey.keyId}`
  );

  const modelNameForLog =
    model.display_name != null && String(model.display_name).trim() !== ''
      ? String(model.display_name).trim()
      : baseModelId;
  const requestBodyForLog = responsesRequestBodyForLog(body as Record<string, unknown>);

  const circuitBlocked = maybeBlockUserModelCircuit(c, repos, apiKey, {
    baseModelId,
    modelNameForLog,
    requestBodyForLog,
    requestProtocol: 'openai',
    startMs: start,
    timing,
  });
  if (circuitBlocked) {
    return circuitBlocked;
  }

  const requestSignal = c.req.raw.signal;
  const strategyPlan = await resolveRouteStrategyPlan({
    routePolicyRaw: model.route_policy ?? null,
    poolStrategy,
    poolTierStrategies,
    protocol: 'openai',
    capability: 'responses',
    routeGroup: effectiveRouteGroup,
    repos,
  });
  const affinityKey = buildAffinityKey(apiKey.userId, baseModelId, effectiveRouteGroup, 'openai');
  const tierKeyPrefix = buildTierKeyPrefix(baseModelId, effectiveRouteGroup, 'openai');
  const clientIdentity = extractClientIdentity(c);
  timing.markGatewayComplete();
  const proxyResult = await proxyResponses(repos, routes, body, clientIdentity, requestSignal, {
    affinityKey,
    tierKeyPrefix,
    strategy: strategyPlan.base,
    tierStrategies: strategyPlan.tierOverrides,
    timing,
    routePoolId: stickySurface?.route_pool_id ?? routes[0]?.routePoolId ?? null,
    sticky: stickyConfigFromSurface(stickySurface),
  });
  const {
    usagePromise,
    chosenRoute,
    upstreamRequestId,
    circuitEvents,
    suppressErrorAlert,
    stickyTrace,
    stickyMutationPromise,
  } = proxyResult;
  if (stickyMutationPromise) {
    scheduleBackgroundWork(c, stickyMutationPromise);
  }
  const { response, errorBodyText } = await materializeNonOkResponse(proxyResult.response);

  let userModelCircuitEvent = null;
  if (response.ok) {
    // 与 chat/messages 一致：成功即重置 user+model 失败计数，否则退避永不恢复。
    markUserModelSuccess(apiKey.userId, baseModelId);
  } else if (errorBodyText != null) {
    userModelCircuitEvent = maybeTriggerUserModelCircuitFromUpstream(
      apiKey.userId,
      baseModelId,
      response.status,
      response.headers.get('content-type'),
      errorBodyText,
      formatHttpErrorTextForRequestLog(
        response.status,
        response.headers.get('content-type'),
        errorBodyText
      )
    );
  }

  const alertCircuitEvents = userModelCircuitEvent
    ? [...circuitEvents, userModelCircuitEvent]
    : circuitEvents;

  const usageOrSafety = Promise.race([
    usagePromise.then((u) => ({
      usage: u,
      incomplete: !hasUsage(u),
      timedOut: false as const,
    })),
    new Promise<{ usage: typeof EMPTY_USAGE; incomplete: true; timedOut: true }>((resolve) =>
      setTimeout(
        () => resolve({ usage: EMPTY_USAGE, incomplete: true, timedOut: true }),
        USAGE_SAFETY_TIMEOUT_MS
      )
    ),
  ]);

  // 在调度后台任务**之前**就把上游 wire body 脱敏成短字符串：后台闭包只捕获这个
  // 结果（实测最长 ~600 字符），而不是整个 `body`。否则 41 万 token 的会话对象图会随闭包
  // 一起存活到 usage resolve 或 `USAGE_SAFETY_TIMEOUT_MS` 到期（最长 5 分钟），
  // 多个大请求并发时足以撞穿 Worker 的 128MB isolate 内存上限（Error 1102）。
  const upstreamRequestBodyForLog = responsesUpstreamWireBodyForLog(
    chosenRoute,
    body as Record<string, unknown>
  );

  scheduleBackgroundWork(
    c,
    usageOrSafety
      .then(async ({ usage: usageCollected, incomplete, timedOut }) => {
        const latency = Date.now() - start;
        if (timedOut) timing.markStreamComplete();
        const status = computeRequestLogStatus({
          cancelled: Boolean(usageCollected.cancelled),
          responseOk: response.ok,
          incomplete,
        });
        let errorMessage: string | undefined;
        if (status === 'success') {
          errorMessage = undefined;
        } else if (status === 'cancelled') {
          errorMessage = 'Client disconnected (e.g. user cancelled)';
        } else if (status === 'incomplete') {
          errorMessage = timedOut
            ? 'Stream usage timeout (no usage within limit)'
            : 'Stream ended before usage available';
        } else if (errorBodyText != null) {
          errorMessage = formatHttpErrorTextForRequestLog(
            response.status,
            response.headers.get('content-type'),
            errorBodyText
          );
        }
        return recordUsage(repos, {
          api_key_id: apiKey.keyId,
          user_id: apiKey.userId,
          user_email: apiKey.userEmail,
          model_id: baseModelId,
          provider_id: chosenRoute.providerId,
          provider_model_name: chosenRoute.providerModelName,
          model_name: modelNameForLog,
          provider_name: chosenRoute.providerName,
          request_body: requestBodyForLog,
          upstream_request_body: upstreamRequestBodyForLog,
          request_protocol: 'openai',
          upstream_protocol: chosenRoute.upstreamProtocol,
          usage: usageCollected,
          model_pricing_profile: model.pricing_profile ?? null,
          route_price_override_json: chosenRoute.priceOverrideRaw,
          route_metered_profile_json: chosenRoute.routeMeteredProfileJson,
          route_charged_profile_json: chosenRoute.routeChargedProfileJson,
          request_started_at_ms: start,
          route_group: chosenRoute.routeGroup,
          status,
          latency_ms: latency,
          timing: timing.snapshot(),
          error_message: errorMessage,
          provider_key_id: chosenRoute.providerKeyId ?? null,
          provider_key_label: chosenRoute.providerKeyLabel ?? null,
          provider_key_fingerprint: chosenRoute.providerKeyFingerprint ?? null,
          upstream_request_id: upstreamRequestId,
          upstream_message_id: usageCollected.upstreamMessageId ?? null,
          circuit_events: alertCircuitEvents.length > 0 ? alertCircuitEvents : undefined,
          suppress_error_alert: suppressErrorAlert || undefined,
        });
      })
      .catch((err) => {
        console.error(
          `[Gateway Responses] recordUsage failed baseModelId=${baseModelId} keyId=${apiKey.keyId} error=${
            err instanceof Error ? err.message : String(err)
          }`
        );
      })
  );

  return response;
});
