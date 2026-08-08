import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GatewayRepositories } from '@octafuse/core';
import { resetRouteStrategyCacheForTests } from '@octafuse/core';
import type { RouteResult } from '../model-router';
import { isRouteStrategyName } from '@octafuse/core';
import {
	buildAffinityKey,
	buildTierKeyPrefix,
	resolveRouteStrategy,
	routeAffinityScore,
	ROUTE_STRATEGIES,
	resetWeightedRoundRobinStateForTests,
} from './index';

function makeRoute(providerId: string, overrides: Partial<RouteResult> = {}): RouteResult {
	return {
		providerId,
		providerName: providerId,
		providerModelName: 'model-x',
		upstreamProtocol: 'openai',
		providerEndpoints: { openai: { base: 'https://example.com/v1' } },
		providerApiKey: `sk-${providerId}`,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routeGroup: 'default',
		routePriority: 0,
		routeWeight: 1,
		...overrides,
	};
}

function mockRepos(globalStrategy: string | null): GatewayRepositories {
	return {
		systemConfig: {
			getConfig: async () => globalStrategy,
		},
	} as GatewayRepositories;
}

beforeEach(() => {
	resetRouteStrategyCacheForTests();
	resetWeightedRoundRobinStateForTests();
});

describe('buildAffinityKey / buildTierKeyPrefix', () => {
	it('builds stable keys without capability', () => {
		assert.equal(buildAffinityKey('u1', 'gpt', 'default', 'openai'), 'u1|gpt|default|openai');
		assert.equal(buildTierKeyPrefix('gpt', 'free', 'gemini'), 'gpt|free|gemini');
	});
});

describe('canonical strategy registry', () => {
	it('registers only canonical IDs and rejects legacy names', () => {
		assert.deepEqual(Object.keys(ROUTE_STRATEGIES).sort(), [
			'hash_affinity',
			'weight_priority',
			'weighted_random',
			'weighted_round_robin',
		]);
		for (const legacy of ['affinity', 'strict', 'round_robin'] as const) {
			assert.equal(isRouteStrategyName(legacy), false);
			assert.equal(Object.hasOwn(ROUTE_STRATEGIES, legacy), false);
		}
	});

	it('ignores legacy poolStrategy and falls through to global/default', async () => {
		assert.equal(
			await resolveRouteStrategy({
				routePolicyRaw: null,
				poolStrategy: 'affinity',
				protocol: 'openai',
				capability: 'chat',
				routeGroup: 'default',
				repos: mockRepos('hash_affinity'),
			}),
			'hash_affinity'
		);
		resetRouteStrategyCacheForTests();
		assert.equal(
			await resolveRouteStrategy({
				routePolicyRaw: JSON.stringify({ strategy: 'strict' }),
				protocol: 'openai',
				capability: 'chat',
				routeGroup: 'default',
				repos: mockRepos('weighted_round_robin'),
			}),
			'weighted_round_robin'
		);
	});
});

describe('weight_priority / weighted_round_robin ordering', () => {
	it('orders by weight DESC then providerId ASC', () => {
		const routes = [
			makeRoute('b', { routeWeight: 1 }),
			makeRoute('a', { routeWeight: 5 }),
			makeRoute('c', { routeWeight: 5 }),
		];
		const ordered = ROUTE_STRATEGIES.weight_priority(routes, {
			affinityKey: 'k',
			tierKey: 't|0',
		});
		assert.deepEqual(
			ordered.map((r) => r.providerId),
			['a', 'c', 'b']
		);
	});

	it('rotates weighted first choice across calls for the same tierKey', () => {
		const routes = [
			makeRoute('p1', { routeWeight: 2 }),
			makeRoute('p2', { routeWeight: 1 }),
		];
		const ctx = { affinityKey: 'k', tierKey: 'model|default|openai|0' };
		const firsts = [
			ROUTE_STRATEGIES.weighted_round_robin(routes, ctx)[0]!.providerId,
			ROUTE_STRATEGIES.weighted_round_robin(routes, ctx)[0]!.providerId,
			ROUTE_STRATEGIES.weighted_round_robin(routes, ctx)[0]!.providerId,
		];
		assert.deepEqual(firsts, ['p1', 'p1', 'p2']);
	});
});

