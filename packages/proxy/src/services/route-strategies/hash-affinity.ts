import type { RouteResult } from '../model-router';
import type { RouteOrderContext } from './types';
import { routeAffinityScore } from './route-affinity-hash';

/** 按 affinity 分数降序；同分按 providerId 升序稳定排序。 */
export function orderByHashAffinity(routes: RouteResult[], ctx: RouteOrderContext): RouteResult[] {
	return [...routes].sort((a, b) => {
		const scoreA = routeAffinityScore(ctx.affinityKey, a.providerId, a.routeWeight);
		const scoreB = routeAffinityScore(ctx.affinityKey, b.providerId, b.routeWeight);
		if (scoreB !== scoreA) return scoreB - scoreA;
		return a.providerId.localeCompare(b.providerId);
	});
}
