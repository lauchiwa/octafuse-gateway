import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	normalizeRoutePoolTierStrategiesInput,
	parseRoutePoolTierStrategies,
} from './route-pool-tier-strategies';

describe('parseRoutePoolTierStrategies', () => {
	it('returns empty map for null / empty / invalid JSON', () => {
		assert.equal(parseRoutePoolTierStrategies(null).size, 0);
		assert.equal(parseRoutePoolTierStrategies('').size, 0);
		assert.equal(parseRoutePoolTierStrategies('not json').size, 0);
		assert.equal(parseRoutePoolTierStrategies('[]').size, 0);
		assert.equal(parseRoutePoolTierStrategies('"hash_affinity"').size, 0);
	});

	it('parses valid priority → strategy map and ignores bad entries', () => {
		const map = parseRoutePoolTierStrategies(
			JSON.stringify({
				'10': 'hash_affinity',
				'0': 'weight_priority',
				bad: 'hash_affinity',
				'1.5': 'weighted_random',
				'2': 'nope',
				'3': 1,
			})
		);
		assert.equal(map.size, 2);
		assert.equal(map.get(10), 'hash_affinity');
		assert.equal(map.get(0), 'weight_priority');
	});

	it('accepts negative integer priorities', () => {
		const map = parseRoutePoolTierStrategies(JSON.stringify({ '-1': 'weighted_round_robin' }));
		assert.equal(map.get(-1), 'weighted_round_robin');
	});
});

describe('normalizeRoutePoolTierStrategiesInput', () => {
	it('returns null for empty / null / empty object', () => {
		assert.equal(normalizeRoutePoolTierStrategiesInput(null), null);
		assert.equal(normalizeRoutePoolTierStrategiesInput(''), null);
		assert.equal(normalizeRoutePoolTierStrategiesInput('{}'), null);
		assert.equal(normalizeRoutePoolTierStrategiesInput({}), null);
	});

	it('normalizes object and string inputs', () => {
		assert.equal(
			normalizeRoutePoolTierStrategiesInput({ '10': 'hash_affinity', '0': 'weight_priority' }),
			JSON.stringify({ '10': 'hash_affinity', '0': 'weight_priority' })
		);
		assert.equal(
			normalizeRoutePoolTierStrategiesInput('{"10":"hash_affinity"}'),
			JSON.stringify({ '10': 'hash_affinity' })
		);
	});

	it('throws on invalid key or strategy', () => {
		assert.throws(
			() => normalizeRoutePoolTierStrategiesInput({ foo: 'hash_affinity' }),
			/integer priority/
		);
		assert.throws(
			() => normalizeRoutePoolTierStrategiesInput({ '1': 'sticky' }),
			/must be one of/
		);
		assert.throws(
			() => normalizeRoutePoolTierStrategiesInput('not json'),
			/valid JSON/
		);
	});
});
