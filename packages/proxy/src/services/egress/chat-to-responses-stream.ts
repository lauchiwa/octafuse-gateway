/**
 * Chat Completions SSE → Responses SSE 事件流（有状态，但纯字符串运算、无 I/O）。
 *
 * 这是 phase 2 最容易出错的部分：两种协议的事件词汇完全不同。
 * - Chat 是 **delta 中心**：`choices[0].delta.{content,tool_calls}`，没有生命周期事件。
 * - Responses 是 **item 中心**：每个输出项都有显式括号
 *   `output_item.added` → `content_part.added` → deltas → `*.done` → `output_item.done`。
 *
 * 因此不能像 phase 1 那样字节直通，必须按行重组并**合成**这些括号。
 *
 * 失败模式很不对称：序列不完整时 Codex 会**挂住**而不是干净报错。所以：
 * - 上游没给 `finish_reason` 就断流时，仍然补齐所有未闭合的括号并发终止事件；
 * - `response.completed` 恰好发一次，且一定是最后一个。
 *
 * 事件序列对齐 phase 1 的真实抓包（design.md「What Codex actually sends and accepts」）。
 */
import { usageFromProvider, type ProviderUsage } from './openai-driver';
import type { UsageFromStream } from '../proxy';
import { normalizeUpstreamId } from './upstream-request-id';
import {
  buildResponsesEnvelope,
  functionCallOutputItem,
  messageOutputItem,
  responsesStatusFromFinishReason,
  responsesWireUsageFromInternal,
  synthesizeId,
  type ResponsesWireUsage,
} from './chat-to-responses-object';

type JsonObject = Record<string, unknown>;

function asRecord(v: unknown): JsonObject | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JsonObject) : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** 当前打开的输出项。文本项与工具调用项的闭合事件不同，故需区分。 */
type OpenItem =
  | { kind: 'message'; itemId: string; outputIndex: number; text: string }
  | {
      kind: 'function_call';
      itemId: string;
      outputIndex: number;
      callId: string;
      name: string;
      argumentsText: string;
      /** chat 侧的 tool_calls[].index，用于识别「换了一个工具调用」 */
      toolIndex: number;
    };

export type EmittedEvent = { type: string; data: JsonObject };

/**
 * Responses 流式转换器。
 *
 * 用法：对每行上游 chat SSE 调 `pushLine`，流结束时调 `finish`，两者都返回要发给客户端的事件。
 * 事件到 SSE 文本的序列化交给 {@link serializeEvent}，便于单测直接断言事件序列。
 */
export class ChatToResponsesStreamTranslator {
  private readonly responseId = synthesizeId('resp');
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private readonly requestEcho: JsonObject;
  private model: string;

  private sequenceNumber = 0;
  private nextOutputIndex = 0;
  private openItem: OpenItem | null = null;
  /** 已闭合的输出项，按顺序累积，供终止事件里的完整 response 对象使用。 */
  private readonly completedOutput: JsonObject[] = [];

  private started = false;
  private terminated = false;
  private finishReason: string | null = null;
  private upstreamMessageId: string | null = null;
  private internalUsage: UsageFromStream | null = null;
  private upstreamError: JsonObject | null = null;

  constructor(args: { requestEcho?: JsonObject; model?: string }) {
    this.requestEcho = args.requestEcho ?? {};
    this.model = args.model ?? asString(this.requestEcho.model) ?? '';
  }

  /** 内部计费用 usage（`null` 表示上游从未给出，路由层会据此记 incomplete）。 */
  get usage(): UsageFromStream | null {
    return this.internalUsage;
  }

  get upstreamMessageIdValue(): string | null {
    return this.upstreamMessageId;
  }

  private event(type: string, data: JsonObject): EmittedEvent {
    this.sequenceNumber += 1;
    return { type, data: { ...data, type, sequence_number: this.sequenceNumber } };
  }

  /** 首个事件对：`response.created` + `response.in_progress`（抓包里两者都有）。 */
  private start(): EmittedEvent[] {
    if (this.started) return [];
    this.started = true;
    const envelope = this.envelope('in_progress', null);
    return [
      this.event('response.created', { response: envelope }),
      this.event('response.in_progress', { response: envelope }),
    ];
  }

