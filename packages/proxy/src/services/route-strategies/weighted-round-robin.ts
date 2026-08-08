import type { RouteResult } from '../model-router';
import type { RouteOrderContext } from './types';

/** tierKey → 下次起始偏移（进程内存）。 */
const counters = new Map<string, number>();

/**
 * 按 weight 展开序列，再按进程内计数器轮转；去重后保持首次出现顺序。
 */
export function orderByWeightedRoundRobin(routes: RouteResult[], ctx: RouteOrderContext): RouteResult[] {
	if (routes.length <= 1) return [...routes];

	const expanded: RouteResult[] = [];
	for (const route of routes) {
		const n = Math.max(1, Math.floor(route.routeWeight));
		for (let i = 0; i < n; i++) {
			expanded.push(route);
		}
	}

	const start = counters.get(ctx.tierKey) ?? 0;
	counters.set(ctx.tierKey, start + 1);
	const offset = expanded.length === 0 ? 0 : ((start % expanded.length) + expanded.length) % expanded.length;
	const rotated = [...expanded.slice(offset), ...expanded.slice(0, offset)];

	const seen = new Set<string>();
	const ordered: RouteResult[] = [];
	for (const route of rotated) {
		if (seen.has(route.providerId)) continue;
		seen.add(route.providerId);
		ordered.push(route);
	}
	return ordered;
}

/** 测试用：清空 weighted round-robin 计数器。 */
export function resetWeightedRoundRobinStateForTests(): void {
	counters.clear();
}
