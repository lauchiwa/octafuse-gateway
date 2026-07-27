/**
 * OpenAI Responses 协议出站驱动（`POST /v1/responses`）。
 *
 * 与 `openai-driver.ts`（chat）的关键差异，均有实测依据：
 * - **字节直通**：SSE 帧原样转发，不解码重组（对照 `anthropic-driver.ts`）。Codex 对
 *   `response.*` 事件序列完整性敏感，chat 那条路径会 split/join 并 trim 尾行。
 * - **不复用 `transformStreamUsageForClient`**：实测 Responses 上游不在中间事件发累计
 *   usage（仅 `response.completed` 携带），无需剥离；改写反而会破坏帧结构。
 * - usage 在 `data.response.usage`（流式）/ `body.usage`（非流式），不在顶层。
 *
 * 客户端标识（`User-Agent` / `originator`）需要送达上游：部分中转站按调用方识别放行，
 * 未识别时返回 `403 channel:client_restricted`。provider 自配的同名 header 优先。
 */
import { resolveUpstreamEndpoint } from '@octafuse/core';
import type { RouteResult } from '../model-router';
import type { UsageFromStream } from '../proxy';
import { buildRouteRequestBody } from '../route-default-params';
import { extractUpstreamRequestId, normalizeUpstreamId } from './upstream-request-id';
import type { RequestTimingAttempt, RequestTimingCollector } from '../request-timing';
import { mergeUpstreamHeaders } from './merge-upstream-headers';
import {
  extractResponsesUsageFromResponseObject,
  type ResponsesUsageSnapshot,
} from './openai-responses-usage';

const EMPTY_USAGE_LOCAL: UsageFromStream = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: 0,
  raw_usage: null,
  cancelled: false,
  upstreamMessageId: null,
};

/** 与 anthropic/gemini/openai 驱动一致：断连后继续读上游以拿到末尾 usage。 */
const POST_DISCONNECT_DRAIN_MS = 90_000;
const decoder = new TextDecoder();

type SSEState = { lineBuffer: string };

function applyUsage(target: UsageFromStream, next: ResponsesUsageSnapshot): void {
  target.input_tokens = next.input_tokens;
  target.output_tokens = next.output_tokens;
  target.cache_read_tokens = next.cache_read_tokens;
  target.cache_write_tokens = next.cache_write_tokens;
  target.reasoning_tokens = next.reasoning_tokens;
  target.total_tokens = next.total_tokens;
  target.raw_usage = next.raw_usage;
  if (next.upstreamMessageId != null) {
    target.upstreamMessageId = normalizeUpstreamId(next.upstreamMessageId);
  }
}

/**
 * 逐行解析（仅用于观测 usage / timing）。**不参与转发** —— 转发走原始字节。
 *
 * 实测：带工具调用的轮次没有 `output_text.delta`，只有
 * `response.function_call_arguments.delta`，故首 token 标记按「任一 delta 事件」判定。
 */
function parseEventLine(
  line: string,
  usage: UsageFromStream,
  timing?: RequestTimingCollector | null
): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return;
  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return;

  timing?.markFirstEvent();

  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return;
  }
  if (parsed == null || typeof parsed !== 'object') return;
  const eventType = (parsed as { type?: unknown }).type;
  const type = typeof eventType === 'string' ? eventType : '';

  if (type.endsWith('.delta')) {
    if (type.includes('reasoning')) {
      timing?.markFirstReasoningToken();
    }
    timing?.markFirstToken();
  }

  // 注意：此处已剥掉 `data:` 前缀并解析出对象，故直接走对象级提取。
  // 不可再调 `parseResponsesUsageFromDataLine(data)` —— 那个函数要求带 `data:` 前缀，
  // 传裸 JSON 会一律返回 null（曾导致流式 usage 全为 0、请求被记为 incomplete）。
  const next = extractResponsesUsageFromResponseObject(
    (parsed as { response?: unknown }).response
  );
  if (next) applyUsage(usage, next);
}

function parseSSEChunk(
  value: Uint8Array,
  state: SSEState,
  usage: UsageFromStream,
  timing?: RequestTimingCollector | null
): void {
  state.lineBuffer += decoder.decode(value, { stream: true });
  const lines = state.lineBuffer.split('\n');
  // 末项可能是不完整行，留到下次 chunk 或流结束时处理
  state.lineBuffer = lines.pop() ?? '';
  for (const line of lines) {
    parseEventLine(line, usage, timing);
  }
}

function processRemainingLineBuffer(
  state: SSEState,
  usage: UsageFromStream,
  timing?: RequestTimingCollector | null
): void {
  const line = state.lineBuffer;
  state.lineBuffer = '';
  if (!line.trim()) return;
  parseEventLine(line, usage, timing);
}

