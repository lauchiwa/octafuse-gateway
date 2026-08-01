import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ChatToResponsesStreamTranslator,
  serializeEvent,
  type EmittedEvent,
} from './chat-to-responses-stream';

/**
 * 断言的是**结构不变量**而不是黄金字符串：黄金串会在「顺序被打乱但字符仍然全对」时通过，
 * 而顺序错了 Codex 就会挂住 —— 那正是这里要防的失效模式。
 */

/** 把若干行 chat SSE 喂进转换器，返回全部事件（含终止事件）。 */
function run(lines: string[], echo?: Record<string, unknown>): EmittedEvent[] {
  const t = new ChatToResponsesStreamTranslator({ requestEcho: echo, model: 'gpt-4o' });
  const events: EmittedEvent[] = [];
  for (const line of lines) events.push(...t.pushLine(line));
  events.push(...t.finish());
  return events;
}

function types(events: EmittedEvent[]): string[] {
  return events.map((e) => e.type);
}

function data(event: EmittedEvent): Record<string, unknown> {
  return event.data;
}

function chunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}`;
}

const textChunk = (content: string): string =>
  chunk({ id: 'chatcmpl-x', model: 'gpt-4o', choices: [{ index: 0, delta: { content } }] });

const finishChunk = (reason: string): string =>
  chunk({ id: 'chatcmpl-x', choices: [{ index: 0, delta: {}, finish_reason: reason }] });

const usageChunk = (usage: unknown): string => chunk({ id: 'chatcmpl-x', choices: [], usage });

/** 每个 output_item.added 都必须有配对的 output_item.done。 */
function assertBracketsBalanced(events: EmittedEvent[]): void {
  const added = events.filter((e) => e.type === 'response.output_item.added');
  const done = events.filter((e) => e.type === 'response.output_item.done');
  assert.equal(
    added.length,
    done.length,
    `unbalanced output items: ${added.length} added vs ${done.length} done`
  );
  for (const a of added) {
    const idx = data(a).output_index;
    assert.ok(
      done.some((d) => data(d).output_index === idx),
      `output_index ${String(idx)} was opened but never closed`
    );
  }
}

/** sequence_number 必须从 1 开始严格递增，不重复不跳号。 */
function assertSequenceNumbers(events: EmittedEvent[]): void {
  const seqs = events.map((e) => data(e).sequence_number);
  assert.deepEqual(
    seqs,
    events.map((_, i) => i + 1),
    'sequence_number must increment by 1 across every emitted event'
  );
}

/** 终止事件恰好一个，且是最后一个。 */
function assertSingleTerminalLast(events: EmittedEvent[]): void {
  const terminalTypes = new Set([
    'response.completed',
    'response.incomplete',
    'response.failed',
  ]);
  const terminals = events.filter((e) => terminalTypes.has(e.type));
  assert.equal(terminals.length, 1, `expected exactly 1 terminal event, got ${terminals.length}`);
  assert.equal(
    events[events.length - 1]!.type,
    terminals[0]!.type,
    'the terminal event must be the last event'
  );
}

function assertAllInvariants(events: EmittedEvent[]): void {
  assertSequenceNumbers(events);
  assertBracketsBalanced(events);
  assertSingleTerminalLast(events);
}

describe('ChatToResponsesStreamTranslator — text turn', () => {
  it('reproduces the event sequence captured from a native upstream', () => {
    const events = run([textChunk('Hel'), textChunk('lo'), finishChunk('stop')]);
    assert.deepEqual(types(events), [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    assertAllInvariants(events);
  });

  it('accumulates the full text on the done and completed events', () => {
    const events = run([textChunk('Hel'), textChunk('lo'), finishChunk('stop')]);
    const textDone = events.find((e) => e.type === 'response.output_text.done')!;
    assert.equal(data(textDone).text, 'Hello');

    const completed = events.find((e) => e.type === 'response.completed')!;
    const response = data(completed).response as Record<string, unknown>;
    const output = response.output as Array<Record<string, unknown>>;
    assert.equal(output.length, 1);
    assert.equal(output[0]!.type, 'message');
    const content = output[0]!.content as Array<Record<string, unknown>>;
    assert.equal(content[0]!.text, 'Hello');
  });

  it('forwards each delta verbatim without re-chunking', () => {
    const events = run([textChunk('a'), textChunk('bc'), textChunk('d'), finishChunk('stop')]);
    const deltas = events
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => data(e).delta);
    assert.deepEqual(deltas, ['a', 'bc', 'd']);
  });

  it('emits created before any delta, because Codex waits for it', () => {
    const events = run([textChunk('hi'), finishChunk('stop')]);
    assert.equal(events[0]!.type, 'response.created');
    const firstDelta = types(events).indexOf('response.output_text.delta');
    assert.ok(types(events).indexOf('response.created') < firstDelta);
  });

  it('ignores empty content deltas rather than opening an empty item', () => {
    const events = run([textChunk(''), finishChunk('stop')]);
    assert.deepEqual(types(events), [
      'response.created',
      'response.in_progress',
      'response.completed',
    ]);
    assertAllInvariants(events);
  });
});

describe('ChatToResponsesStreamTranslator — tool calls (R5)', () => {
  const toolCallStart = chunk({
    id: 'chatcmpl-x',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '' } },
          ],
        },
      },
    ],
  });
  const toolArgs = (fragment: string, index = 0): string =>
    chunk({
      id: 'chatcmpl-x',
      choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: fragment } }] } }],
    });

  it('emits a function_call item with argument deltas', () => {
    const events = run([toolCallStart, toolArgs('{"ci'), toolArgs('ty":"SF"}'), finishChunk('tool_calls')]);
    assert.deepEqual(types(events), [
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
    assertAllInvariants(events);
  });

  it('preserves the upstream call_id so Codex can echo it back next turn', () => {
    const events = run([toolCallStart, toolArgs('{}'), finishChunk('tool_calls')]);
    const itemDone = events.find((e) => e.type === 'response.output_item.done')!;
    const item = data(itemDone).item as Record<string, unknown>;
    assert.equal(item.call_id, 'call_abc');
    assert.equal(item.name, 'get_weather');
    assert.equal(item.arguments, '{}');
  });

  it('accumulates split argument fragments into one JSON string', () => {
    const events = run([toolCallStart, toolArgs('{"a"'), toolArgs(':1}'), finishChunk('tool_calls')]);
    const argsDone = events.find((e) => e.type === 'response.function_call_arguments.done')!;
    assert.equal(data(argsDone).arguments, '{"a":1}');
  });

  it('gives each parallel tool call its own output item and index', () => {
    const parallel = chunk({
      id: 'chatcmpl-x',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', function: { name: 'a', arguments: '{}' } },
            ],
          },
        },
      ],
    });
    const second = chunk({
      id: 'chatcmpl-x',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 1, id: 'call_2', function: { name: 'b', arguments: '{}' } },
            ],
          },
        },
      ],
    });
    const events = run([parallel, second, finishChunk('tool_calls')]);
    assertAllInvariants(events);
    const items = events
      .filter((e) => e.type === 'response.output_item.done')
      .map((e) => data(e).item as Record<string, unknown>);
    assert.equal(items.length, 2);
    assert.deepEqual(
      items.map((i) => i.call_id),
      ['call_1', 'call_2']
    );
    const indices = events
      .filter((e) => e.type === 'response.output_item.added')
      .map((e) => data(e).output_index);
    assert.deepEqual(indices, [0, 1]);
  });

  it('closes the text item before opening a tool call', () => {
    const events = run([textChunk('let me check'), toolCallStart, toolArgs('{}'), finishChunk('tool_calls')]);
    const seq = types(events);
    // 文本项必须在工具项打开之前完全闭合
    const textItemDone = seq.indexOf('response.output_item.done');
    const secondAdded = seq.indexOf('response.output_item.added', seq.indexOf('response.output_item.added') + 1);
    assert.ok(textItemDone < secondAdded, `text item must close before the tool item opens: ${seq.join(' ')}`);
    assert.ok(seq.indexOf('response.content_part.done') < textItemDone);
    assertAllInvariants(events);
  });

  it('picks up a tool name that arrives in a later chunk', () => {
    const noName = chunk({
      id: 'chatcmpl-x',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_z', function: { arguments: '' } }] } }],
    });
    const withName = chunk({
      id: 'chatcmpl-x',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'later', arguments: '{}' } }] } }],
    });
    const events = run([noName, withName, finishChunk('tool_calls')]);
    const itemDone = events.find((e) => e.type === 'response.output_item.done')!;
    assert.equal((data(itemDone).item as Record<string, unknown>).name, 'later');
  });

  it('synthesises a call_id when the upstream omits one', () => {
    const noId = chunk({
      id: 'chatcmpl-x',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'x', arguments: '{}' } }] } }],
    });
    const events = run([noId, finishChunk('tool_calls')]);
    const itemDone = events.find((e) => e.type === 'response.output_item.done')!;
    const callId = (data(itemDone).item as Record<string, unknown>).call_id;
    assert.match(String(callId), /^call_/);
  });
});

describe('ChatToResponsesStreamTranslator — usage and billing (R6)', () => {
  it('reads usage from a trailing usage-only chunk', () => {
    const t = new ChatToResponsesStreamTranslator({ model: 'gpt-4o' });
    const events: EmittedEvent[] = [];
    for (const line of [
      textChunk('hi'),
      finishChunk('stop'),
      usageChunk({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }),
    ]) {
      events.push(...t.pushLine(line));
    }
    events.push(...t.finish());

    assert.equal(t.usage?.input_tokens, 10);
    assert.equal(t.usage?.output_tokens, 3);
    assert.equal(t.usage?.total_tokens, 13);

    const completed = events.find((e) => e.type === 'response.completed')!;
    const response = data(completed).response as Record<string, unknown>;
    const usage = response.usage as Record<string, unknown>;
    assert.equal(usage.input_tokens, 10);
    assert.equal(usage.output_tokens, 3);
    assert.equal(usage.total_tokens, 13);
  });

  it('maps cache and reasoning details into the wire usage', () => {
    const t = new ChatToResponsesStreamTranslator({ model: 'gpt-4o' });
    t.pushLine(textChunk('x'));
    t.pushLine(finishChunk('stop'));
    t.pushLine(
      usageChunk({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 60, cache_creation_tokens: 5 },
        completion_tokens_details: { reasoning_tokens: 8 },
      })
    );
    const events = t.finish();
    const completed = events.find((e) => e.type === 'response.completed')!;
    const usage = (data(completed).response as Record<string, unknown>).usage as Record<
      string,
      unknown
    >;
    assert.deepEqual(usage.input_tokens_details, { cached_tokens: 60, cache_write_tokens: 5 });
    assert.deepEqual(usage.output_tokens_details, { reasoning_tokens: 8 });
    assert.equal(t.usage?.cache_read_tokens, 60);
    assert.equal(t.usage?.reasoning_tokens, 8);
  });

  it('leaves usage null and completed.usage null when the upstream never sends it', () => {
    const events = run([textChunk('hi'), finishChunk('stop')]);
    const completed = events.find((e) => e.type === 'response.completed')!;
    assert.equal((data(completed).response as Record<string, unknown>).usage, null);
  });

  it('captures the chat id as the upstream message id, not the synthesised resp id', () => {
    const t = new ChatToResponsesStreamTranslator({ model: 'gpt-4o' });
    t.pushLine(textChunk('hi'));
    t.pushLine(finishChunk('stop'));
    t.pushLine(usageChunk({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
    t.finish();
    assert.equal(t.upstreamMessageIdValue, 'chatcmpl-x');
    assert.equal(t.usage?.upstreamMessageId, 'chatcmpl-x');
  });
});

describe('ChatToResponsesStreamTranslator — termination safety', () => {
  it('closes open brackets and terminates when the upstream truncates mid-text', () => {
    // 没有 finish_reason，模拟中转站掉线
    const events = run([textChunk('partial')]);
    assertAllInvariants(events);
    assert.equal(events[events.length - 1]!.type, 'response.incomplete');
    const response = data(events[events.length - 1]!).response as Record<string, unknown>;
    assert.equal(response.status, 'incomplete');
    assert.deepEqual(response.incomplete_details, {
      reason: 'upstream_ended_without_finish_reason',
    });
  });

  it('closes an open tool call when the upstream truncates mid-arguments', () => {
    const open = chunk({
      id: 'chatcmpl-x',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_t', function: { name: 'f', arguments: '{"a' } }] } }],
    });
    const events = run([open]);
    assertAllInvariants(events);
    assert.equal(events[events.length - 1]!.type, 'response.incomplete');
  });

  it('still emits created and a terminal event when the upstream sends nothing at all', () => {
    const events = run([]);
    assert.deepEqual(types(events), [
      'response.created',
      'response.in_progress',
      'response.incomplete',
    ]);
    assertAllInvariants(events);
  });

  it('is idempotent: finish twice does not emit a second terminal event', () => {
    const t = new ChatToResponsesStreamTranslator({ model: 'gpt-4o' });
    t.pushLine(textChunk('hi'));
    t.pushLine(finishChunk('stop'));
    const first = t.finish();
    const second = t.finish();
    assert.equal(first.filter((e) => e.type === 'response.completed').length, 1);
    assert.deepEqual(second, []);
  });

  it('maps finish_reason=length to incomplete so truncation is visible', () => {
    const events = run([textChunk('cut'), finishChunk('length')]);
    assertAllInvariants(events);
    const terminal = events[events.length - 1]!;
    assert.equal(terminal.type, 'response.incomplete');
    const response = data(terminal).response as Record<string, unknown>;
    assert.deepEqual(response.incomplete_details, { reason: 'max_output_tokens' });
  });

  it('emits response.failed when the upstream reports an error mid-stream', () => {
    const errorLine = chunk({ error: { message: 'upstream exploded', type: 'server_error' } });
    const events = run([textChunk('partial'), errorLine]);
    assertAllInvariants(events);
    const terminal = events[events.length - 1]!;
    assert.equal(terminal.type, 'response.failed');
    const response = data(terminal).response as Record<string, unknown>;
    assert.equal(response.status, 'failed');
    assert.deepEqual(response.error, { message: 'upstream exploded', type: 'server_error' });
  });
});

describe('ChatToResponsesStreamTranslator — malformed input tolerance', () => {
  it('ignores non-data lines, comments and [DONE]', () => {
    const events = run([
      ': ping',
      'event: something',
      '',
      textChunk('hi'),
      'data: [DONE]',
      finishChunk('stop'),
    ]);
    assertAllInvariants(events);
    assert.equal(events.filter((e) => e.type === 'response.output_text.delta').length, 1);
  });

  it('ignores unparseable JSON without terminating the stream', () => {
    const events = run([textChunk('a'), 'data: {not json', textChunk('b'), finishChunk('stop')]);
    assertAllInvariants(events);
    const deltas = events
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => data(e).delta);
    assert.deepEqual(deltas, ['a', 'b']);
  });

  it('tolerates a chunk with no choices', () => {
    const events = run([chunk({ id: 'chatcmpl-x' }), textChunk('hi'), finishChunk('stop')]);
    assertAllInvariants(events);
  });

  it('picks up the model name from the upstream chunk', () => {
    const events = run([
      chunk({ id: 'c', model: 'gpt-4o-mini-2024', choices: [{ index: 0, delta: { content: 'x' } }] }),
      finishChunk('stop'),
    ]);
    const completed = events[events.length - 1]!;
    assert.equal((data(completed).response as Record<string, unknown>).model, 'gpt-4o-mini-2024');
  });
});

describe('serializeEvent', () => {
  it('emits a named SSE frame terminated by a blank line', () => {
    const frame = serializeEvent({ type: 'response.created', data: { type: 'response.created', a: 1 } });
    assert.equal(frame, 'event: response.created\ndata: {"type":"response.created","a":1}\n\n');
  });

  it('round-trips through a parser the way a client would read it', () => {
    const events = run([textChunk('hi'), finishChunk('stop')]);
    const wire = events.map(serializeEvent).join('');
    // 按客户端的方式重新解析：每帧一个 event: 行 + 一个 data: 行
    const frames = wire.split('\n\n').filter((f) => f.trim() !== '');
    assert.equal(frames.length, events.length);
    for (const [i, frame] of frames.entries()) {
      const lines = frame.split('\n');
      assert.equal(lines[0], `event: ${events[i]!.type}`);
      const parsed = JSON.parse(lines[1]!.slice('data: '.length)) as Record<string, unknown>;
      assert.equal(parsed.type, events[i]!.type);
      assert.equal(parsed.sequence_number, i + 1);
    }
  });
});
