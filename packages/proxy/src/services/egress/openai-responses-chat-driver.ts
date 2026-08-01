/**
 * Responses 协议出站驱动之二：**翻译到 Chat Completions**。
 *
 * 适用于没有原生 `/v1/responses` 的中转站。与 phase 1 的
 * `openai-responses-driver.ts`（字节直通）是同一签名的两种策略，由 `proxyResponses` 按
 * `providerDeclaresResponsesEndpoint(route)` 逐路由选择。
 *
 * 与 phase 1 直通驱动的关键差异：
 * - **不能字节直通**：两侧事件词汇不同，必须按行重组并合成 Responses 生命周期事件
 *   （见 `chat-to-responses-stream.ts`）。
 * - 出站打的是 `chat` 能力的 URL —— 这正是该 provider **有**的能力。
 * - 请求体先过 `translateResponsesRequestToChat`；不可翻译的请求级特性在此转成 400，
 *   **不抛异常** —— `failover-dispatch` 会把驱动抛错当成 fetch 失败，对该 provider 的
 *   每把 key 重试一轮，最后只回一个笼统 502（phase 1 记录的 C-1 陷阱）。
 *
 * 与 phase 1 保持一致的部分（有意逐条对齐）：客户端标识透传、断连后继续 drain 取末尾 usage、
 * 不把 `requestSignal` 传给 `fetch`、timing 只标记驱动自己拥有的阶段。
 */
import { resolveUpstreamEndpoint } from '@octafuse/core';
import type { RouteResult } from '../model-router';
import type { UsageFromStream } from '../proxy';
import { buildRouteRequestBody } from '../route-default-params';
import { extractUpstreamRequestId, normalizeUpstreamId } from './upstream-request-id';
import type { RequestTimingAttempt, RequestTimingCollector } from '../request-timing';
import { mergeUpstreamHeaders } from './merge-upstream-headers';
import { withClientIdentity } from './openai-responses-driver';
import { translateResponsesRequestToChat } from './responses-to-chat-request';
import { translateChatCompletionToResponses } from './chat-to-responses-object';
import {
  ChatToResponsesStreamTranslator,
  serializeEvent,
  type EmittedEvent,
} from './chat-to-responses-stream';

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

/** 与其它驱动一致：断连后继续读上游以拿到末尾 usage。 */
const POST_DISCONNECT_DRAIN_MS = 90_000;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

type SSEState = { lineBuffer: string };

/**
 * 上游 chat SSE → 客户端 Responses SSE。
 *
 * 与 phase 1 直通驱动的结构相同，唯一区别是写出的是**翻译后**的事件字节。
 * 客户端断开后不再写 writer，但继续读上游至多 `POST_DISCONNECT_DRAIN_MS` 以拿到末尾 usage。
 */
async function pumpTranslatingStream(
  upstream: ReadableStream<Uint8Array>,
  downstream: WritableStream<Uint8Array>,
  translator: ChatToResponsesStreamTranslator,
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

  /** 写出翻译产物；写失败即认定客户端断开，转入 drain。 */
  const emit = async (events: EmittedEvent[]): Promise<void> => {
    if (events.length === 0 || clientDisconnected) return;
    for (const event of events) {
      if (event.type !== 'response.created') timing?.markFirstEvent();
      try {
        await writer.write(encoder.encode(serializeEvent(event)));
      } catch {
        clientDisconnected = true;
        disconnectTime = Date.now();
        usage.cancelled = true;
        console.log(
          '[Gateway Responses:translate] client disconnected, draining upstream for usage'
        );
        return;
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value.byteLength > 0) timing?.markFirstByte();
      state.lineBuffer += decoder.decode(value, { stream: true });
      const lines = state.lineBuffer.split('\n');
      // 末项可能是不完整行，留到下个 chunk（工具调用参数常跨 chunk 切断）
      state.lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const events = translator.pushLine(line);
        if (events.length > 0) {
          timing?.markFirstToken();
          await emit(events);
        }
      }

      if (
        clientDisconnected &&
        disconnectTime > 0 &&
        Date.now() - disconnectTime > POST_DISCONNECT_DRAIN_MS
      ) {
        console.log('[Gateway Responses:translate] drain timeout, resolving with partial usage');
        await reader.cancel();
        break;
      }
    }

    // flush 无换行结尾的残留行
    if (state.lineBuffer.trim() !== '') {
      await emit(translator.pushLine(state.lineBuffer));
    }
    // 终止事件：即使上游异常断流也必须发，否则 Codex 会挂住
    await emit(translator.finish());
  } catch (err) {
    console.warn(
      '[Gateway Responses:translate] pump error',
      err instanceof Error ? err.message : String(err)
    );
    // 异常路径同样补齐终止事件
    try {
      await emit(translator.finish());
    } catch {
      // 已断开，忽略
    }
  } finally {
    requestSignal?.removeEventListener('abort', onAbort);
    timing?.markStreamComplete();
    const collected = translator.usage;
    if (collected) {
      usage.input_tokens = collected.input_tokens;
      usage.output_tokens = collected.output_tokens;
      usage.cache_read_tokens = collected.cache_read_tokens;
      usage.cache_write_tokens = collected.cache_write_tokens;
      usage.reasoning_tokens = collected.reasoning_tokens;
      usage.total_tokens = collected.total_tokens;
      usage.raw_usage = collected.raw_usage;
    }
    const messageId = translator.upstreamMessageIdValue;
    if (messageId != null) usage.upstreamMessageId = normalizeUpstreamId(messageId);
    resolveUsage(usage);
    try {
      await writer.close();
    } catch (err) {
      console.warn(
        '[Gateway Responses:translate] writer.close (non-fatal)',
        err instanceof Error ? err.message : String(err),
        { clientDisconnected, usageCancelled: usage.cancelled }
      );
    }
  }
}