  private envelope(status: string, usage: ResponsesWireUsage | null, incompleteReason?: string): JsonObject {
    return buildResponsesEnvelope({
      responseId: this.responseId,
      createdAtSeconds: this.createdAt,
      model: this.model,
      status,
      output: [...this.completedOutput],
      usage,
      incompleteDetails: incompleteReason ? { reason: incompleteReason } : undefined,
      requestEcho: this.requestEcho,
      error: this.upstreamError,
    });
  }

  /** 闭合当前打开的输出项，按协议顺序发齐 `.done` 括号。 */
  private closeOpenItem(): EmittedEvent[] {
    const item = this.openItem;
    if (!item) return [];
    this.openItem = null;
    const out: EmittedEvent[] = [];

    if (item.kind === 'message') {
      out.push(
        this.event('response.output_text.done', {
          item_id: item.itemId,
          output_index: item.outputIndex,
          content_index: 0,
          text: item.text,
        })
      );
      out.push(
        this.event('response.content_part.done', {
          item_id: item.itemId,
          output_index: item.outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: item.text, annotations: [] },
        })
      );
      const finalItem = messageOutputItem({ itemId: item.itemId, text: item.text });
      this.completedOutput.push(finalItem);
      out.push(
        this.event('response.output_item.done', {
          output_index: item.outputIndex,
          item: finalItem,
        })
      );
      return out;
    }

