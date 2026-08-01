import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildResponsesEnvelope,
  responsesStatusFromFinishReason,
  responsesWireUsageFromInternal,
  synthesizeId,
  translateChatCompletionToResponses,
} from './chat-to-responses-object';

type JsonObject = Record<string, unknown>;

function outputTypes(response: JsonObject): string[] {
  const output = response.output as JsonObject[];
  return output.map((item) => String(item.type));
}

describe('translateChatCompletionToResponses — text', () => {
  it('maps assistant content to a message output item', () => {
    const { response } = translateChatCompletionToResponses({
      id: 'chatcmpl-abc',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'gpt-4o',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' }],
    });

    assert.equal(response.object, 'response');
    assert.equal(response.status, 'completed');
    assert.equal(response.model, 'gpt-4o');
    assert.equal(response.created_at, 1_700_000_000);
    assert.deepEqual(outputTypes(response), ['message']);

    const item = (response.output as JsonObject[])[0]!;
    assert.equal(item.role, 'assistant');
    assert.equal(item.status, 'completed');
    assert.deepEqual(item.content, [{ type: 'output_text', text: 'hello there', annotations: [] }]);
    assert.match(String(item.id), /^msg_/);
  });

  it('gives the response a synthesised resp_ id, not the upstream chatcmpl id', () => {
    const { response } = translateChatCompletionToResponses({
      id: 'chatcmpl-abc',
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    });
    assert.match(String(response.id), /^resp_/);
    assert.notEqual(response.id, 'chatcmpl-abc');
  });

  it('reports the upstream chatcmpl id as the message id for request logs', () => {
    const { usage } = translateChatCompletionToResponses({
      id: 'chatcmpl-abc',
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    });
    // 计费/日志侧必须是上游可追溯的 id，而不是网关合成的 resp_*
    assert.equal(usage.upstreamMessageId, 'chatcmpl-abc');
  });

  it('omits an empty-content message item', () => {
    const { response } = translateChatCompletionToResponses({
      choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
    });
    assert.deepEqual(outputTypes(response), []);
  });

  it('tolerates a body with no choices', () => {
    const { response, usage } = translateChatCompletionToResponses({ id: 'chatcmpl-x' });
    assert.deepEqual(outputTypes(response), []);
    assert.equal(usage.total_tokens, 0);
  });
});

