/**
 * `openai-responses-chat-driver` 的**接缝**单测：不是再测一遍三个纯翻译器，而是测
 * 「驱动 → 翻译器 → 客户端字节」这条组合链。
 *
 * 为什么值得单独测：phase 1 唯一逃到线上的 bug 就出在接缝上 —— `data:` 前缀被剥两次，
 * 两个函数各自单测都是绿的，组合起来 usage 恒为 0。这里断言的是客户端**真正收到的字节**，
 * 以及真正发给上游的请求体。
 *
 * `fetch` 用桩替换（driver 直接调全局 fetch），因此无需任何上游。
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { dispatchResponsesViaChatRoute } from './openai-responses-chat-driver';
import type { RouteResult } from '../model-router';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 只填驱动实际会读的字段。 */
function makeRoute(overrides: Partial<RouteResult> = {}): RouteResult {
  return {
    providerId: 'prov-chat-only',
    providerName: 'Chat Only Relay',
    providerModelName: 'gpt-4o-mini',
    upstreamProtocol: 'openai',
    providerEndpoints: { openai: { base: 'https://relay.example.com/v1' } },
    providerApiKey: 'sk-upstream',
    providerCustomHeaders: null,
    customParams: null,
    routeGroup: 'default',
    priceOverrideRaw: null,
    routeMeteredProfileJson: null,
    routeChargedProfileJson: null,
    providerKeyId: 'pk-1',
    providerKeyLabel: 'k1',
    providerKeyFingerprint: 'fp',
    ...overrides,
  } as RouteResult;
}

type Captured = { url: string; init: RequestInit; body: Record<string, unknown> };

/** 装一个返回固定 SSE 文本的 fetch 桩，并捕获出站请求。 */
function stubFetchSse(chunks: string[], captured: Captured[]): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof globalThis.fetch;
}

function stubFetchJson(body: unknown, captured: Captured[]): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

/** 读出客户端真正会收到的完整文本。 */
async function readAll(response: Response): Promise<string> {
  return await response.text();
}

/** 从客户端字节里解析出事件序列（模拟 Codex 的读法）。 */
function parseClientEvents(text: string): Array<{ type: string; data: Record<string, unknown> }> {
  const out: Array<{ type: string; data: Record<string, unknown> }> = [];
  for (const frame of text.split('\n\n')) {
    if (frame.trim() === '') continue;
    let type: string | null = null;
    let dataLine: string | null = null;
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) type = line.slice(7).trim();
      if (line.startsWith('data: ')) dataLine = line.slice(6);
    }
    if (type && dataLine) {
      out.push({ type, data: JSON.parse(dataLine) as Record<string, unknown> });
    }
  }
  return out;
}

