/**
 * 同 priority 层内的路由排序策略。
 */
import type { GatewayRepositories, RouteStrategyName, UpstreamProtocol } from '@octafuse/core';
import {
	DEFAULT_ROUTE_STRATEGY,
	getGlobalRouteStrategy,
	isRouteStrategyName,
	parseRoutePoolTierStrategies,
	resolveModelRoutePolicyStrategy,
} from '@octafuse/core';
import type { RouteOrderStrategy } from './types';
import { orderByHashAffinity } from './hash-affinity';
import { orderByWeightedRandom } from './weighted-random';
import { orderByWeightPriority } from './weight-priority';
import { orderByWeightedRoundRobin } from './weighted-round-robin';

export type { RouteOrderContext, RouteOrderStrategy } from './types';

export const ROUTE_STRATEGIES: Record<RouteStrategyName, RouteOrderStrategy> = {
	hash_affinity: orderByHashAffinity,
	weighted_random: orderByWeightedRandom,
	weight_priority: orderByWeightPriority,
	weighted_round_robin: orderByWeightedRoundRobin,
};

export type RouteStrategyPlan = {
	/** Pool / model / global 解析出的缺省策略（未配置 tier override 的层使用） */
	base: RouteStrategyName;
	/** `route_pools.tier_strategies` 解析结果：priority → strategy */
	tierOverrides: ReadonlyMap<number, RouteStrategyName>;
};

/**
 * 六级解析：pool → model capability rule → protocol rule → model strategy → global system_config → DEFAULT。
 * 不含 per-tier override（见 `resolveRouteStrategyPlan`）。
 */
export async function resolveRouteStrategy(params: {
	routePolicyRaw: string | null | undefined;
	poolStrategy?: string | null;
	protocol: UpstreamProtocol | string;
	capability: string;
	routeGroup: string;
	repos: GatewayRepositories;
}): Promise<RouteStrategyName> {
	if (params.poolStrategy && isRouteStrategyName(params.poolStrategy)) {
		return params.poolStrategy;
	}
	const fromModel = resolveModelRoutePolicyStrategy(
		params.routePolicyRaw,
		params.protocol,
		params.capability,
		params.routeGroup
	);
	if (fromModel) return fromModel;
	return getGlobalRouteStrategy(params.repos);
}

/**
 * 解析本次请求的策略计划：base + 按 priority 层的覆盖。
 * 运行时优先级：tier_strategies[priority] → base（pool → model → global → default）。
 */
export async function resolveRouteStrategyPlan(params: {
	routePolicyRaw: string | null | undefined;
	poolStrategy?: string | null;
	poolTierStrategies?: string | null;
	protocol: UpstreamProtocol | string;
	capability: string;
	routeGroup: string;
	repos: GatewayRepositories;
}): Promise<RouteStrategyPlan> {
	const base = await resolveRouteStrategy(params);
	const tierOverrides = parseRoutePoolTierStrategies(params.poolTierStrategies);
	return { base, tierOverrides };
}

/** affinityKey = userId|baseModelId|routeGroup|protocol */
export { buildAffinityKey } from '@octafuse/core/db/route-affinity-key';

/** tierKey 前缀 = baseModelId|routeGroup|protocol；完整 tierKey = `${prefix}|${priority}` */
export function buildTierKeyPrefix(baseModelId: string, routeGroup: string, protocol: string): string {
	return `${baseModelId}|${routeGroup}|${protocol}`;
}

export { orderByHashAffinity } from './hash-affinity';
export { orderByWeightedRandom } from './weighted-random';
export { orderByWeightPriority } from './weight-priority';
export { orderByWeightedRoundRobin, resetWeightedRoundRobinStateForTests } from './weighted-round-robin';
export { fnv1a32, routeAffinityScore } from './route-affinity-hash';
export { DEFAULT_ROUTE_STRATEGY };
