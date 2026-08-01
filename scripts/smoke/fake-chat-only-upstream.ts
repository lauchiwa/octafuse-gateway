/**
 * 假上游：只会说 `/v1/chat/completions` 的 OpenAI 兼容中转站。
 *
 * 存在的理由：phase 2（Responses → Chat 翻译）需要一个 chat-only 上游才能端到端验证，
 * 而本地环境里唯一有凭据的中转站是 Responses **原生**的（走的是 phase 1 直通路径，
 * 测不到翻译）。没有它，翻译路径只能靠单测覆盖，AC1/AC5/AC6 无法验证。
 *
 * 刻意保持「粗糙但真实」：
 * - 只实现 `/v1/chat/completions`，其余路径 404 —— 正是 chat-only 中转站的行为。
 * - `stream:true` 时按真实上游的形状分片发 SSE，并在最后单独发一个 usage-only chunk
 *   （需要请求里带 `stream_options.include_usage`，否则**不发** usage —— 这正是网关
 *   必须注入该字段的原因，也是本脚本能验证它的方式）。
 * - 工具调用轮把 `arguments` 拆成多个 delta，复现真实上游的分片行为。
 *
 * 用法：
 *   npx tsx scripts/smoke/fake-chat-only-upstream.ts [--port 8899]
 *
 * 环境变量：
 * - FAKE_UPSTREAM_PORT — 端口，默认 8899
 * - FAKE_UPSTREAM_MODE — `text`（默认）| `tool` | `truncate`，控制响应形态
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

function resolvePort(): number {
  const flagIndex = process.argv.indexOf('--port');
  const raw =
    (flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined) ?? process.env.FAKE_UPSTREAM_PORT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 8899;
}

const PORT = resolvePort();

type Mode = 'text' | 'tool' | 'truncate';

function resolveMode(body: Record<string, unknown>): Mode {
  const env = (process.env.FAKE_UPSTREAM_MODE ?? '').trim();
  if (env === 'tool' || env === 'truncate' || env === 'text') return env;
  // 也支持按请求内容切换，便于一个进程跑完多种场景
  const raw = JSON.stringify(body.messages ?? '');
  if (raw.includes('__MODE_TOOL__')) return 'tool';
  if (raw.includes('__MODE_TRUNCATE__')) return 'truncate';
  return 'text';
}

const CHAT_ID = 'chatcmpl-fake0000000000000001';

function sse(res: ServerResponse, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): Record<string, unknown> {
  return {
    id: CHAT_ID,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fake-chat-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

const USAGE = {
  prompt_tokens: 41,
  completion_tokens: 7,
  total_tokens: 48,
  prompt_tokens_details: { cached_tokens: 8 },
  completion_tokens_details: { reasoning_tokens: 2 },
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function streamText(res: ServerResponse, includeUsage: boolean): void {
  sse(res, chunk({ role: 'assistant', content: '' }));
  for (const piece of ['Hello', ' from', ' the', ' fake', ' chat-only', ' relay']) {
    sse(res, chunk({ content: piece }));
  }
  sse(res, chunk({}, 'stop'));
  // 只有请求里带了 stream_options.include_usage 才发 usage —— 与真实中转站一致
  if (includeUsage) {
    sse(res, { ...chunk({}), choices: [], usage: USAGE });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function streamTool(res: ServerResponse, includeUsage: boolean): void {
  sse(res, chunk({ role: 'assistant', content: '' }));
  sse(
    res,
    chunk({
      tool_calls: [
        { index: 0, id: 'call_fake_shell_1', type: 'function', function: { name: 'shell', arguments: '' } },
      ],
    })
  );
  // 参数分片：真实上游就是这样切的
  for (const frag of ['{"comm', 'and":["ls"', ',"-la"]', '}']) {
    sse(res, chunk({ tool_calls: [{ index: 0, function: { arguments: frag } }] }));
  }
  sse(res, chunk({}, 'tool_calls'));
  if (includeUsage) {
    sse(res, { ...chunk({}), choices: [], usage: USAGE });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/** 中途断流：不发 finish_reason、不发 [DONE]。网关必须仍给客户端补上终止事件。 */
function streamTruncate(res: ServerResponse): void {
  sse(res, chunk({ role: 'assistant', content: '' }));
  sse(res, chunk({ content: 'partial output then the relay dies' }));
  res.destroy();
}

const server = createServer((req, res) => {
  void (async () => {
    const url = req.url ?? '';
    if (!url.startsWith('/v1/chat/completions')) {
      // chat-only：其余路径一律 404，包括 /v1/responses
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `no such endpoint: ${url}`, type: 'invalid_request_error' } }));
      console.log(`[fake-upstream] 404 ${req.method} ${url}`);
      return;
    }

    const body = await readBody(req);
    const streaming = body.stream === true;
    const includeUsage =
      typeof body.stream_options === 'object' &&
      body.stream_options !== null &&
      (body.stream_options as { include_usage?: unknown }).include_usage === true;
    const mode = resolveMode(body);

    console.log(
      `[fake-upstream] ${req.method} ${url} stream=${streaming} include_usage=${includeUsage} mode=${mode} ua=${req.headers['user-agent'] ?? '-'} tools=${Array.isArray(body.tools) ? body.tools.length : 0}`
    );

    if (!streaming) {
      const message =
        mode === 'tool'
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_fake_shell_1',
                  type: 'function',
                  function: { name: 'shell', arguments: '{"command":["ls","-la"]}' },
                },
              ],
            }
          : { role: 'assistant', content: 'Hello from the fake chat-only relay' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: CHAT_ID,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'fake-chat-model',
          choices: [{ index: 0, message, finish_reason: mode === 'tool' ? 'tool_calls' : 'stop' }],
          usage: USAGE,
        })
      );
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'x-request-id': 'req_fake_upstream_0001',
    });
    if (mode === 'tool') return streamTool(res, includeUsage);
    if (mode === 'truncate') return streamTruncate(res);
    return streamText(res, includeUsage);
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-upstream] chat-only OpenAI-compatible relay on http://127.0.0.1:${PORT}/v1`);
  console.log('[fake-upstream] implements ONLY /v1/chat/completions; everything else 404s');
});