function streamTranslated(
  response: Response,
  requestEcho: Record<string, unknown>,
  model: string,
  requestSignal?: AbortSignal,
  timing?: RequestTimingCollector | null
): { response: Response; usagePromise: Promise<UsageFromStream> } {
  const usage: UsageFromStream = { ...EMPTY_USAGE_LOCAL };
  let resolveUsage: (u: UsageFromStream) => void = () => {};
  const usagePromise = new Promise<UsageFromStream>((resolve) => {
    resolveUsage = resolve;
  });

  const translator = new ChatToResponsesStreamTranslator({ requestEcho, model });
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  void pumpTranslatingStream(
    response.body as ReadableStream<Uint8Array>,
    writable,
    translator,
    usage,
    resolveUsage,
    requestSignal,
    timing
  );

  // 上游是 chat 的响应头，但客户端拿到的是 Responses 事件流：只保留传输层语义的头。
  const headers = new Headers();
  headers.set('Content-Type', 'text/event-stream; charset=utf-8');
  headers.set('Cache-Control', 'no-cache');
  headers.set('Connection', 'keep-alive');

  return {
    response: new Response(readable, { status: response.status, headers }),
    usagePromise,
  };
}

/** 非流式：整个 chat body → Responses 对象。 */
async function nonStreamTranslated(
  response: Response,
  requestEcho: Record<string, unknown>,
  timing?: RequestTimingCollector | null
): Promise<{ response: Response; usagePromise: Promise<UsageFromStream> }> {
  const text = await response.text();
  timing?.markFirstByte();
  let usage: UsageFromStream = { ...EMPTY_USAGE_LOCAL };
  let bodyOut = text;
  try {
    const parsed = JSON.parse(text) as unknown;
    const translated = translateChatCompletionToResponses(parsed, requestEcho);
    bodyOut = JSON.stringify(translated.response);
    usage = { ...translated.usage, cancelled: false };
  } catch {
    // 解析失败：原样回传上游内容，usage 保持零（路由层记 incomplete）
  }
  timing?.markStreamComplete();
  return {
    response: new Response(bodyOut, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    }),
    usagePromise: Promise.resolve(usage),
  };
}

/**
 * 客户端可见的回显字段。刻意**不含 `input`** —— 那是完整对话历史，回显会让响应体膨胀数倍。
 */
function buildRequestEcho(body: Record<string, unknown>): Record<string, unknown> {
  const echo: Record<string, unknown> = {};
  for (const key of [
    'model',
    'instructions',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'temperature',
    'top_p',
    'max_output_tokens',
    'metadata',
    'reasoning',
    'truncation',
    'user',
  ]) {
    if (body[key] !== undefined) echo[key] = body[key];
  }
  return echo;
}

/**
 * 出站：把 Responses 请求翻译成 Chat Completions 打给上游，再把响应翻译回 Responses。
 *
 * 与 phase 1 直通驱动同签名，故 `proxyResponses` 可按 provider 能力二选一。
 */
export async function dispatchResponsesViaChatRoute(
  route: RouteResult,
  body: Record<string, unknown>,
  clientIdentity: Record<string, string> | undefined,
  requestSignal?: AbortSignal,
  timing?: RequestTimingCollector | null,
  attempt?: RequestTimingAttempt
): Promise<{
  response: Response;
  usagePromise: Promise<UsageFromStream>;
  upstreamRequestId: string | null;
}> {
  const translated = translateResponsesRequestToChat(body);
  if (!translated.ok) {
    // 400 而非抛错：抛错会被 failover 当作 fetch 失败，遍历该 provider 的每把 key 后回笼统 502。
    console.warn('[Gateway Responses:translate] request cannot be translated', {
      providerId: route.providerId,
      param: translated.error.param,
    });
    return {
      response: new Response(
        JSON.stringify({
          error: {
            message: translated.error.message,
            type: 'invalid_request_error',
            param: translated.error.param,
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      ),
      usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
      upstreamRequestId: null,
    };
  }

  if (translated.droppedReasoningItems > 0 || translated.droppedFields.length > 0) {
    // 只记数量与字段名，绝不记内容（reasoning 携带 encrypted_content）
    console.log(
      `[Gateway Responses:translate] lossy translation providerId=${route.providerId} droppedReasoningItems=${translated.droppedReasoningItems} droppedFields=${translated.droppedFields.join(',') || 'none'}`
    );
  }

  // 打的是 `chat` 能力：这正是该 provider 声明了的那个
  const url = resolveUpstreamEndpoint('openai', 'chat', route.providerEndpoints, {
    providerId: route.providerId,
  });
  // 与 phase 1 同序：route custom_params 先合并，再由 providerModelName 覆盖 model
  const requestBody = {
    ...buildRouteRequestBody(route, translated.chatBody),
    model: route.providerModelName,
  };
  const streaming = translated.chatBody.stream === true;

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

  // 非 2xx：原样返回，让路由层的 materializeNonOkResponse 与 403 分类器看到真实响应体
  if (!response.ok || !response.body) {
    return {
      response,
      usagePromise: Promise.resolve({ ...EMPTY_USAGE_LOCAL }),
      upstreamRequestId,
    };
  }

  const requestEcho = buildRequestEcho(body);
  const contentType = response.headers.get('Content-Type') ?? '';
  if (!streaming || contentType.includes('application/json')) {
    const result = await nonStreamTranslated(response, requestEcho, timing);
    return { ...result, upstreamRequestId };
  }

  const model = typeof body.model === 'string' ? body.model : route.providerModelName;
  const result = streamTranslated(response, requestEcho, model, requestSignal, timing);
  return { ...result, upstreamRequestId };
}