    out.push(
      this.event('response.function_call_arguments.done', {
        item_id: item.itemId,
        output_index: item.outputIndex,
        arguments: item.argumentsText,
      })
    );
    const finalItem = functionCallOutputItem({
      itemId: item.itemId,
      callId: item.callId,
      name: item.name,
      argumentsText: item.argumentsText,
    });
    this.completedOutput.push(finalItem);
    out.push(
      this.event('response.output_item.done', {
        output_index: item.outputIndex,
        item: finalItem,
      })
    );
    return out;
  }

  /** 打开一个文本项（首个 content delta 时惰性触发）。 */
  private openMessageItem(): EmittedEvent[] {
    const itemId = synthesizeId('msg');
    const outputIndex = this.nextOutputIndex++;
    this.openItem = { kind: 'message', itemId, outputIndex, text: '' };
    return [
      this.event('response.output_item.added', {
        output_index: outputIndex,
        item: { type: 'message', id: itemId, status: 'in_progress', role: 'assistant', content: [] },
      }),
      this.event('response.content_part.added', {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }),
    ];
  }

  private openFunctionCallItem(args: {
    callId: string;
    name: string;
    toolIndex: number;
  }): EmittedEvent[] {
    const itemId = synthesizeId('fc');
    const outputIndex = this.nextOutputIndex++;
    this.openItem = {
      kind: 'function_call',
      itemId,
      outputIndex,
      callId: args.callId,
      name: args.name,
      argumentsText: '',
      toolIndex: args.toolIndex,
    };
    return [
      this.event('response.output_item.added', {
        output_index: outputIndex,
        item: {
          type: 'function_call',
          id: itemId,
          status: 'in_progress',
          call_id: args.callId,
          name: args.name,
          arguments: '',
        },
      }),
    ];
  }

  /**
   * 处理一行上游 chat SSE。
   *
   * 只认 `data:` 行；`[DONE]` 不在此处终止（终止统一走 {@link finish}，保证无论上游是否
   * 规范发送 `[DONE]` 都只有一条终止路径）。
   */
  pushLine(line: string): EmittedEvent[] {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return [];
    const payload = trimmed.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      return [];
    }
    const obj = asRecord(parsed);
    if (!obj) return [];

    const out: EmittedEvent[] = [];
    out.push(...this.start());

    // 上游在流中报错（部分中转站会发 {"error": {...}} 而非 HTTP 错误码）
    const errorObj = asRecord(obj.error);
    if (errorObj) {
      this.upstreamError = errorObj;
      return out;
    }

    const id = normalizeUpstreamId(obj.id);
    if (id != null) this.upstreamMessageId = id;
    const model = asString(obj.model);
    if (model != null && model !== '') this.model = model;

    // usage 可能单独出现在最后一个 chunk（stream_options.include_usage）
    const usageObj = asRecord(obj.usage);
    if (usageObj) {
      const mapped = usageFromProvider(usageObj as ProviderUsage);
      this.internalUsage = { ...mapped, upstreamMessageId: this.upstreamMessageId };
    }

    const choices = Array.isArray(obj.choices) ? obj.choices : [];
    const choice = asRecord(choices[0]);
    if (!choice) return out;

    const finish = asString(choice.finish_reason);
    if (finish != null) this.finishReason = finish;

    const delta = asRecord(choice.delta);
    if (!delta) return out;

    // ---- 文本增量 ----
    const content = delta.content;
    if (typeof content === 'string' && content !== '') {
      // 从工具调用切回文本（或首次出现文本）：先闭合旧项
      if (this.openItem && this.openItem.kind !== 'message') {
        out.push(...this.closeOpenItem());
      }
      if (!this.openItem) {
        out.push(...this.openMessageItem());
      }
      const item = this.openItem;
      if (item && item.kind === 'message') {
        item.text += content;
        out.push(
          this.event('response.output_text.delta', {
            item_id: item.itemId,
            output_index: item.outputIndex,
            content_index: 0,
            delta: content,
          })
        );
      }
    }

    // ---- 工具调用增量 ----
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const rawCall of toolCalls) {
      const call = asRecord(rawCall);
      if (!call) continue;
      const toolIndex = typeof call.index === 'number' ? call.index : 0;
      const fn = asRecord(call.function);
      const name = asString(fn?.name);
      const argsFragment = asString(fn?.arguments);

      const current = this.openItem;
      const sameCall =
        current != null && current.kind === 'function_call' && current.toolIndex === toolIndex;

      if (!sameCall) {
        // 换项：闭合旧的（文本或上一个工具调用），再开新的
        if (current) out.push(...this.closeOpenItem());
        // call_id 必须沿用上游：Codex 下一轮原样回传，中转站要认得
        const callId = asString(call.id) ?? synthesizeId('call');
        out.push(
          ...this.openFunctionCallItem({ callId, name: name ?? '', toolIndex })
        );
      } else if (name != null && name !== '' && current.kind === 'function_call' && current.name === '') {
        // 名称可能在后续 chunk 才补全
        current.name = name;
      }

      if (argsFragment != null && argsFragment !== '') {
        const item = this.openItem;
        if (item && item.kind === 'function_call') {
          item.argumentsText += argsFragment;
          out.push(
            this.event('response.function_call_arguments.delta', {
              item_id: item.itemId,
              output_index: item.outputIndex,
              delta: argsFragment,
            })
          );
        }
      }
    }

    return out;
  }

  /**
   * 终止流。**必须**被调用，包括上游异常断开的情况 —— 未闭合的序列会让 Codex 挂住。
   *
   * @param reason `'upstream_ended'` 表示上游正常/异常结束；调用方无需区分，
   *   状态由是否收到 `finish_reason` 与 usage 决定。
   */
  finish(): EmittedEvent[] {
    if (this.terminated) return [];
    this.terminated = true;
    const out: EmittedEvent[] = [];
    // 上游一个 chunk 都没发就断了：仍要发 created，否则客户端等不到任何事件
    out.push(...this.start());
    out.push(...this.closeOpenItem());

    const wireUsage = this.internalUsage
      ? responsesWireUsageFromInternal(this.internalUsage)
      : null;

    if (this.upstreamError) {
      out.push(
        this.event('response.failed', {
          response: this.envelope('failed', wireUsage),
        })
      );
      return out;
    }

    if (this.finishReason == null) {
      // 上游截断（中转站掉线等）：显式标 incomplete，让错误可见而不是伪装成成功
      out.push(
        this.event('response.incomplete', {
          response: this.envelope('incomplete', wireUsage, 'upstream_ended_without_finish_reason'),
        })
      );
      return out;
    }

    const { status, incomplete_details } = responsesStatusFromFinishReason(this.finishReason);
    if (status === 'incomplete') {
      out.push(
        this.event('response.incomplete', {
          response: this.envelope('incomplete', wireUsage, incomplete_details?.reason),
        })
      );
      return out;
    }

    out.push(
      this.event('response.completed', {
        response: this.envelope('completed', wireUsage),
      })
    );
    return out;
  }
}

/** 事件 → SSE 文本帧。Responses 用具名事件（`event:` + `data:`）。 */
export function serializeEvent(event: EmittedEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
