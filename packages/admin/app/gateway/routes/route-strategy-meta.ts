import type { RouteStrategyName } from '@octafuse/core';
import { ROUTE_STRATEGY_NAMES } from '@octafuse/core/db/model-route-policy';

export type RouteStrategyDiagramKind = RouteStrategyName;

export type RouteStrategyMeta = {
	id: RouteStrategyName;
	/** Shown as a secondary monospace badge; never localized. */
	machineId: RouteStrategyName;
	diagram: RouteStrategyDiagramKind;
};

const META_BY_ID: Record<RouteStrategyName, RouteStrategyMeta> = {
	hash_affinity: {
		id: 'hash_affinity',
		machineId: 'hash_affinity',
		diagram: 'hash_affinity',
	},
	weight_priority: {
		id: 'weight_priority',
		machineId: 'weight_priority',
		diagram: 'weight_priority',
	},
	weighted_random: {
		id: 'weighted_random',
		machineId: 'weighted_random',
		diagram: 'weighted_random',
	},
	weighted_round_robin: {
		id: 'weighted_round_robin',
		machineId: 'weighted_round_robin',
		diagram: 'weighted_round_robin',
	},
};

/**
 * Admin UI card order (most commonly used first).
 * Persisted enum order remains `ROUTE_STRATEGY_NAMES` in core.
 */
export const ROUTE_STRATEGY_UI_ORDER = [
	'weighted_round_robin',
	'weighted_random',
	'hash_affinity',
	'weight_priority',
] as const satisfies readonly RouteStrategyName[];

export const ROUTE_STRATEGY_META_LIST: RouteStrategyMeta[] = ROUTE_STRATEGY_UI_ORDER.map(
	(id) => META_BY_ID[id]
);

export function getRouteStrategyMeta(id: string): RouteStrategyMeta | null {
	if (!ROUTE_STRATEGY_NAMES.includes(id as RouteStrategyName)) return null;
	return META_BY_ID[id as RouteStrategyName];
}

/** Demo targets used by the SVG mini diagrams (not real providers). */
export const STRATEGY_DIAGRAM_TARGETS = [
	{ id: 't1', label: 'T1', weightPct: 60, order: 1 },
	{ id: 't2', label: 'T2', weightPct: 30, order: 2 },
	{ id: 't3', label: 'T3', weightPct: 10, order: 3 },
] as const;
