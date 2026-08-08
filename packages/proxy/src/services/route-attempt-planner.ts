/**
 * 将协议已过滤的 routes 编排为本次请求的尝试序列：
 * priority 硬序（DESC）→ 层内按 route strategy 排序 → 层内可选偏好分区 → 过滤熔断中的 provider。
 */
import type { RouteStrategyName } from '@octafuse/core';
import type { RouteResult } from './model-router';
import { getProviderCircuitRemainingMs } from './provider-circuit-breaker';
import { ROUTE_STRATEGIES } from './route-strategies';

export type RouteAttemptPlan = {
	attempts: RouteResult[];
	earliestRetryAfterMs: number | null;
	skippedByCircuit: number;
};

export type RouteAttemptPlanOptions = {
	affinityKey: string;
	tierKeyPrefix: string;
	/**
	 * 层内偏好：返回 true 的 route 在**同一 priority 层内**排到前面，层间顺序不受影响。
	 *
	 * 用于 `/v1/responses`：原生直通优先于翻译成 chat，但不能因此越过 admin 配置的
	 * priority 分层（那会让高优先级的 chat-only provider 被低优先级的原生 provider 抢占）。
	 * 分区稳定，故层内 strategy（affinity / weighted / RR）算出的相对顺序在各分区内保留。
	 */
	preferInTier?: (route: RouteResult) => boolean;
};

function groupRoutesByPriorityDesc(routes: RouteResult[]): Array<{ priority: number; routes: RouteResult[] }> {
	const groups = new Map<number, RouteResult[]>();
	for (const route of routes) {
		const bucket = groups.get(route.routePriority) ?? [];
		bucket.push(route);
		groups.set(route.routePriority, bucket);
	}
	return [...groups.entries()]
		.sort((a, b) => b[0] - a[0])
		.map(([priority, tierRoutes]) => ({ priority, routes: tierRoutes }));
}

/**
 * 稳定分区：满足 `prefer` 的排前，其余保持原相对顺序。
 * 不使用 `Array.prototype.sort`——V8 的 sort 虽稳定，但比较器写法更容易在后续维护中引入非稳定语义。
 */
function applyTierPreference(
	ordered: RouteResult[],
	prefer?: (route: RouteResult) => boolean
): RouteResult[] {
	if (!prefer) return ordered;
	const preferred: RouteResult[] = [];
	const rest: RouteResult[] = [];
	for (const route of ordered) {
		(prefer(route) ? preferred : rest).push(route);
	}
	// 全部命中或全部未命中时省去拼接，保持与无偏好路径完全一致的数组内容。
	if (preferred.length === 0 || rest.length === 0) return ordered;
	return [...preferred, ...rest];
}

/**
 * 构建本次请求的 route 尝试计划。
 * `tierOverrides` 按 priority 覆盖 `strategyName`（未配置的层仍用 base）。
 */
export function buildRouteAttemptPlan(
	routes: RouteResult[],
	ctx: RouteAttemptPlanOptions,
	strategyName: RouteStrategyName,
	now = Date.now(),
	tierOverrides?: ReadonlyMap<number, RouteStrategyName> | null
): RouteAttemptPlan {
	const attempts: RouteResult[] = [];
	let earliestRetryAfterMs: number | null = null;
	let skippedByCircuit = 0;

	const trackRetryAfter = (ms: number): void => {
		if (earliestRetryAfterMs == null || ms < earliestRetryAfterMs) {
			earliestRetryAfterMs = ms;
		}
	};

	for (const tier of groupRoutesByPriorityDesc(routes)) {
		// 上游 v2.2.0 引入的按层策略覆盖：每个 priority 层可用不同排序策略。
		const name = tierOverrides?.get(tier.priority) ?? strategyName;
		const strategy = ROUTE_STRATEGIES[name] ?? ROUTE_STRATEGIES.hash_affinity;
		// fork 独有的层内偏好必须包在 strategy 外层：先由策略（含本层覆盖）排序，
		// 再做稳定分区。顺序反了就会被 strategy 重排而静默丢掉偏好。
		const ordered = applyTierPreference(
			strategy(tier.routes, {
				affinityKey: ctx.affinityKey,
				tierKey: `${ctx.tierKeyPrefix}|${tier.priority}`,
			}),
			ctx.preferInTier
		);
		for (const route of ordered) {
			const remaining = getProviderCircuitRemainingMs(route.providerId, now);
			if (remaining > 0) {
				skippedByCircuit += 1;
				trackRetryAfter(remaining);
				continue;
			}
			attempts.push(route);
		}
	}

	return { attempts, earliestRetryAfterMs, skippedByCircuit };
}
