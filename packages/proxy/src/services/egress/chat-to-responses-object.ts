/**
 * Chat Completions 响应 → Responses 响应对象（纯函数，无 I/O）。
 *
 * 两个方向的产物都在这里定型，流式转换器（`chat-to-responses-stream.ts`）必须收敛到
 * **同一个** response 对象形状 —— 先把非流式做对，流式才有可对齐的目标。
 *
 * usage 有两套形状，来源同一个：
 * - 网关内部计费用 `UsageFromStream`（经 `usageFromProvider` 的缓存口径归一）
 * - 客户端可见的 Responses 形状（`input_tokens` / `input_tokens_details` / …）
 * 刻意由同一个 `UsageFromStream` 派生，避免「计费对了但客户端看到的不对」这类分叉。
 */
import { usageFromProvider, type ProviderUsage } from './openai-driver';
import type { UsageFromStream } from '../proxy';
import { normalizeUpstreamId } from './upstream-request-id';

type JsonObject = Record<string, unknown>;

/** Responses 协议里客户端可见的 usage 形状。 */
export type ResponsesWireUsage = {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number; cache_write_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
};

function asRecord(v: unknown): JsonObject | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JsonObject) : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** 生成流内稳定的合成 id。Responses 协议要求 `resp_*` / `msg_*` / `fc_*` 前缀风格。 */
export function synthesizeId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(16).slice(2).padEnd(24, '0');
  return `${prefix}_${rand}`;
}

/** `UsageFromStream` → 客户端可见的 Responses usage 形状。 */
export function responsesWireUsageFromInternal(usage: UsageFromStream): ResponsesWireUsage {
  return {
    input_tokens: usage.input_tokens,
    input_tokens_details: {
      cached_tokens: usage.cache_read_tokens,
      cache_write_tokens: usage.cache_write_tokens,
    },
    output_tokens: usage.output_tokens,
    output_tokens_details: { reasoning_tokens: usage.reasoning_tokens },
    total_tokens: usage.total_tokens,
  };
}

/**
 * chat `finish_reason` → Responses `status`。
 *
 * `length` 是唯一需要变成非 `completed` 的情况：客户端据此知道输出被截断。
 */
export function responsesStatusFromFinishReason(finishReason: string | null | undefined): {
  status: string;
  incomplete_details?: { reason: string };
} {
  if (finishReason === 'length') {
    return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
  }
  if (finishReason === 'content_filter') {
    return { status: 'incomplete', incomplete_details: { reason: 'content_filter' } };
  }
  // stop / tool_calls / function_call / null(流被截断时由调用方另行处理) → completed
  return { status: 'completed' };
}

/** 单条 chat `tool_calls[]` → Responses `function_call` 输出项。 */
export function functionCallOutputItem(args: {
  itemId: string;
  callId: string;
  name: string;
  argumentsText: string;
}): JsonObject {
  return {
    type: 'function_call',
    id: args.itemId,
    status: 'completed',
    call_id: args.callId,
    name: args.name,
    arguments: args.argumentsText,
  };
}

/** 助手文本 → Responses `message` 输出项。 */
export function messageOutputItem(args: { itemId: string; text: string }): JsonObject {
  return {
    type: 'message',
    id: args.itemId,
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: args.text, annotations: [] }],
  };
}

/**
 * 构造 Responses response 对象骨架。流式与非流式共用，保证两条路径形状一致。
 *
 * `echo` 是原始 Responses 请求体：`model` / `instructions` / `tools` 等字段要回显给客户端
 * （SDK 会读取），但**不回显 `input`** —— 那是完整对话历史，回显会让响应体膨胀数倍。
 */
export function buildResponsesEnvelope(args: {
  responseId: string;
  createdAtSeconds: number;
  model: string;
  status: string;
  output: JsonObject[];
  usage: ResponsesWireUsage | null;
  incompleteDetails?: { reason: string };
  requestEcho?: JsonObject;
  error?: JsonObject | null;
}): JsonObject {
  const echo = args.requestEcho ?? {};
  const envelope: JsonObject = {
    id: args.responseId,
    object: 'response',
    created_at: args.createdAtSeconds,
    status: args.status,
    model: args.model,
    output: args.output,
    parallel_tool_calls: echo.parallel_tool_calls ?? true,
    tool_choice: echo.tool_choice ?? 'auto',
    tools: echo.tools ?? [],
    error: args.error ?? null,
    incomplete_details: args.incompleteDetails ?? null,
    instructions: echo.instructions ?? null,
    metadata: echo.metadata ?? {},
    temperature: echo.temperature ?? null,
    top_p: echo.top_p ?? null,
    max_output_tokens: echo.max_output_tokens ?? null,
    previous_response_id: null,
    reasoning: echo.reasoning ?? null,
    store: false,
    truncation: echo.truncation ?? 'disabled',
    usage: args.usage,
    user: echo.user ?? null,
  };
  return envelope;
}

/**
 * 非流式：整个 chat completion body → Responses response 对象 + 内部 usage。
 *
 * @param requestEcho 原始 Responses 请求体（用于回显 model/tools/instructions 等）
 */
export function translateChatCompletionToResponses(
  chatBody: unknown,
  requestEcho?: JsonObject
): { response: JsonObject; usage: UsageFromStream } {
  const body = asRecord(chatBody) ?? {};
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  const finishReason = asString(firstChoice?.finish_reason);

  const output: JsonObject[] = [];

  // 文本内容（可能与 tool_calls 同时存在）
  const content = message?.content;
  const text = typeof content === 'string' ? content : null;
  if (text != null && text !== '') {
    output.push(messageOutputItem({ itemId: synthesizeId('msg'), text }));
  }

  // 工具调用
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  for (const raw of toolCalls) {
    const call = asRecord(raw);
    if (!call) continue;
    const fn = asRecord(call.function);
    const name = asString(fn?.name);
    if (name == null) continue;
    // call_id 必须沿用上游值：Codex 下一轮会原样回传，中转站要能认出来
    const callId = asString(call.id) ?? synthesizeId('call');
    output.push(
      functionCallOutputItem({
        itemId: synthesizeId('fc'),
        callId,
        name,
        argumentsText: asString(fn?.arguments) ?? '',
      })
    );
  }

  const providerUsage = asRecord(body.usage) as ProviderUsage | null;
  const internalUsage = providerUsage ? usageFromProvider(providerUsage) : null;
  const upstreamMessageId = normalizeUpstreamId(body.id);

  const { status, incomplete_details } = responsesStatusFromFinishReason(finishReason);

  const response = buildResponsesEnvelope({
    responseId: synthesizeId('resp'),
    createdAtSeconds:
      typeof body.created === 'number' ? body.created : Math.floor(Date.now() / 1000),
    model: asString(body.model) ?? asString(requestEcho?.model) ?? '',
    status,
    output,
    usage: internalUsage ? responsesWireUsageFromInternal(internalUsage) : null,
    incompleteDetails: incomplete_details,
    requestEcho,
  });

  const usage: UsageFromStream = internalUsage
    ? { ...internalUsage, upstreamMessageId }
    : {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 0,
        raw_usage: null,
        cancelled: false,
        upstreamMessageId,
      };

  return { response, usage };
}
