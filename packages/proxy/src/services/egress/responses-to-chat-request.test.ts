import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { translateResponsesRequestToChat } from './responses-to-chat-request';

/** 断言成功并取出 chatBody，失败时把 error 打进断言消息便于定位。 */
function chatBodyOf(body: Record<string, unknown>): Record<string, unknown> {
  const result = translateResponsesRequestToChat(body);
  assert.equal(result.ok, true, `expected translation to succeed, got ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error('unreachable');
  return result.chatBody;
}

function messagesOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return chatBodyOf(body).messages as Array<Record<string, unknown>>;
}

describe('translateResponsesRequestToChat — input items', () => {
  it('translates a plain string input to a single user message', () => {
    assert.deepEqual(messagesOf({ input: 'say ok' }), [{ role: 'user', content: 'say ok' }]);
  });

  it('translates a message item with input_text content', () => {
    const messages = messagesOf({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    });
    // 单一文本片段塌缩为裸字符串（部分中转站拒绝数组形式）
    assert.deepEqual(messages, [{ role: 'user', content: 'hello' }]);
  });

  it('keeps multi-part content as an array and maps images', () => {
    const messages = messagesOf({
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'what is this' },
            { type: 'input_image', image_url: 'https://example.com/a.png', detail: 'low' },
          ],
        },
      ],
    });
    assert.deepEqual(messages, [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'low' } },
        ],
      },
    ]);
  });

  it('accepts input_image with a nested {url} object', () => {
    const messages = messagesOf({
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'x' },
            { type: 'input_image', image_url: { url: 'https://example.com/b.png' } },
          ],
        },
      ],
    });
    const content = messages[0]!.content as Array<Record<string, unknown>>;
    assert.deepEqual(content[1], { type: 'image_url', image_url: { url: 'https://example.com/b.png' } });
  });

  it('treats an item with a role but no type as a message', () => {
    assert.deepEqual(messagesOf({ input: [{ role: 'user', content: 'hi' }] }), [
      { role: 'user', content: 'hi' },
    ]);
  });

  it('maps an assistant output_text item back to an assistant message', () => {
    assert.deepEqual(
      messagesOf({
        input: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'prior' }] }],
      }),
      [{ role: 'assistant', content: 'prior' }]
    );
  });
});

describe('translateResponsesRequestToChat — tool round trip (R5)', () => {
  it('translates function_call to an assistant tool_calls message', () => {
    const messages = messagesOf({
      input: [
        { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'call_abc' },
      ],
    });
    assert.deepEqual(messages, [
      {
        role: 'assistant',
        tool_calls: [
          { id: 'call_abc', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
        ],
      },
    ]);
  });

  it('translates function_call_output to a tool message with the matching id', () => {
    const messages = messagesOf({
      input: [{ type: 'function_call_output', call_id: 'call_abc', output: 'file1\nfile2' }],
    });
    assert.deepEqual(messages, [
      { role: 'tool', tool_call_id: 'call_abc', content: 'file1\nfile2' },
    ]);
  });

  it('merges consecutive function_call items into ONE assistant message', () => {
    // Chat 协议要求并行工具调用挂在同一条 assistant 消息上；拆开会被严格上游拒绝。
    const messages = messagesOf({
      input: [
        { type: 'function_call', name: 'a', arguments: '{}', call_id: 'call_1' },
        { type: 'function_call', name: 'b', arguments: '{}', call_id: 'call_2' },
        { type: 'function_call', name: 'c', arguments: '{}', call_id: 'call_3' },
      ],
    });
    assert.equal(messages.length, 1);
    assert.equal((messages[0]!.tool_calls as unknown[]).length, 3);
    assert.deepEqual(
      (messages[0]!.tool_calls as Array<{ id: string }>).map((t) => t.id),
      ['call_1', 'call_2', 'call_3']
    );
  });

  it('does not merge function_calls that are separated by a tool output', () => {
    const messages = messagesOf({
      input: [
        { type: 'function_call', name: 'a', arguments: '{}', call_id: 'call_1' },
        { type: 'function_call_output', call_id: 'call_1', output: 'done' },
        { type: 'function_call', name: 'b', arguments: '{}', call_id: 'call_2' },
      ],
    });
    assert.deepEqual(
      messages.map((m) => m.role),
      ['assistant', 'tool', 'assistant']
    );
  });

  it('serialises object-shaped arguments to a string', () => {
    const messages = messagesOf({
      input: [{ type: 'function_call', name: 'shell', arguments: { cmd: 'ls' }, call_id: 'c1' }],
    });
    const call = (messages[0]!.tool_calls as Array<{ function: { arguments: unknown } }>)[0]!;
    assert.equal(call.function.arguments, '{"cmd":"ls"}');
  });

  it('extracts text from a structured function_call_output', () => {
    const messages = messagesOf({
      input: [
        { type: 'function_call_output', call_id: 'c1', output: { type: 'input_text', text: 'out' } },
      ],
    });
    assert.equal(messages[0]!.content, 'out');
  });

  it('falls back to id when call_id is absent', () => {
    const messages = messagesOf({
      input: [{ type: 'function_call', name: 'a', arguments: '{}', id: 'fc_x' }],
    });
    assert.equal((messages[0]!.tool_calls as Array<{ id: string }>)[0]!.id, 'fc_x');
  });

  it('reproduces a full multi-turn transcript in order', () => {
    const messages = messagesOf({
      instructions: 'You are Codex.',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'OPAQUE' },
        { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'call_1' },
        { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'there is a.txt' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'thanks' }] },
      ],
    });
    assert.deepEqual(
      messages.map((m) => m.role),
      ['system', 'user', 'assistant', 'tool', 'assistant', 'user']
    );
    // reasoning 被丢弃，但没有破坏相邻项的顺序
    assert.equal(messages[2]!.tool_calls !== undefined, true);
    assert.equal(messages[3]!.tool_call_id, 'call_1');
  });
});

describe('translateResponsesRequestToChat — instructions and reasoning', () => {
  it('puts instructions first as a system message', () => {
    const messages = messagesOf({ instructions: 'be terse', input: 'hi' });
    assert.deepEqual(messages, [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('ignores blank instructions', () => {
    assert.deepEqual(messagesOf({ instructions: '   ', input: 'hi' }), [
      { role: 'user', content: 'hi' },
    ]);
  });

  it('drops reasoning items and reports the count', () => {
    const result = translateResponsesRequestToChat({
      input: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'OPAQUE' },
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'reasoning', id: 'rs_2', summary: [{ type: 'summary_text', text: 's' }] },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    assert.equal(result.droppedReasoningItems, 2);
    assert.deepEqual(result.chatBody.messages, [{ role: 'user', content: 'hi' }]);
  });

  it('never leaks encrypted_content into the chat body', () => {
    const chatBody = chatBodyOf({
      input: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'SECRET_BLOB' }],
    });
    assert.equal(JSON.stringify(chatBody).includes('SECRET_BLOB'), false);
  });

  it('skips item types that cannot be expressed in chat without inventing content', () => {
    const chatBody = chatBodyOf({
      input: [
        { type: 'local_shell_call', id: 'ls_1' },
        { type: 'web_search_call', id: 'ws_1' },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    });
    assert.deepEqual(chatBody.messages, [{ role: 'user', content: 'hi' }]);
  });
});

describe('translateResponsesRequestToChat — tools and parameters', () => {
  it('nests function tools under `function`', () => {
    const chatBody = chatBodyOf({
      input: 'hi',
      tools: [
        {
          type: 'function',
          name: 'shell',
          description: 'run a command',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
        },
      ],
    });
    assert.deepEqual(chatBody.tools, [
      {
        type: 'function',
        function: {
          name: 'shell',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
          description: 'run a command',
        },
      },
    ]);
  });

  it('accepts tools already in the nested chat shape', () => {
    const chatBody = chatBodyOf({
      input: 'hi',
      tools: [{ type: 'function', function: { name: 'shell', parameters: { type: 'object' } } }],
    });
    assert.deepEqual(chatBody.tools, [
      { type: 'function', function: { name: 'shell', parameters: { type: 'object' } } },
    ]);
  });

  it('maps max_output_tokens to max_tokens', () => {
    assert.equal(chatBodyOf({ input: 'hi', max_output_tokens: 256 }).max_tokens, 256);
  });

  it('translates a named tool_choice into the nested chat shape', () => {
    assert.deepEqual(chatBodyOf({ input: 'hi', tool_choice: { type: 'function', name: 'shell' } }).tool_choice, {
      type: 'function',
      function: { name: 'shell' },
    });
  });

  it('passes through string tool_choice values', () => {
    assert.equal(chatBodyOf({ input: 'hi', tool_choice: 'auto' }).tool_choice, 'auto');
    assert.equal(chatBodyOf({ input: 'hi', tool_choice: 'required' }).tool_choice, 'required');
  });

  it('passes through sampling parameters', () => {
    const chatBody = chatBodyOf({
      input: 'hi',
      temperature: 0.5,
      top_p: 0.9,
      parallel_tool_calls: false,
    });
    assert.equal(chatBody.temperature, 0.5);
    assert.equal(chatBody.top_p, 0.9);
    assert.equal(chatBody.parallel_tool_calls, false);
  });

  it('does not forward `model` (the driver sets providerModelName)', () => {
    assert.equal('model' in chatBodyOf({ input: 'hi', model: 'gpt-5.6-sol' }), false);
  });
});

describe('translateResponsesRequestToChat — streaming and usage (R6)', () => {
  it('requests usage in the stream, otherwise billing would silently be zero', () => {
    const chatBody = chatBodyOf({ input: 'hi', stream: true });
    assert.equal(chatBody.stream, true);
    assert.deepEqual(chatBody.stream_options, { include_usage: true });
  });

  it('omits stream and stream_options for non-streaming requests', () => {
    const chatBody = chatBodyOf({ input: 'hi' });
    assert.equal('stream' in chatBody, false);
    assert.equal('stream_options' in chatBody, false);
  });

  it('does not set stream_options when stream is explicitly false', () => {
    const chatBody = chatBodyOf({ input: 'hi', stream: false });
    assert.equal('stream_options' in chatBody, false);
  });
});

describe('translateResponsesRequestToChat — explicit rejections (R9)', () => {
  it('rejects previous_response_id', () => {
    const result = translateResponsesRequestToChat({ input: 'hi', previous_response_id: 'resp_1' });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.equal(result.error.param, 'previous_response_id');
    assert.match(result.error.message, /previous_response_id/);
  });

  it('rejects store:true', () => {
    const result = translateResponsesRequestToChat({ input: 'hi', store: true });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error('unreachable');
    assert.equal(result.error.param, 'store');
  });

  it('allows store:false', () => {
    assert.equal(translateResponsesRequestToChat({ input: 'hi', store: false }).ok, true);
  });

  it('rejects hosted tool types, naming the type', () => {
    for (const type of ['web_search', 'file_search', 'computer_use', 'mcp']) {
      const result = translateResponsesRequestToChat({ input: 'hi', tools: [{ type }] });
      assert.equal(result.ok, false, `expected ${type} to be rejected`);
      if (result.ok) throw new Error('unreachable');
      assert.equal(result.error.param, 'tools');
      assert.match(result.error.message, new RegExp(type));
    }
  });

  it('rejects a hosted tool even when a function tool is also present', () => {
    const result = translateResponsesRequestToChat({
      input: 'hi',
      tools: [{ type: 'function', name: 'shell' }, { type: 'web_search' }],
    });
    assert.equal(result.ok, false);
  });

  it('reports droppable hint fields instead of rejecting them', () => {
    const result = translateResponsesRequestToChat({
      input: 'hi',
      include: ['reasoning.encrypted_content'],
      truncation: 'auto',
      reasoning: { effort: 'high' },
      text: { format: { type: 'text' } },
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('unreachable');
    for (const field of ['include', 'truncation', 'reasoning', 'text']) {
      assert.equal(result.droppedFields.includes(field), true, `${field} should be reported as dropped`);
    }
    // 丢弃的字段不得出现在 chat 体里
    for (const field of ['include', 'truncation', 'reasoning', 'text']) {
      assert.equal(field in result.chatBody, false, `${field} must not reach the upstream body`);
    }
  });
});

describe('translateResponsesRequestToChat — degenerate input', () => {
  it('handles a missing input', () => {
    assert.deepEqual(chatBodyOf({}).messages, []);
  });

  it('handles an empty input array', () => {
    assert.deepEqual(chatBodyOf({ input: [] }).messages, []);
  });

  it('ignores non-object entries in input', () => {
    assert.deepEqual(chatBodyOf({ input: [null, 42, 'loose', { type: 'message', role: 'user', content: 'hi' }] }).messages, [
      { role: 'user', content: 'hi' },
    ]);
  });

  it('skips a function_call missing its name', () => {
    assert.deepEqual(chatBodyOf({ input: [{ type: 'function_call', call_id: 'c1' }] }).messages, []);
  });

  it('skips a message whose content yields nothing', () => {
    assert.deepEqual(chatBodyOf({ input: [{ type: 'message', role: 'user', content: [] }] }).messages, []);
  });
});