/**
 * 上游 → 客户端：**原始字节转发**，同时旁路解析 usage。
 *
 * 客户端断开后不再写 writer，但继续读上游至多 `POST_DISCONNECT_DRAIN_MS` 以尽量拿到
 * 末尾 usage。注意：与其他三个驱动一致，`requestSignal` abort 路径不设 `disconnectTime`，
 * 故该上限仅在 writer 抛错路径生效（既有行为，未在此任务中改动）。
 */
async function pumpWithUsageTracking(
  upstream: ReadableStream<Uint8Array>,
  downstream: WritableStream<Uint8Array>,
  usage: UsageFromStream,
  resolveUsage: (u: UsageFromStream) => void,
  requestSignal?: AbortSignal,
  timing?: RequestTimingCollector | null
): Promise<void> {
  const reader = upstream.getReader();
  const writer = downstream.getWriter();
  const state: SSEState = { lineBuffer: '' };
  let clientDisconnected = false;
  let disconnectTime = 0;

  const onAbort = (): void => {
    usage.cancelled = true;
    clientDisconnected = true;
  };
  requestSignal?.addEventListener('abort', onAbort);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        processRemainingLineBuffer(state, usage, timing);
        break;
      }

      if (value.byteLength > 0) timing?.markFirstByte();
      parseSSEChunk(value, state, usage, timing);

      if (!clientDisconnected) {
        try {
          // 字节直通：原样写出上游 chunk，不重组、不改写
          await writer.write(value);
        } catch {
          clientDisconnected = true;
          disconnectTime = Date.now();
          usage.cancelled = true;
          console.log(
            '[Gateway Responses] client disconnected, draining upstream for usage input_tokens=%s output_tokens=%s',
            usage.input_tokens,
            usage.output_tokens
          );
        }
      }

      if (
        clientDisconnected &&
        disconnectTime > 0 &&
        Date.now() - disconnectTime > POST_DISCONNECT_DRAIN_MS
      ) {
        console.log('[Gateway Responses] drain timeout, resolving with partial usage');
        await reader.cancel();
        break;
      }
    }
  } catch (err) {
    console.warn(
      '[Gateway Responses] pump error',
      err instanceof Error ? err.message : String(err)
    );
  } finally {
    requestSignal?.removeEventListener('abort', onAbort);
    timing?.markStreamComplete();
    resolveUsage(usage);
    try {
      await writer.close();
    } catch (err) {
      console.warn(
        '[Gateway Responses] pump writer.close (non-fatal)',
        err instanceof Error ? err.message : String(err),
        { clientDisconnected, usageCancelled: usage.cancelled }
      );
    }
  }
}

