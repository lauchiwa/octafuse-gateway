/**
 * 结构性不变量：**fork 独有的 `/v1/responses` 必须与上游迁移过的路由保持同等接线**。
 *
 * 为什么用源码扫描：这类缺陷的形态是「上游重构了共享服务，把自己的 N 条路由都改了，
 * 但 fork 独有的第 N+1 条没人改」。它不会有冲突标记、不会 typecheck 失败、也不会让
 * 任何既有用例变红 —— 只会在运行时静默丢掉一整类配置。
 *
 * 实证（两次踩中同一个坑）：
 * - v2.1.1：上游删掉 `sensitive-content-circuit-route` 并给 chat/messages/gemini 加了
 *   `markUserModelSuccess()`，`/v1/responses` 没有 → 退避阶梯成功后永不复位。
 * - v2.3.0：上游给 5 条路由接了 sticky routing 与 `tierStrategies`，`/v1/responses`
 *   四项全缺，且 `poolStrategy` 硬编码 `null` → 生产库 3 个 `responses` surface 的
 *   route_pool 策略全部被忽略。
 *
 * 因此这里断言的是「接线存在」，而不是某个具体行为 —— 后者由各自的单测覆盖。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTES_DIR = dirname(fileURLToPath(import.meta.url));

/** 上游自己迁移过的 LLM 路由，作为对照基准。 */
const UPSTREAM_MIGRATED = ['chat.ts', 'messages.ts', 'gemini.ts'] as const;
/** fork 独有、上游没有对应文件的路由。 */
const FORK_ONLY = ['responses.ts'] as const;

function src(file: string): string {
	return readFileSync(join(ROUTES_DIR, file), 'utf8');
}

/**
 * 每项接线用一个「必须出现的符号」表示。选符号而非正则匹配整段，是为了让用例在上游
 * 再次重构时依然可读：符号消失即代表接线断了。
 */
const REQUIRED_WIRING: Record<string, string> = {
	'user+model 熔断成功复位': 'markUserModelSuccess',
	'user+model 熔断触发': 'maybeTriggerUserModelCircuitFromUpstream',
	'surface 解析（取 route_pool 元数据）': 'resolveRoutesForSurface',
	'按 priority 层的策略覆盖': 'tierStrategies',
	'sticky 绑定的 pool id': 'routePoolId',
	'sticky 配置': 'stickyConfigFromSurface',
	'sticky 观测写入 route_trace': 'stickyTrace',
};

describe('fork 独有路由与上游路由的接线对等性', () => {
	it('对照基准本身成立（上游迁移过的路由都有全部接线）', () => {
		for (const file of UPSTREAM_MIGRATED) {
			const s = src(file);
			const missing = Object.entries(REQUIRED_WIRING)
				.filter(([, symbol]) => !s.includes(symbol))
				.map(([label]) => label);
			assert.deepEqual(
				missing,
				[],
				`基准路由 ${file} 缺少接线，说明本用例的符号清单已过时: ${missing.join('、')}`
			);
		}
	});

	it('/v1/responses 具备与上游路由相同的接线', () => {
		for (const file of FORK_ONLY) {
			const s = src(file);
			const missing = Object.entries(REQUIRED_WIRING)
				.filter(([, symbol]) => !s.includes(symbol))
				.map(([label]) => label);
			assert.deepEqual(
				missing,
				[],
				`fork 独有路由 ${file} 缺少接线（上游重构不会替你迁移它）: ${missing.join('、')}`
			);
		}
	});

	it('/v1/responses 不得把 poolStrategy 硬编码为 null', () => {
		// 曾经的真实缺陷：硬编码 null 会让 route_pool.strategy 永远不生效，
		// 而 typecheck 与所有既有用例都不会报错。
		for (const file of FORK_ONLY) {
			assert.equal(
				/poolStrategy:\s*null/.test(src(file)),
				false,
				`${file} 把 poolStrategy 硬编码为 null，route_pool 策略会被静默忽略`
			);
		}
	});

	it('/v1/responses 仍保留 fork 独有的能力门禁', () => {
		// 与上面相反的方向：接线对齐不能把 fork 自己的语义弄丢。
		const s = src('responses.ts');
		assert.ok(
			s.includes('providerDeclaresResponsesEndpoint'),
			'Responses 能力门禁丢失：只配 base 的 provider 会被选中并在运行时抛错'
		);
	});
});
