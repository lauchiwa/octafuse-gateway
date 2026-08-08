/**
 * 结构性不变量：**每个向上游发起 fetch 的 egress 驱动都必须合并 `providerCustomHeaders`**。
 *
 * 为什么用源码扫描而不是逐驱动 mock fetch：这类缺陷的形态是「N 个并行实现漏了一个」，
 * 而不是某个实现内部逻辑错。`openai-audio-driver.ts` 就漏了整整一个版本 —— 它连
 * `mergeUpstreamHeaders` 都没 import，所以配置好的 `User-Agent` / 指纹头对音频转写
 * 请求完全无效。逐驱动单测无法发现「新加的驱动忘了接线」，而这个测试可以：
 * 新增驱动只要发 fetch 就自动纳入检查。
 *
 * 该不变量的实际影响：provider 自定义头承载客户端身份（UA / originator）与平台指纹
 * （如 sub2api 的 `x-codex-*` 门禁）。漏一个驱动 = 该协议的请求在有门禁的中转站上必然被拒。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EGRESS_DIR = dirname(fileURLToPath(import.meta.url));

/** 读取所有非测试的驱动源码。 */
function driverSources(): { name: string; src: string }[] {
	return readdirSync(EGRESS_DIR)
		.filter((f) => f.endsWith('-driver.ts') && !f.endsWith('.test.ts'))
		.map((name) => ({ name, src: readFileSync(join(EGRESS_DIR, name), 'utf8') }));
}

/** 是否向上游发起真实请求（排除仅做转换的纯模块）。 */
function callsUpstreamFetch(src: string): boolean {
	return /await fetch\(/.test(src);
}

describe('egress 驱动的 providerCustomHeaders 覆盖', () => {
	it('至少发现预期数量的驱动（防止 glob 失效导致测试空跑）', () => {
		const drivers = driverSources();
		assert.ok(
			drivers.length >= 5,
			`expected >=5 driver files, found ${drivers.length}: ${drivers.map((d) => d.name).join(', ')}`
		);
	});

	it('每个发 fetch 的驱动都 import 了 mergeUpstreamHeaders', () => {
		const missing = driverSources()
			.filter((d) => callsUpstreamFetch(d.src))
			.filter((d) => !d.src.includes("from './merge-upstream-headers'"))
			.map((d) => d.name);
		assert.deepEqual(
			missing,
			[],
			`这些驱动发起上游 fetch 但未 import mergeUpstreamHeaders，provider 自定义头会被丢弃: ${missing.join(', ')}`
		);
	});

	it('每个发 fetch 的驱动都把 route.providerCustomHeaders 传入合并', () => {
		const missing = driverSources()
			.filter((d) => callsUpstreamFetch(d.src))
			.filter((d) => !/route\.providerCustomHeaders/.test(d.src))
			.map((d) => d.name);
		assert.deepEqual(
			missing,
			[],
			`这些驱动未把 route.providerCustomHeaders 传给 mergeUpstreamHeaders: ${missing.join(', ')}`
		);
	});

	it('multipart 驱动不得手写 Content-Type（须由 runtime 生成 boundary）', () => {
		// images.edits 与 audio.transcriptions 都是 multipart：显式设 Content-Type 会丢掉 boundary。
		const offenders: string[] = [];
		for (const d of driverSources()) {
			if (!/new FormData\(\)/.test(d.src)) continue;
			// 取 FormData 之后的片段，检查同一 fetch 是否手写了 multipart Content-Type
			if (/'Content-Type':\s*'multipart\/form-data/i.test(d.src)) offenders.push(d.name);
		}
		assert.deepEqual(offenders, [], `multipart 驱动不应手写 Content-Type: ${offenders.join(', ')}`);
	});
});
