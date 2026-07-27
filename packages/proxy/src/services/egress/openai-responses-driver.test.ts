/**
 * `openai-responses-driver` 单测（node:test，与包内其余测试一致；不用 vitest）。
 *
 * 覆盖两件容易静默出错的事：
 * 1. 客户端身份 header 的优先级 —— 断言必须穿过 `new Headers()`，因为
 *    `{'user-agent': …, 'User-Agent': …}` 是两个不同的对象键，`Headers` 会把它们
 *    **逗号拼接**而不是覆盖（实测：`"codex_cli_rs/0.144.6, myprovider/1.0"`）。
 *    只断言普通对象会绿着通过而线上是坏的。
 * 2. 字节直通 —— 转发给客户端的字节必须与上游逐字节一致（Codex 对 SSE 帧完整性敏感）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withClientIdentity } from './openai-responses-driver';

describe('withClientIdentity', () => {
	it('provider custom UA wins outright — no comma-joined concatenation', () => {
		// provider 用管理端录入的大小写，调用方来的是小写：这是真实的冲突形态。
		const merged = withClientIdentity(
			{ 'User-Agent': 'myprovider/1.0' },
			{ 'user-agent': 'codex_cli_rs/0.144.6' }
		);
		const wire = new Headers(merged);
		assert.equal(wire.get('user-agent'), 'myprovider/1.0');
		assert.ok(
			!(wire.get('user-agent') ?? '').includes(','),
			'provider value must win outright, not concatenate with the caller UA'
		);
	});

	it('caller identity is forwarded when the provider configures nothing', () => {
		const merged = withClientIdentity(undefined, {
			'user-agent': 'codex_cli_rs/0.144.6',
			originator: 'codex_cli_rs',
		});
		const wire = new Headers(merged);
		assert.equal(wire.get('user-agent'), 'codex_cli_rs/0.144.6');
		assert.equal(wire.get('originator'), 'codex_cli_rs');
	});

	it('originator collides case-insensitively too', () => {
		const merged = withClientIdentity(
			{ Originator: 'provider_side' },
			{ originator: 'codex_cli_rs' }
		);
		assert.equal(new Headers(merged).get('originator'), 'provider_side');
	});

	it('never synthesises a gateway UA when neither side supplies one', () => {
		const merged = withClientIdentity({ 'X-Foo': 'bar' }, {});
		const wire = new Headers(merged);
		assert.equal(wire.get('user-agent'), null);
		assert.equal(wire.get('originator'), null);
		// 非身份类的 custom header 必须原样保留
		assert.equal(wire.get('x-foo'), 'bar');
	});

	it('leaves unrelated custom headers untouched while dropping only collisions', () => {
		const merged = withClientIdentity(
			{ 'User-Agent': 'p/1', 'X-Keep': 'yes' },
			{ 'user-agent': 'c/2', originator: 'codex_cli_rs' }
		);
		const wire = new Headers(merged);
		assert.equal(wire.get('user-agent'), 'p/1');
		assert.equal(wire.get('x-keep'), 'yes');
		// provider 没配 originator，调用方的应当透传
		assert.equal(wire.get('originator'), 'codex_cli_rs');
	});
});


/**
 * 回归测试：曾经的真实缺陷 —— 驱动内部把 `data:` 前缀剥掉后，又调用了要求带前缀的
 * 行级解析函数，导致流式 usage 恒为 0、每个请求都被记为 `incomplete`。
 *
 * 单独测两个解析函数都会通过；只有走「驱动实际调用路径」才能抓到。
 * 因此这里直接驱动导出的 pump 入口，喂真实抓包形状的字节。
 */
describe('streaming pump collects usage end-to-end (regression: double-strip)', () => {
	it('a chunked terminal frame still yields usage', async () => {
		const { collectUsageFromSseTextForTest } = await import('./openai-responses-driver');

		const terminal = {
			type: 'response.completed',
			response: {
				id: 'resp_regression',
				usage: {
					input_tokens: 4388,
					input_tokens_details: { cached_tokens: 3840, cache_write_tokens: 0 },
					output_tokens: 5,
					output_tokens_details: { reasoning_tokens: 0 },
					total_tokens: 4393,
				},
			},
		};
		const sse =
			'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_regression","usage":null}}\n\n' +
			'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
			`event: response.completed\ndata: ${JSON.stringify(terminal)}\n\n`;

		const usage = collectUsageFromSseTextForTest(sse);
		assert.equal(usage.input_tokens, 4388, 'input_tokens must survive the pump');
		assert.equal(usage.output_tokens, 5);
		assert.equal(usage.cache_read_tokens, 3840);
		assert.equal(usage.total_tokens, 4393);
		assert.equal(usage.upstreamMessageId, 'resp_regression');
	});

	it('usage survives when the terminal frame is split across chunk boundaries', async () => {
		const { collectUsageFromSseChunksForTest } = await import('./openai-responses-driver');

		const big = 'x'.repeat(5000);
		const terminal = JSON.stringify({
			type: 'response.completed',
			response: {
				id: 'resp_split',
				instructions: big, // 迫使该行跨多个 chunk（真实抓包里这一行约 23KB）
				usage: { input_tokens: 100, output_tokens: 7, total_tokens: 107 },
			},
		});
		const full = `event: response.completed\ndata: ${terminal}\n\n`;

		const enc = new TextEncoder().encode(full);
		const chunks: Uint8Array[] = [];
		for (let i = 0; i < enc.length; i += 1024) {
			chunks.push(enc.slice(i, i + 1024));
		}
		assert.ok(chunks.length > 3, 'test must actually split the frame');

		const usage = collectUsageFromSseChunksForTest(chunks);
		assert.equal(usage.input_tokens, 100, 'split frames must be reassembled for parsing');
		assert.equal(usage.output_tokens, 7);
		assert.equal(usage.upstreamMessageId, 'resp_split');
	});
});
