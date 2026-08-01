/**
 * 用户路由：`POST /v1/responses`（OpenAI Responses 协议，Codex CLI 唯一支持的 wire API）。
 *
 * 与 `chat.ts` 的差异（其余流程完全一致，刻意保持镜像以便一起演进）：
 * - **出站策略分区（phase 2）**：显式声明 `endpoints.openai.endpoints.responses` 的 provider
 *   走字节直通；其余翻译成 `/chat/completions`。两类都可服务，故不再有「能力不足」过滤与 502
 *   —— 只按「直通优先」排序（原生可用时行为与 phase 1 一致，翻译仅作兜底）。
 *   能力判定不从 `base` 派生（`listConfiguredCapabilities` 在有 `base` 时会返回全部能力，
 *   会把 10/42 个仅配 base 的预设误判为原生可用）。
 * - **翻译前置校验**：无法在 Chat 协议表达且改变语义的字段（`previous_response_id` /
 *   `store:true` / 托管工具）在此返回 400。放在 dispatch 之前，因为驱动内 throw 会被
 *   `failover-dispatch` 当成 fetch 失败，对每把 key 重试一轮后只回笼统 502。
 * - **调用方身份透传**：`User-Agent` / `originator` 提取后交给驱动闭包
 *   （`DispatchFn` 契约不含请求对象）。中转站常按 UA 放行 Codex。
 * - **脱敏**：Responses 的 prompt 在 `input` 与 **`instructions`** 两处，
 *   后者 chat 的脱敏函数不认识（会把 Codex 完整系统提示词写进请求日志）。
 * - `request_protocol` 仍记 `'openai'`：`UpstreamProtocol` 是路由筛选的核心类型，
 *   新增取值会牵动 failover 与敏感内容熔断的类型面。
 */
import { Hono } from 'hono';
import { providerDeclaresResponsesEndpoint } from '@octafuse/core';
import { translateResponsesRequestToChat } from '../../services/egress/responses-to-chat-request';
import type { Env } from '../../app';
import { requireApiKey } from '../../middleware/auth';
import {
  getActiveModelRouteRows,
  resolveRouteResultsFromRows,
  type RouteResult,
} from '../../services/model-router';
import { resolveModelRouting } from '../../services/resolve-model-route-group';
import { selectActiveRouteRows } from '../../services/route-selection';
import { buildStickyDispatchContext } from '../../services/failover-dispatch';
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
  maybeBlockSensitiveContentCircuit,
  maybeTriggerSensitiveContentCircuitFromUpstream,
} from '../../services/sensitive-content-circuit-route';
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
  try {
    const routeRows = await getActiveModelRouteRows(repos, baseModelId);
    const selectedRows = selectActiveRouteRows(routeRows, explicitGroup);
    if (selectedRows.length === 0) {
      return c.json(
        { error: `No active routes for route group "${effectiveRouteGroup}" for this model` },
        400
      );
    }
    // providerEndpoints 直到这一步才被解析出来 —— 能力门禁必须在此之后。
    routes = await resolveRouteResultsFromRows(repos, selectedRows);
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

  // phase 2：能力不再是门禁，而是**策略选择**。声明了 `endpoints.openai.endpoints.responses`
  // 的 provider 走字节直通；其余翻译成 `/chat/completions`。
  // 排序为「直通优先」，故障转移时才回落到翻译 —— 代价是混合路由组内会覆盖 admin 配置的
  // 权重顺序（design.md「Route ordering」已记录为决策）。
  const passthroughRoutes = routes.filter((route) =>
    providerDeclaresResponsesEndpoint(route.providerEndpoints)
  );
  const translateRoutes = routes.filter(
    (route) => !providerDeclaresResponsesEndpoint(route.providerEndpoints)
  );
  routes = [...passthroughRoutes, ...translateRoutes];
  if (translateRoutes.length > 0) {
    console.log('[Gateway Responses] translating to chat for providers without a responses endpoint', {
      baseModelId,
      passthrough: passthroughRoutes.map((r) => r.providerId),
      translate: translateRoutes.map((r) => r.providerId),
    });
  }

  // 翻译不可行的请求级特性：在出站**之前**返回 400。
  // 若留给驱动 throw，failover-dispatch 会当成 fetch 失败，对每把 key 重试一轮后只回笼统 502。
  // 仅当本次可能走翻译路径时才校验：全部直通时这些字段由上游自行处理。
  if (passthroughRoutes.length === 0 && translateRoutes.length > 0) {
    const precheck = translateResponsesRequestToChat(body as Record<string, unknown>);
    if (!precheck.ok) {
      console.warn('[Gateway Responses] request cannot be translated to chat', {
        baseModelId,
        param: precheck.error.param,
      });
      return c.json(
        { error: { message: precheck.error.message, type: 'invalid_request_error', param: precheck.error.param } },
        400
      );
    }
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

  const circuitBlocked = maybeBlockSensitiveContentCircuit(c, repos, apiKey, {
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
  const stickyContext = buildStickyDispatchContext({
    stickyConfigRaw: model.sticky_config ?? null,
    userId: apiKey.userId,
    baseModelId,
    routeGroup: effectiveRouteGroup,
    protocol: 'openai',
  });
  const clientIdentity = extractClientIdentity(c);
  timing.markGatewayComplete();
  const proxyResult = await proxyResponses(repos, routes, body, clientIdentity, requestSignal, {
    sticky: stickyContext,
    timing,
  });
  const { usagePromise, chosenRoute, upstreamRequestId, circuitEvents, suppressErrorAlert } =
    proxyResult;
  const { response, errorBodyText } = await materializeNonOkResponse(proxyResult.response);

  let sensitiveCircuitEvent = null;
  if (errorBodyText != null) {
    sensitiveCircuitEvent = maybeTriggerSensitiveContentCircuitFromUpstream(
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

  const alertCircuitEvents = sensitiveCircuitEvent
    ? [...circuitEvents, sensitiveCircuitEvent]
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
        const upstreamRequestBodyForLog = responsesUpstreamWireBodyForLog(
          chosenRoute,
          body as Record<string, unknown>
        );
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