describe('translateChatCompletionToResponses — tool calls (R5)', () => {
  it('maps each tool_call to a function_call item preserving the upstream call id', () => {
    const { response } = translateChatCompletionToResponses({
      id: 'chatcmpl-1',
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_upstream_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });

    assert.deepEqual(outputTypes(response), ['function_call']);
    const item = (response.output as JsonObject[])[0]!;
    // call_id 必须沿用上游：Codex 下一轮原样回传，改写会导致上游不认
    assert.equal(item.call_id, 'call_upstream_1');
    assert.equal(item.name, 'shell');
    assert.equal(item.arguments, '{"cmd":"ls"}');
    assert.match(String(item.id), /^fc_/);
    // 有工具调用时 status 仍是 completed（不是 incomplete）
    assert.equal(response.status, 'completed');
  });

  it('maps parallel tool calls to one item each, in order', () => {
    const { response } = translateChatCompletionToResponses({
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              { id: 'call_a', function: { name: 'read', arguments: '{"p":"a"}' } },
              { id: 'call_b', function: { name: 'read', arguments: '{"p":"b"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });

    assert.deepEqual(outputTypes(response), ['function_call', 'function_call']);
    const output = response.output as JsonObject[];
    assert.deepEqual(
      output.map((i) => i.call_id),
      ['call_a', 'call_b']
    );
    // 每个 item 有各自的合成 id
    assert.notEqual(output[0]!.id, output[1]!.id);
  });

  it('emits both a message and a function_call when the model returns text plus a call', () => {
    const { response } = translateChatCompletionToResponses({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'let me check',
            tool_calls: [{ id: 'call_a', function: { name: 'shell', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    // 文本在前，工具调用在后
    assert.deepEqual(outputTypes(response), ['message', 'function_call']);
  });

  it('synthesises a call_id when the upstream omits one', () => {
    const { response } = translateChatCompletionToResponses({
      choices: [
        { message: { role: 'assistant', tool_calls: [{ function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' },
      ],
    });
    const item = (response.output as JsonObject[])[0]!;
    assert.match(String(item.call_id), /^call_/);
  });

  it('skips a tool_call with no function name', () => {
    const { response } = translateChatCompletionToResponses({
      choices: [
        { message: { role: 'assistant', tool_calls: [{ id: 'call_a', function: { arguments: '{}' } }] }, finish_reason: 'tool_calls' },
      ],
    });
    assert.deepEqual(outputTypes(response), []);
  });

  it('defaults missing arguments to an empty string rather than undefined', () => {
    const { response } = translateChatCompletionToResponses({
      choices: [
        { message: { role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'f' } }] }, finish_reason: 'tool_calls' },
      ],
    });
    assert.equal((response.output as JsonObject[])[0]!.arguments, '');
  });
});

describe('translateChatCompletionToResponses — usage (R6)', () => {
  it('maps chat usage into both the wire shape and the internal shape', () => {
    const { response, usage } = translateChatCompletionToResponses({
      id: 'chatcmpl-1',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        total_tokens: 1050,
        prompt_tokens_details: { cached_tokens: 800, cache_creation_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 20 },
      },
    });

    // 内部计费侧
    assert.equal(usage.input_tokens, 1000);
    assert.equal(usage.output_tokens, 50);
    assert.equal(usage.cache_read_tokens, 800);
    assert.equal(usage.reasoning_tokens, 20);
    assert.equal(usage.total_tokens, 1050);

    // 客户端可见侧，字段名不同但数值同源
    assert.deepEqual(response.usage, {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 800, cache_write_tokens: 0 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 20 },
      total_tokens: 1050,
    });
  });

  it('applies the same cache-convention normalisation the chat path uses', () => {
    // prompt < cached → 上游用「纯输入 + 缓存」口径，需归一到 input = regular + cache
    const { usage, response } = translateChatCompletionToResponses({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 3855,
        prompt_tokens_details: { cached_tokens: 3840 },
      },
    });
    assert.equal(usage.input_tokens, 3850);
    assert.equal((response.usage as JsonObject).input_tokens, 3850);
  });

  it('leaves usage null when the upstream sends none', () => {
    const { response, usage } = translateChatCompletionToResponses({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    });
    assert.equal(response.usage, null);
    assert.equal(usage.total_tokens, 0);
    assert.equal(usage.raw_usage, null);
  });

  it('keeps a raw usage snapshot for auditing', () => {
    const { usage } = translateChatCompletionToResponses({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    assert.equal(typeof usage.raw_usage, 'string');
    assert.match(String(usage.raw_usage), /prompt_tokens/);
  });
});

describe('responsesStatusFromFinishReason', () => {
  it('maps stop and tool_calls to completed', () => {
    assert.deepEqual(responsesStatusFromFinishReason('stop'), { status: 'completed' });
    assert.deepEqual(responsesStatusFromFinishReason('tool_calls'), { status: 'completed' });
  });

  it('maps length to incomplete with a reason the client can act on', () => {
    assert.deepEqual(responsesStatusFromFinishReason('length'), {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    });
  });

  it('maps content_filter to incomplete', () => {
    assert.deepEqual(responsesStatusFromFinishReason('content_filter'), {
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
    });
  });

  it('treats an absent finish_reason as completed', () => {
    assert.deepEqual(responsesStatusFromFinishReason(null), { status: 'completed' });
    assert.deepEqual(responsesStatusFromFinishReason(undefined), { status: 'completed' });
  });

  it('surfaces a truncated response as incomplete in the envelope', () => {
    const { response } = translateChatCompletionToResponses({
      choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }],
    });
    assert.equal(response.status, 'incomplete');
    assert.deepEqual(response.incomplete_details, { reason: 'max_output_tokens' });
  });
});

describe('buildResponsesEnvelope', () => {
  it('echoes request fields the SDK reads back, but never the input history', () => {
    const envelope = buildResponsesEnvelope({
      responseId: 'resp_1',
      createdAtSeconds: 1,
      model: 'm',
      status: 'completed',
      output: [],
      usage: null,
      requestEcho: {
        instructions: 'You are Codex',
        tools: [{ type: 'function', name: 'shell' }],
        temperature: 0.5,
        input: [{ type: 'message', role: 'user', content: 'secret history' }],
      },
    });

    assert.equal(envelope.instructions, 'You are Codex');
    assert.equal(envelope.temperature, 0.5);
    assert.deepEqual(envelope.tools, [{ type: 'function', name: 'shell' }]);
    // input 是完整对话历史，回显会让响应体膨胀
    assert.equal('input' in envelope, false);
  });

  it('always pins store:false and previous_response_id:null', () => {
    const envelope = buildResponsesEnvelope({
      responseId: 'resp_1',
      createdAtSeconds: 1,
      model: 'm',
      status: 'completed',
      output: [],
      usage: null,
    });
    // 翻译路径没有服务端状态，必须如实反映
    assert.equal(envelope.store, false);
    assert.equal(envelope.previous_response_id, null);
    assert.equal(envelope.error, null);
    assert.equal(envelope.incomplete_details, null);
  });

  it('defaults absent echo fields without throwing', () => {
    const envelope = buildResponsesEnvelope({
      responseId: 'resp_1',
      createdAtSeconds: 1,
      model: 'm',
      status: 'completed',
      output: [],
      usage: null,
    });
    assert.deepEqual(envelope.tools, []);
    assert.equal(envelope.tool_choice, 'auto');
    assert.equal(envelope.parallel_tool_calls, true);
    assert.deepEqual(envelope.metadata, {});
  });
});

describe('synthesizeId', () => {
  it('prefixes and does not repeat', () => {
    const a = synthesizeId('resp');
    const b = synthesizeId('resp');
    assert.match(a, /^resp_[0-9a-f]{8,}$/);
    assert.notEqual(a, b);
  });
});

describe('responsesWireUsageFromInternal', () => {
  it('is a pure reshape of the internal usage', () => {
    assert.deepEqual(
      responsesWireUsageFromInternal({
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 3,
        cache_write_tokens: 4,
        reasoning_tokens: 5,
        total_tokens: 30,
        raw_usage: null,
      }),
      {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 3, cache_write_tokens: 4 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 5 },
        total_tokens: 30,
      }
    );
  });
});
