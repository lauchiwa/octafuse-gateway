import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ROUTE_STRATEGY_NAMES } from '@octafuse/core/db/model-route-policy';
import {
	getRouteStrategyMeta,
	ROUTE_STRATEGY_META_LIST,
	ROUTE_STRATEGY_UI_ORDER,
	STRATEGY_DIAGRAM_TARGETS,
} from './route-strategy-meta';

describe('route-strategy-meta', () => {
	it('covers every persisted RouteStrategyName exactly once in UI order', () => {
		assert.deepEqual(
			ROUTE_STRATEGY_META_LIST.map((m) => m.id),
			[...ROUTE_STRATEGY_UI_ORDER]
		);
		assert.equal(new Set(ROUTE_STRATEGY_META_LIST.map((m) => m.id)).size, ROUTE_STRATEGY_NAMES.length);
		for (const id of ROUTE_STRATEGY_NAMES) {
			assert.ok((ROUTE_STRATEGY_UI_ORDER as readonly string[]).includes(id));
		}
	});

	it('orders cards by common usage (load-balance first)', () => {
		assert.deepEqual([...ROUTE_STRATEGY_UI_ORDER], [
			'weighted_round_robin',
			'weighted_random',
			'hash_affinity',
			'weight_priority',
		]);
	});

	it('keeps machine ids identical to persisted strategy names', () => {
		for (const meta of ROUTE_STRATEGY_META_LIST) {
			assert.equal(meta.machineId, meta.id);
			assert.equal(meta.diagram, meta.id);
		}
	});

	it('returns null for unknown strategy ids', () => {
		assert.equal(getRouteStrategyMeta('sticky'), null);
		assert.equal(getRouteStrategyMeta(''), null);
	});

	it('provides demo targets for diagram weight labels', () => {
		assert.equal(STRATEGY_DIAGRAM_TARGETS.length, 3);
		const sum = STRATEGY_DIAGRAM_TARGETS.reduce((acc, t) => acc + t.weightPct, 0);
		assert.equal(sum, 100);
	});
});