function streamResponseWithUsage(
  response: Response,
  requestSignal?: AbortSignal,
  timing?: RequestTimingCollector | null
): { response: Response; usagePromise: Promise<UsageFromStream> } {
  const usage: UsageFromStream = { ...EMPTY_USAGE_LOCAL };
  let resolveUsage: (u: UsageFromStream) => void = () => {};
  const usagePromise = new Promise<UsageFromStream>((resolve) => {
    resolveUsage = resolve;
  });

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  void pumpWithUsageTracking(
    response.body as ReadableStream<Uint8Array>,
    writable,
    usage,
    resolveUsage,
    requestSignal,
    timing
  );

  return {
    response: new Response(readable, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    usagePromise,
  };
}

/** 非流式：响应体本身就是 response 对象，usage 在 `body.usage`（非 `data.response.usage`）。 */
async function nonStreamResponseWithUsage(
  response: Response,
  timing?: RequestTimingCollector | null
): Promise<{ response: Response; usagePromise: Promise<UsageFromStream> }> {
  const text = await response.text();
  const usage: UsageFromStream = { ...EMPTY_USAGE_LOCAL };
  try {
    const parsed = JSON.parse(text) as unknown;
    const next = extractResponsesUsageFromResponseObject(parsed);
    if (next) applyUsage(usage, next);
  } catch {
    // 保持零 usage：路由层会据此记为 incomplete
  }
  timing?.markFirstByte();
  timing?.markStreamComplete();
  return {
    response: new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    usagePromise: Promise.resolve(usage),
  };
}

/**
 * 仅供单测：把一段完整 SSE 文本喂给行解析器，返回累积的 usage。
 * 覆盖 `parseEventLine` → `extractResponsesUsageFromResponseObject` 的接缝
 * （曾因双重剥离 `data:` 前缀导致 usage 恒为 0）。
 */
export function collectUsageFromSseTextForTest(text: string): UsageFromStream {
  const usage: UsageFromStream = { ...EMPTY_USAGE_LOCAL };
  for (const line of text.split('\n')) {
    parseEventLine(line, usage);
  }
  return usage;
}

/**
 * 仅供单测：按任意 chunk 边界喂入原始字节，验证跨 chunk 的超长行仍能解析。
 * 真实抓包里终止帧那一行约 23KB，必然跨多个网络 chunk。
 * 接受 `Uint8Array[]`（与 pump 的真实输入一致）或 `string[]`（便于写用例）。
 */
export function collectUsageFromSseChunksForTest(
  chunks: ReadonlyArray<Uint8Array | string>
): UsageFromStream {
  const usage: UsageFromStream = { ...EMPTY_USAGE_LOCAL };
  const state: SSEState = { lineBuffer: '' };
  const enc = new TextEncoder();
  for (const c of chunks) {
    parseSSEChunk(typeof c === 'string' ? enc.encode(c) : c, state, usage);
  }
  // 与真实 pump 的 done 分支一致：flush 无换行结尾的残留行
  processRemainingLineBuffer(state, usage);
  return usage;
}

/**
 * 把调用方身份合并进 custom 侧，**大小写不敏感**去重。
 *
 * `mergeUpstreamHeaders` 是 `{...custom, ...base}`（base 覆盖 custom），所以调用方身份
 * 必须放 custom 侧才能被 provider 配置覆盖。而 `{'user-agent': a, 'User-Agent': b}` 是两个
 * 不同的对象键，都会活到 `new Headers()` 并被**逗号拼接**成 `"a, b"` —— 因此这里在合并前
 * 丢弃任何小写形式已被 provider 占用的调用方 header。
 */
export function withClientIdentity(
  providerCustomHeaders: Record<string, string> | undefined | null,
  clientIdentity: Record<string, string> | undefined | null
): Record<string, string> | undefined {
  const custom = providerCustomHeaders ?? undefined;
  if (!clientIdentity || Object.keys(clientIdentity).length === 0) {
    return custom;
  }
  const providerKeysLower = new Set(Object.keys(custom ?? {}).map((k) => k.toLowerCase()));
  const merged: Record<string, string> = { ...(custom ?? {}) };
  for (const [name, value] of Object.entries(clientIdentity)) {
    if (!value) continue;
    // provider 显式配置优先：同名（忽略大小写）时丢弃调用方值
    if (providerKeysLower.has(name.toLowerCase())) continue;
    merged[name] = value;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * 出站到 `/v1/responses`。
 *
 * timing 仅标记 driver 拥有的部分：`markAttemptHeaders` / `markFirstByte` /
 * `markFirstEvent` / `markFirstReasoningToken` / `markFirstToken` / `markStreamComplete`。
 * attempt 生命周期标记（dispatchStart / error / failover / final）归 `failover-dispatch.ts`。
 *
 * 与其他驱动一致：**不把 `requestSignal` 传给 `fetch`** —— 否则客户端断开会立即掐断上游，
 * 拿不到末尾 usage（drain 逻辑失效）。
 */
export async function dispatchOpenAiResponsesRoute(
  route: RouteResult,
  body: Record<string, unknown>,
  clientIdentity: Record<string, string> | undefined,
  requestSignal?: AbortSignal,
  timing?: RequestTimingCollector | null,
  attempt?: RequestTimingAttempt
): Promise<{ response: Response; usagePromise: Promise<UsageFromStream>; upstreamRequestId: string | null }> {
  const url = resolveUpstreamEndpoint('openai', 'responses', route.providerEndpoints, {
    providerId: route.providerId,
  });
  const requestBody = {
    ...buildRouteRequestBody(route, body),
    model: route.providerModelName,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: mergeUpstreamHeaders(
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${route.providerApiKey}`,
      },
      withClientIdentity(route.providerCustomHeaders, clientIdentity)
    ),
    body: JSON.stringify(requestBody),
  });
  timing?.markAttemptHeaders(attempt, response.status);
  const upstreamRequestId = extractUpstreamRequestId(response.headers);

  if (response.ok && response.body) {
    const contentType = response.headers.get('Content-Type') ?? '';
    // 流式为 text/event-stream；非流式（stream:false）为 application/json
    if (contentType.includes('application/json')) {
      const result = await nonStreamResponseWithUsage(response, timing);
      return { ...result, upstreamRequestId };
    }
    const result = streamResponseWithUsage(response, requestSignal, timing);
    return { ...result, upstreamRequestId };
  }

  return {
    response,
    usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
    upstreamRequestId,
  };
}

/** 供路由层构造 `clientIdentity`；`normalizeUpstreamId` 在此保持导入以对齐其他驱动的用法。 */
export { normalizeUpstreamId };