describe('hash_affinity ordering', () => {
	it('is deterministic for the same affinityKey', () => {
		const routes = [makeRoute('p-a'), makeRoute('p-b'), makeRoute('p-c', { routeWeight: 3 })];
		const ctx = { affinityKey: 'user|model|default|openai', tierKey: 'model|default|openai|0' };
		const a = ROUTE_STRATEGIES.hash_affinity(routes, ctx);
		const b = ROUTE_STRATEGIES.hash_affinity(routes, ctx);
		assert.deepEqual(
			a.map((r) => r.providerId),
			b.map((r) => r.providerId)
		);
		const scores = a.map((r) => routeAffinityScore(ctx.affinityKey, r.providerId, r.routeWeight));
		for (let i = 1; i < scores.length; i++) {
			assert.ok(scores[i - 1]! >= scores[i]!);
		}
	});

	it('prefers higher weight when hashes are otherwise comparable via score formula', () => {
		const score1 = routeAffinityScore('k', 'provider', 1);
		const score5 = routeAffinityScore('k', 'provider', 5);
		assert.ok(score5 > score1);
		assert.equal(score5 / score1, 5);
	});
});

describe('resolveRouteStrategy five-level', () => {
	it('uses capability rule over protocol / model / global', async () => {
		const raw = JSON.stringify({
			strategy: 'hash_affinity',
			rules: {
				'openai:default': { strategy: 'weighted_random' },
				'openai.chat:default': { strategy: 'weight_priority' },
			},
		});
		const strategy = await resolveRouteStrategy({
			routePolicyRaw: raw,
			protocol: 'openai',
			capability: 'chat',
			routeGroup: 'default',
			repos: mockRepos('weighted_round_robin'),
		});
		assert.equal(strategy, 'weight_priority');
	});

	it('falls back to protocol rule then model strategy then global', async () => {
		const raw = JSON.stringify({
			strategy: 'hash_affinity',
			rules: {
				'openai:default': { strategy: 'weighted_random' },
			},
		});
		assert.equal(
			await resolveRouteStrategy({
				routePolicyRaw: raw,
				protocol: 'openai',
				capability: 'images.generations',
				routeGroup: 'default',
				repos: mockRepos('weighted_round_robin'),
			}),
			'weighted_random'
		);
		assert.equal(
			await resolveRouteStrategy({
				routePolicyRaw: JSON.stringify({ strategy: 'weight_priority' }),
				protocol: 'anthropic',
				capability: 'messages',
				routeGroup: 'default',
				repos: mockRepos('weighted_round_robin'),
			}),
			'weight_priority'
		);
		resetRouteStrategyCacheForTests();
		assert.equal(
			await resolveRouteStrategy({
				routePolicyRaw: null,
				protocol: 'openai',
				capability: 'chat',
				routeGroup: 'default',
				repos: mockRepos('weighted_round_robin'),
			}),
			'weighted_round_robin'
		);
		resetRouteStrategyCacheForTests();
		assert.equal(
			await resolveRouteStrategy({
				routePolicyRaw: null,
				protocol: 'openai',
				capability: 'chat',
				routeGroup: 'default',
				repos: mockRepos(null),
			}),
			'hash_affinity'
		);
	});

	it('aliases both legacy Gemini capability rules onto models.generate (generateContent wins)', async () => {
		const raw = JSON.stringify({
			rules: {
				'gemini.streamGenerateContent:default': { strategy: 'weighted_random' },
				'gemini.generateContent:default': { strategy: 'weight_priority' },
			},
		});
		const gen = await resolveRouteStrategy({
			routePolicyRaw: raw,
			protocol: 'gemini',
			capability: 'models.generate',
			routeGroup: 'default',
			repos: mockRepos('hash_affinity'),
		});
		const streamAlias = await resolveRouteStrategy({
			routePolicyRaw: raw,
			protocol: 'gemini',
			capability: 'streamGenerateContent',
			routeGroup: 'default',
			repos: mockRepos('hash_affinity'),
		});
		assert.equal(gen, 'weight_priority');
		assert.equal(streamAlias, 'weight_priority');
	});

	it('keeps same affinity order for generateContent and streamGenerateContent when policy is shared', async () => {
		const routes = [makeRoute('g1'), makeRoute('g2'), makeRoute('g3')];
		const affinityKey = buildAffinityKey('u', 'gemini-pro', 'default', 'gemini');
		const ctx = { affinityKey, tierKey: `${buildTierKeyPrefix('gemini-pro', 'default', 'gemini')}|0` };
		const orderGen = ROUTE_STRATEGIES.hash_affinity(routes, ctx).map((r) => r.providerId);
		const orderStream = ROUTE_STRATEGIES.hash_affinity(routes, ctx).map((r) => r.providerId);
		assert.deepEqual(orderGen, orderStream);
	});
});
