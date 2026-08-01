/**
 * Responses 请求体 → Chat Completions 请求体（纯函数，无 I/O）。
 *
 * 用于只支持 `/v1/chat/completions` 的中转站：Codex CLI 0.144.6 只会说 Responses 协议
 * （`wire_api="chat"` 已被移除），网关必须在出站侧完成协议翻译。
 *
 * Codex 是**无状态**的：每轮把完整历史放在 `input` 里重发，不用 `previous_response_id`。
 * 因此这里只需做逐轮的结构翻译，不需要服务端会话状态。
 *
 * 拒绝策略：无法在 Chat 协议里表达且会**改变语义**的请求级特性一律显式报错
 * （由驱动转成 400），而不是静默丢弃 —— 静默丢弃会产生「看起来成功但结果微妙错误」的会话。
 * 反之，纯提示类字段（`include` / `truncation` / `text.format` / `reasoning.effort`）丢弃并记日志。
 */

/** 翻译失败：调用方（驱动）应转成 400，`param` 指出具体字段。 */
export type ResponsesTranslateError = {
  message: string;
  param: string;
};

export type ResponsesTranslateResult =
  | { ok: true; chatBody: Record<string, unknown>; droppedReasoningItems: number; droppedFields: string[] }
  | { ok: false; error: ResponsesTranslateError };

type JsonObject = Record<string, unknown>;

type ChatMessage = {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

function asRecord(v: unknown): JsonObject | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JsonObject) : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * 展平 Responses 的 content 数组为 Chat 的 content。
 *
 * 单一文本片段会塌缩成裸字符串：部分中转站对 `role:"system"` 拒绝数组形式的 content。
 */
function flattenContent(content: unknown): unknown {
  if (content == null) return undefined;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;

  const parts: unknown[] = [];
  for (const raw of content) {
    const part = asRecord(raw);
    if (!part) {
      if (typeof raw === 'string') parts.push({ type: 'text', text: raw });
      continue;
    }
    const type = asString(part.type);
    // `input_text` / `output_text` / `summary_text` 都是纯文本载体
    if (type === 'input_text' || type === 'output_text' || type === 'summary_text' || type === 'text') {
      const text = asString(part.text);
      if (text != null) parts.push({ type: 'text', text });
      continue;
    }
    if (type === 'input_image') {
      const url = asString(part.image_url) ?? asString(asRecord(part.image_url)?.url);
      if (url != null) {
        const detail = asString(part.detail);
        parts.push({ type: 'image_url', image_url: detail ? { url, detail } : { url } });
      }
      continue;
    }
    // 未知 content 类型：带 text 就当文本，否则跳过（不阻断整轮对话）
    const text = asString(part.text);
    if (text != null) parts.push({ type: 'text', text });
  }

  if (parts.length === 0) return undefined;
  // 只有一个文本片段 → 塌缩为字符串
  if (parts.length === 1) {
    const only = asRecord(parts[0]);
    if (only && only.type === 'text') return only.text;
  }
  return parts;
}

/** `function_call.arguments` 上游要求是字符串；对象形式一律序列化。 */
function argumentsToString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

