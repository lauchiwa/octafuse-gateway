/**
 * Playground 自定义上游 header 注入。
 *
 * 覆盖两层：
 * - `resolvePlaygroundRoute` 是否把 `providers.custom_headers` 按协议拍平到 route 上。
 * - `invokePlaygroundUpstream` 实际 fetch 时的 header —— 用 stub 全局 fetch 捕获，
 *   断言合并顺序（内置鉴权/协议 header 永远覆盖 custom）与无自定义时的逐字节一致性。
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import { invokePlaygroundUpstream, resolvePlaygroundRoute } from './playground-service';

const CUSTOM = {
	openai: { 'User-Agent': 'octafuse-playground/1.0', 'X-Trace': 'abc' },
	anthropic: { 'User-Agent': 'ua-anthropic' },
};

type FakeOpts = {
	protocol?: string;
	customHeaders?: string | null;
	endpoints?: string | null;
};

/** 最小假 repos：只实现 resolvePlaygroundRoute 走到的 4 个方法。 */
function fakeRepos(opts: FakeOpts = {}): GatewayRepositories {
	const protocol = opts.protocol ?? 'openai';
	const endpoints =
		opts.endpoints ??
		JSON.stringify({
			openai: { base: 'https://up.example.com/v1' },
			anthropic: { base: 'https://up.example.com' },
		});
	return {
		routes: {
			async getModelRouteRowById() {
				return {
					id: 'r1',
					provider_id: 'p1',
					model_id: 'm1',
					provider_model_name: 'gpt-4o-mini',
					upstream_protocol: protocol,
					custom_params: null,
				};
			},
		},
		providers: {
			async getProviderById() {
				return {
					id: 'p1',
					name: 'P1',
					endpoints,
					api_key: 'sk-provider-secret',
					status: 'active',
					custom_headers: opts.customHeaders ?? null,
					description: null,
					created_at: '2026-01-01T00:00:00.000Z',
				};
			},
			async getProviderApiKeyPlaintext() {
				return { api_key: 'sk-provider-secret' };
			},
		},
		models: {
			async getModelDetailWithRouteCounts() {
				return null;
			},
		},
	} as unknown as GatewayRepositories;
}

const realFetch = globalThis.fetch;

/** 替换全局 fetch，捕获实际发出的 header。 */
function captureFetch(): { headers: () => Record<string, string> } {
	let captured: Record<string, string> = {};
	globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
		captured = { ...((init.headers ?? {}) as Record<string, string>) };
		return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
	}) as unknown as typeof fetch;
	return { headers: () => captured };
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe('resolvePlaygroundRoute custom headers', () => {
	it('flattens custom_headers for the route protocol', async () => {
		const route = await resolvePlaygroundRoute(
			fakeRepos({ protocol: 'openai', customHeaders: JSON.stringify(CUSTOM) }),
			'r1'
		);
		assert.deepEqual(route.providerCustomHeaders, CUSTOM.openai);
	});

	it('picks the anthropic set when the route is anthropic', async () => {
		const route = await resolvePlaygroundRoute(
			fakeRepos({ protocol: 'anthropic', customHeaders: JSON.stringify(CUSTOM) }),
			'r1'
		);
		assert.deepEqual(route.providerCustomHeaders, CUSTOM.anthropic);
	});

	it('defaults to {} for NULL / unconfigured protocol / malformed JSON', async () => {
		const nullRoute = await resolvePlaygroundRoute(fakeRepos({ customHeaders: null }), 'r1');
		assert.deepEqual(nullRoute.providerCustomHeaders, {});

		const otherProtocol = await resolvePlaygroundRoute(
			fakeRepos({ protocol: 'gemini', customHeaders: JSON.stringify(CUSTOM) }),
			'r1'
		);
		assert.deepEqual(otherProtocol.providerCustomHeaders, {});

		const bad = await resolvePlaygroundRoute(fakeRepos({ customHeaders: 'not-json' }), 'r1');
		assert.deepEqual(bad.providerCustomHeaders, {});
	});
});

describe('invokePlaygroundUpstream header injection', () => {
	it('injects custom headers alongside built-in ones (openai)', async () => {
		const cap = captureFetch();
		await invokePlaygroundUpstream(
			fakeRepos({ protocol: 'openai', customHeaders: JSON.stringify(CUSTOM) }),
			{ routeId: 'r1', body: { messages: [] } }
		);
		const h = cap.headers();
		assert.equal(h['User-Agent'], 'octafuse-playground/1.0');
		assert.equal(h['X-Trace'], 'abc');
		// 内置鉴权/协议 header 保持不变
		assert.equal(h['Authorization'], 'Bearer sk-provider-secret');
		assert.equal(h['Content-Type'], 'application/json');
	});

	it('injects custom headers for anthropic and keeps protocol headers', async () => {
		const cap = captureFetch();
		await invokePlaygroundUpstream(
			fakeRepos({ protocol: 'anthropic', customHeaders: JSON.stringify(CUSTOM) }),
			{ routeId: 'r1', body: { messages: [] } }
		);
		const h = cap.headers();
		assert.equal(h['User-Agent'], 'ua-anthropic');
		assert.equal(h['x-api-key'], 'sk-provider-secret');
		assert.equal(h['anthropic-version'], '2023-06-01');
	});

	it('custom headers cannot override built-in auth / protocol headers', async () => {
		// 这些名字写入侧已被 core denylist 拒绝；此处直接构造脏数据，
		// 验证即使绕过写入校验（例如手工改库），合并顺序仍保证内置值取胜。
		const dirty = JSON.stringify({
			anthropic: {
				'x-api-key': 'leaked-key',
				'anthropic-version': 'evil',
				'Content-Type': 'text/plain',
			},
		});
		const cap = captureFetch();
		await invokePlaygroundUpstream(
			fakeRepos({ protocol: 'anthropic', customHeaders: dirty }),
			{ routeId: 'r1', body: { messages: [] } }
		);
		const h = cap.headers();
		assert.equal(h['x-api-key'], 'sk-provider-secret');
		assert.equal(h['anthropic-version'], '2023-06-01');
		assert.equal(h['Content-Type'], 'application/json');
	});

	it('headers are unchanged when the provider has no custom_headers', async () => {
		const cap = captureFetch();
		await invokePlaygroundUpstream(fakeRepos({ protocol: 'openai', customHeaders: null }), {
			routeId: 'r1',
			body: { messages: [] },
		});
		assert.deepEqual(cap.headers(), {
			'Content-Type': 'application/json',
			Authorization: 'Bearer sk-provider-secret',
		});
	});
});