describe('dispatchResponsesViaChatRoute — outbound request', () => {
  it('posts the translated body to the provider chat endpoint', async () => {
    const captured: Captured[] = [];
    stubFetchSse(['data: [DONE]\n\n'], captured);

    await dispatchResponsesViaChatRoute(
      makeRoute(),
      {
        model: 'gpt-5.6-sol',
        instructions: 'You are Codex.',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        stream: true,
      },
      undefined
    );

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.url, 'https://relay.example.com/v1/chat/completions');
    // 打的是 chat 能力，而不是 /responses
    assert.ok(!captured[0]!.url.includes('/responses'));
    assert.deepEqual(captured[0]!.body.messages, [
      { role: 'system', content: 'You are Codex.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('overrides model with providerModelName, like the passthrough driver', async () => {
    const captured: Captured[] = [];
    stubFetchSse(['data: [DONE]\n\n'], captured);

    await dispatchResponsesViaChatRoute(
      makeRoute({ providerModelName: 'upstream-model-id' }),
      { model: 'gateway-facing-id', input: 'hi', stream: true },
      undefined
    );

    assert.equal(captured[0]!.body.model, 'upstream-model-id');
  });

  it('applies route custom_params but lets the request win', async () => {
    const captured: Captured[] = [];
    stubFetchSse(['data: [DONE]\n\n'], captured);

    await dispatchResponsesViaChatRoute(
      makeRoute({ customParams: { temperature: 0.1, top_p: 0.5 } } as Partial<RouteResult>),
      { model: 'm', input: 'hi', temperature: 0.9, stream: true },
      undefined
    );

    assert.equal(captured[0]!.body.temperature, 0.9, 'request overrides route default');
    assert.equal(captured[0]!.body.top_p, 0.5, 'route default applies when request omits it');
  });

  it('asks for usage in the stream — otherwise billing would be zero', async () => {
    const captured: Captured[] = [];
    stubFetchSse(['data: [DONE]\n\n'], captured);

    await dispatchResponsesViaChatRoute(
      makeRoute(),
      { model: 'm', input: 'hi', stream: true },
      undefined
    );

    assert.deepEqual(captured[0]!.body.stream_options, { include_usage: true });
  });

  it('forwards caller identity headers to the upstream', async () => {
    const captured: Captured[] = [];
    stubFetchSse(['data: [DONE]\n\n'], captured);

    await dispatchResponsesViaChatRoute(
      makeRoute(),
      { model: 'm', input: 'hi', stream: true },
      { 'user-agent': 'codex_cli_rs/0.144.6', originator: 'codex_cli_rs' }
    );

    const headers = new Headers(captured[0]!.init.headers as HeadersInit);
    assert.equal(headers.get('user-agent'), 'codex_cli_rs/0.144.6');
    assert.equal(headers.get('originator'), 'codex_cli_rs');
    assert.equal(headers.get('authorization'), 'Bearer sk-upstream');
  });

  it('does not pass the abort signal to fetch (the drain needs the upstream readable)', async () => {
    const captured: Captured[] = [];
    stubFetchSse(['data: [DONE]\n\n'], captured);
    const controller = new AbortController();

    await dispatchResponsesViaChatRoute(
      makeRoute(),
      { model: 'm', input: 'hi', stream: true },
      undefined,
      controller.signal
    );

    assert.equal(captured[0]!.init.signal, undefined);
  });
});

describe('dispatchResponsesViaChatRoute — streaming seam', () => {
  const textTurn = [
    'data: {"id":"chatcmpl-1","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
    'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
    'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n',
    'data: [DONE]\n\n',
  ];

  it('emits a complete Responses event sequence in the client bytes', async () => {
    stubFetchSse(textTurn, []);
    const result = await dispatchResponsesViaChatRoute(
      makeRoute(),
      { model: 'gpt-5.6-sol', input: 'hi', stream: true },
      undefined
    );

    const events = parseClientEvents(await readAll(result.response));
    assert.deepEqual(
      events.map((e) => e.type),
      [
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
      ]
    );
  });

  it('serves the client an event-stream content type, not the chat one', async () => {
    stubFetchSse(textTurn, []);
    const result = await dispatchResponsesViaChatRoute(
      makeRoute(),
      { model: 'm', input: 'hi', stream: true },
      undefined
    );
    assert.match(result.response.headers.get('content-type') ?? '', /text\/event-stream/);
  });

  it('resolves usage from the stream — the phase 1 seam bug class', async () => {
    stubFetchSse(textTurn, []);
    const result = await dispatchResponsesViaChatRoute(
      makeRoute(),
      { model: 'm', input: 'hi', stream: true },
      undefined
    );
    await readAll(result.response);
    const usage = await result.usagePromise;

    assert.equal(usage.input_tokens, 11);
    assert.equal(usage.output_tokens, 2);
    assert.equal(usage.total_tokens, 13);
    assert.notEqual(usage.total_tokens, 0, 'zero here is the exact phase 1 regression');
  });

  it('reports the chat id as the upstream message id, not the synthesised resp id', async () => {
    stubFetchSse(textTurn, []);
    const result = await dispatchResponsesViaChatRoute(
      makeRoute(),
      { model: 'm', input: 'hi', stream: true },
      undefined
    );
    await readAll(result.response);
    const usage = await result.usagePromise;

    assert.equal(usage.upstreamMessageId, 'chatcmpl-1');
  });

  it('reassembles events split across arbitrary chunk boundaries', async () => {
    // 把整段 SSE 按 7 字节切碎：真实网络里工具调用参数常在行中间断开
    const whole = textTurn.join('');
    const chunks: string[] = [];
    for (let i = 0; i < whole.length; i += 7) chunks.push(whole.slice(i, i + 7));
    stubFetchSse(chunks, []);

    const result = await dispatchResponsesViaChatRoute(
      makeRoute(),
      { model: 'm', input: 'hi', stream: true },
      undefined
    );
    const text = await readAll(result.response);
    const events = parseClientEvents(text);
    const usage = await result.usagePromise;

    assert.equal(events.at(-1)?.type, 'response.completed');
    assert.equal(usage.total_tokens, 13, 'usage must survive chunk splitting');
    const deltas = events
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => e.data.delta)
      .join('');
    assert.equal(deltas, 'Hello');
  });

  it('always terminates the sequence when the upstream truncates', async () => {
    // 没有 finish_reason、没有 [DONE]：上游中途掉线
    stubFetchSse(
      ['data: {"id":"chatcmpl-x","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'],
      []
    );
    const result = await dispatchResponsesViaChatRoute(
      makeRoute(),
      { model: 'm', input: 'hi', stream: true },
      undefined
    );
    const events = parseClientEvents(await readAll(result.response));

    const last = events.at(-1);
    assert.equal(last?.type, 'response.incomplete', 'an unterminated stream hangs Codex');
    // 打开的括号必须被闭合
    assert.ok(events.some((e) => e.type === 'response.output_item.done'));
  });

  it('emits a terminal event even when the upstream body is empty', async () => {
    stubFetchSse([], []);
    const result = await dispatchResponsesViaChatRoute(
      makeRoute(),
      { model: 'm', input: 'hi', stream: true },
      undefined
    );
    const events = parseClientEvents(await readAll(result.response));

    assert.ok(events.length >= 2);
    assert.equal(events[0]!.type, 'response.created');
    assert.equal(events.at(-1)?.type, 'response.incomplete');
  });

  it('translates a tool call turn end to end', async () => {
    stubFetchSse(
      [
        'data: {"id":"chatcmpl-t","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"shell","arguments":""}}]}}]}\n\n',
        'data: {"id":"chatcmpl-t","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":"}}]}}]}\n\n',
        'data: {"id":"chatcmpl-t","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]}}]}\n\n',
        'data: {"id":"chatcmpl-t","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ],
      []
    );
    const result = await dispatchResponsesViaChatRoute(
      makeRoute(),
      { model: 'm', input: 'run ls', stream: true },
      undefined
    );
    const events = parseClientEvents(await readAll(result.response));

    const argDeltas = events
      .filter((e) => e.type === 'response.function_call_arguments.delta')
      .map((e) => e.data.delta)
      .join('');
    assert.equal(argDeltas, '{"cmd":"ls"}');

    const completed = events.at(-1)!;
    assert.equal(completed.type, 'response.completed');
    const output = (completed.data.response as { output: Array<Record<string, unknown>> }).output;
    assert.equal(output.length, 1);
    assert.equal(output[0]!.type, 'function_call');
    // call_id 必须是上游那个：Codex 下一轮会原样回传
    assert.equal(output[0]!.call_id, 'call_abc');
    assert.equal(output[0]!.name, 'shell');
  });
});

describe('dispatchResponsesViaChatRoute — non-streaming seam', () => {
  it('returns a Responses object, not the chat body', async () => {
    stubFetchJson(
      {
        id: 'chatcmpl-n',
        model: 'gpt-4o-mini',
        created: 1_700_000_000,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
      []
    );

    const result = await dispatchResponsesViaChatRoute(
      makeRoute(),
      { model: 'gpt-5.6-sol', input: 'hi' },
      undefined
    );

    const body = JSON.parse(await readAll(result.response)) as Record<string, unknown>;
    assert.equal(body.object, 'response');
    assert.equal(body.status, 'completed');
    assert.ok(String(body.id).startsWith('resp_'));
    // 不能把 chat 的形状泄漏给客户端
    assert.equal(body.choices, undefined);

    const usage = await result.usagePromise;
    assert.equal(usage.input_tokens, 5);
    assert.equal(usage.upstreamMessageId, 'chatcmpl-n');
  });

  it('does not request stream_options for a non-streaming request', async () => {
    const captured: Captured[] = [];
    stubFetchJson({ id: 'c', choices: [] }, captured);

    await dispatchResponsesViaChatRoute(makeRoute(), { model: 'm', input: 'hi' }, undefined);

    assert.equal(captured[0]!.body.stream, undefined);
    assert.equal(captured[0]!.body.stream_options, undefined);
  });
});

describe('dispatchResponsesViaChatRoute — error paths', () => {
  it('returns 400 without calling the upstream for an untranslatable request', async () => {
    const captured: Captured[] = [];
    stubFetchSse(['data: [DONE]\n\n'], captured);

    const result = await dispatchResponsesViaChatRoute(
      makeRoute(),
      { model: 'm', input: 'hi', previous_response_id: 'resp_prev' },
      undefined
    );

    assert.equal(result.response.status, 400);
    assert.equal(captured.length, 0, 'must not spend an upstream call on a doomed request');
    const body = JSON.parse(await readAll(result.response)) as {
      error: { param: string; type: string };
    };
    assert.equal(body.error.param, 'previous_response_id');
    assert.equal(body.error.type, 'invalid_request_error');
  });

  it('rejects hosted tools with a 400 naming the field', async () => {
    const captured: Captured[] = [];
    stubFetchSse(['data: [DONE]\n\n'], captured);

    const result = await dispatchResponsesViaChatRoute(
      makeRoute(),
      { model: 'm', input: 'hi', tools: [{ type: 'web_search' }] },
      undefined
    );

    assert.equal(result.response.status, 400);
    assert.equal(captured.length, 0);
    const body = JSON.parse(await readAll(result.response)) as { error: { param: string } };
    assert.equal(body.error.param, 'tools');
  });

  it('passes a non-OK upstream response through untouched', async () => {
    // 403 的响应体必须原样到达路由层：materializeNonOkResponse 与 403 分类器都依赖它
    globalThis.fetch = (async () =>
      new Response('{"error":{"code":"channel:client_restricted"}}', {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof globalThis.fetch;

    const result = await dispatchResponsesViaChatRoute(
      makeRoute(),
      { model: 'm', input: 'hi', stream: true },
      undefined
    );

    assert.equal(result.response.status, 403);
    const text = await readAll(result.response);
    assert.match(text, /client_restricted/);
    const usage = await result.usagePromise;
    assert.equal(usage.total_tokens, 0);
  });
});