/** `function_call_output.output` 可能是字符串或结构体。 */
function outputToContent(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  const rec = asRecord(v);
  // 实测 Codex 会发 {type:'input_text', text:'…'} 或 {output:'…'}
  if (rec) {
    const text = asString(rec.text) ?? asString(rec.output);
    if (text != null) return text;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

/** 翻译 `tools`：Responses 是扁平的，Chat 嵌在 `function` 下。 */
function translateTools(
  tools: unknown
): { ok: true; tools: unknown[] | undefined } | { ok: false; error: ResponsesTranslateError } {
  if (tools == null) return { ok: true, tools: undefined };
  if (!Array.isArray(tools)) return { ok: true, tools: undefined };

  const out: unknown[] = [];
  for (const raw of tools) {
    const tool = asRecord(raw);
    if (!tool) continue;
    const type = asString(tool.type);
    // 托管工具在上游执行，chat-only 中转站没有地方跑它们
    if (type !== 'function' && type != null) {
      return {
        ok: false,
        error: {
          message:
            `Tool type "${type}" is not supported when translating the Responses API to ` +
            `Chat Completions. This provider has no native /v1/responses endpoint, so hosted ` +
            `tools cannot be executed. Use a provider that declares ` +
            `endpoints.openai.endpoints.responses, or remove the tool.`,
          param: 'tools',
        },
      };
    }
    // Responses: {type:'function', name, parameters, description}
    // Chat:      {type:'function', function:{name, parameters, description}}
    const nested = asRecord(tool.function);
    const name = asString(tool.name) ?? asString(nested?.name);
    if (name == null) continue;
    const fn: JsonObject = { name };
    const parameters = tool.parameters ?? nested?.parameters;
    if (parameters !== undefined) fn.parameters = parameters;
    const description = tool.description ?? nested?.description;
    if (description !== undefined) fn.description = description;
    const strict = tool.strict ?? nested?.strict;
    if (strict !== undefined) fn.strict = strict;
    out.push({ type: 'function', function: fn });
  }
  return { ok: true, tools: out.length > 0 ? out : undefined };
}

/** `tool_choice`：具名函数的嵌套层级不同，其余字符串枚举一致。 */
function translateToolChoice(v: unknown): unknown {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  const rec = asRecord(v);
  if (!rec) return undefined;
  if (asString(rec.type) === 'function') {
    const name = asString(rec.name) ?? asString(asRecord(rec.function)?.name);
    if (name != null) return { type: 'function', function: { name } };
  }
  return undefined;
}

/**
 * `input` → chat `messages`。
 *
 * 连续的 `function_call` 会被合并到**同一条** assistant 消息的 `tool_calls` 数组里：
 * Chat 协议要求并行工具调用挂在一条 assistant 消息上，拆开发会被严格的上游拒绝。
 */
function translateInput(input: unknown): { messages: ChatMessage[]; droppedReasoningItems: number } {
  const messages: ChatMessage[] = [];
  let droppedReasoningItems = 0;

  if (typeof input === 'string') {
    if (input !== '') messages.push({ role: 'user', content: input });
    return { messages, droppedReasoningItems };
  }
  if (!Array.isArray(input)) return { messages, droppedReasoningItems };

  for (const raw of input) {
    const item = asRecord(raw);
    if (!item) continue;
    const type = asString(item.type);

    // 无 type 但有 role：等价于 message
    if (type === 'message' || (type == null && item.role !== undefined)) {
      const role = asString(item.role) ?? 'user';
      const content = flattenContent(item.content);
      if (content !== undefined) messages.push({ role, content });
      continue;
    }

    if (type === 'function_call') {
      const name = asString(item.name);
      if (name == null) continue;
      const callId = asString(item.call_id) ?? asString(item.id);
      if (callId == null) continue;
      const call = {
        id: callId,
        type: 'function' as const,
        function: { name, arguments: argumentsToString(item.arguments) },
      };
      // 合并进上一条 assistant tool_calls 消息（并行调用必须同属一条消息）
      const prev = messages[messages.length - 1];
      if (prev && prev.role === 'assistant' && prev.tool_calls && prev.content === undefined) {
        prev.tool_calls.push(call);
      } else {
        messages.push({ role: 'assistant', tool_calls: [call] });
      }
      continue;
    }

    if (type === 'function_call_output') {
      const callId = asString(item.call_id) ?? asString(item.id);
      if (callId == null) continue;
      messages.push({
        role: 'tool',
        tool_call_id: callId,
        content: outputToContent(item.output),
      });
      continue;
    }

    if (type === 'reasoning') {
      // 不可翻译：`encrypted_content` 只对产出它的上游有意义，Chat 协议没有对应字段。
      // 见 design.md「Reasoning items are dropped, deliberately」——拒绝会让第二轮之后全部失败。
      droppedReasoningItems += 1;
      continue;
    }

    // 其余 item（local_shell_call / custom_tool_call / web_search_call / compaction …）：
    // 无法在 Chat 协议表达。不阻断请求，但也不伪造内容。
  }

  return { messages, droppedReasoningItems };
}

/** 丢弃但不阻断的字段（纯提示类）。 */
const DROPPABLE_FIELDS = ['include', 'truncation', 'text', 'reasoning', 'prompt_cache_key', 'safety_identifier', 'metadata', 'service_tier'] as const;

/** 直接透传的采样参数。 */
const PASSTHROUGH_FIELDS = ['temperature', 'top_p', 'parallel_tool_calls', 'seed', 'stop', 'frequency_penalty', 'presence_penalty', 'logit_bias', 'user'] as const;

/**
 * 主入口：Responses 请求体 → Chat 请求体。
 *
 * `model` 不在此处理 —— 驱动会用 `route.providerModelName` 覆盖（与 phase 1 一致）。
 */
export function translateResponsesRequestToChat(body: JsonObject): ResponsesTranslateResult {
  // ---- R9：无法表达且改变语义的请求级特性，显式拒绝 ----
  if (body.previous_response_id != null && body.previous_response_id !== '') {
    return {
      ok: false,
      error: {
        message:
          'previous_response_id is not supported for this provider: it has no native ' +
          '/v1/responses endpoint, so the gateway translates to Chat Completions, which has no ' +
          'server-side conversation state. Send the full conversation in `input` instead.',
        param: 'previous_response_id',
      },
    };
  }
  if (body.store === true) {
    return {
      ok: false,
      error: {
        message:
          'store:true is not supported for this provider: it has no native /v1/responses ' +
          'endpoint, so responses cannot be persisted upstream. Use store:false.',
        param: 'store',
      },
    };
  }

  const toolsResult = translateTools(body.tools);
  if (!toolsResult.ok) return { ok: false, error: toolsResult.error };

  // ---- 消息 ----
  const { messages, droppedReasoningItems } = translateInput(body.input);

  // `instructions` 是 Codex 的完整 agent 提示词 → 领先的 system 消息
  const instructions = asString(body.instructions);
  if (instructions != null && instructions.trim() !== '') {
    messages.unshift({ role: 'system', content: instructions });
  }

  const chatBody: JsonObject = { messages };

  if (toolsResult.tools) chatBody.tools = toolsResult.tools;
  const toolChoice = translateToolChoice(body.tool_choice);
  if (toolChoice !== undefined) chatBody.tool_choice = toolChoice;

  // `max_output_tokens` → `max_tokens`
  if (typeof body.max_output_tokens === 'number') {
    chatBody.max_tokens = body.max_output_tokens;
  } else if (typeof body.max_tokens === 'number') {
    chatBody.max_tokens = body.max_tokens;
  }

  for (const field of PASSTHROUGH_FIELDS) {
    if (body[field] !== undefined) chatBody[field] = body[field];
  }

  const streaming = body.stream === true;
  if (streaming) {
    chatBody.stream = true;
    // 关键：不带 include_usage，多数 OpenAI 兼容中转站根本不在流里发 usage，
    // 于是每个翻译请求都会以零 token 记为 incomplete（静默计费错误）。
    chatBody.stream_options = { include_usage: true };
  }

  const droppedFields: string[] = [];
  for (const field of DROPPABLE_FIELDS) {
    if (body[field] !== undefined) droppedFields.push(field);
  }

  return { ok: true, chatBody, droppedReasoningItems, droppedFields };
}
