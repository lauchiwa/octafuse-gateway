/**
 * `updateProviderService` 的 custom_headers 落库回归。
 *
 * 背景（2026-08 上游合并回归）：上游把 `const patch = { ...body }` 重构成空对象 + 逐字段
 * 显式添加，但遗留的 `if ('customHeaders' in patch)` 没跟着改成 `body`。`patch` 从不含
 * 该键，于是 `custom_headers` 永远不写库 —— 管理端保存后刷新，自定义 header 全部消失。
 * 同一次重构新增的 `if (Object.keys(patch).length === 0) return` 又让「只改 header」
 * 在写库前提前返回。两者都无测试覆盖。
 *
 * 这些断言直接盯住传给 `updateProviderByPatch` 的 patch，因此任何把 customHeaders 从
 * patch 链路上摘掉的改动都会立刻变红。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import { updateProviderService } from './providers-service';

type Captured = { id: string; patch: Record<string, unknown> } | null;

/** 最小假 repos：只实现 updateProviderService 走到的两个方法，并捕获 patch。 */
function fakeRepos(): { repos: GatewayRepositories; captured: () => Captured } {
	let captured: Captured = null;
	const repos = {
		providers: {
			async getProviderRowById() {
				return {
					id: 'p1',
					name: 'P1',
					endpoints: JSON.stringify({ openai: { base: 'https://up.example.com/v1' } }),
					api_key: 'sk-provider-secret',
					status: 'active',
					custom_headers: null,
					description: null,
					created_at: '2026-01-01T00:00:00.000Z',
				};
			},
			async updateProviderByPatch(id: string, patch: Record<string, unknown>) {
				captured = { id, patch };
				return 1;
			},
		},
	} as unknown as GatewayRepositories;
	return { repos, captured: () => captured };
}

describe('updateProviderService — custom_headers 落库', () => {
	it('把 body.customHeaders 转成 patch.custom_headers 的 JSON', async () => {
		const { repos, captured } = fakeRepos();

		await updateProviderService(repos, 'p1', {
			name: 'P1',
			customHeaders: { openai: { 'X-Trace': 'abc' } },
		});

		const call = captured();
		assert.ok(call, 'updateProviderByPatch 未被调用');
		assert.equal(call.patch.customHeaders, undefined, 'camelCase 键不应落到 SQL patch');
		assert.equal(
			call.patch.custom_headers,
			JSON.stringify({ openai: { 'X-Trace': 'abc' } }),
			'custom_headers 必须写入 patch'
		);
	});

	it('仅修改 custom headers（无其它字段）时依然写库', async () => {
		const { repos, captured } = fakeRepos();

		// 回归点：曾因 `Object.keys(patch).length === 0` 提前 return 而整个请求空转。
		await updateProviderService(repos, 'p1', {
			customHeaders: { anthropic: { 'User-Agent': 'ua-anthropic' } },
		});

		const call = captured();
		assert.ok(call, '只改 custom headers 时 updateProviderByPatch 必须被调用');
		assert.equal(
			call.patch.custom_headers,
			JSON.stringify({ anthropic: { 'User-Agent': 'ua-anthropic' } })
		);
	});

	it('空 map 写成 null（清空 header）', async () => {
		const { repos, captured } = fakeRepos();

		await updateProviderService(repos, 'p1', { customHeaders: {} });

		const call = captured();
		assert.ok(call, '清空 header 也要落库');
		assert.equal(call.patch.custom_headers, null);
	});

	it('body 不含 customHeaders 时不动该列', async () => {
		const { repos, captured } = fakeRepos();

		await updateProviderService(repos, 'p1', { name: 'renamed' });

		const call = captured();
		assert.ok(call);
		assert.equal('custom_headers' in call.patch, false, '未传该字段时不应覆盖已有 header');
		assert.equal(call.patch.name, 'renamed');
	});

	it('非法 header 名直接抛错，不落库', async () => {
		const { repos, captured } = fakeRepos();

		await assert.rejects(
			() => updateProviderService(repos, 'p1', { customHeaders: { openai: { Authorization: 'Bearer x' } } }),
			/authorization|denied|not allowed/i
		);
		assert.equal(captured(), null, '校验失败时不应调用 updateProviderByPatch');
	});
});
