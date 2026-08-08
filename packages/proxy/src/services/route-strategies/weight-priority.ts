import type { RouteResult } from '../model-router';
import type { RouteOrderContext } from './types';

/** 按 routeWeight DESC，再按 providerId ASC（稳定）。 */
export function orderByWeightPriority(routes: RouteResult[], _ctx: RouteOrderContext): RouteResult[] {
	return [...routes].sort((a, b) => {
		if (b.routeWeight !== a.routeWeight) return b.routeWeight - a.routeWeight;
		return a.providerId.localeCompare(b.providerId);
	});
}
