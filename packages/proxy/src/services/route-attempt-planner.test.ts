import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RouteResult } from './model-router';
import { buildRouteAttemptPlan } from './route-attempt-planner';
import { markProviderFailure, resetProviderCircuitStateForTests } from './provider-circuit-breaker';
import { resetRoundRobinStateForTests } from './route-strategies';

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
		providerKeyId: providerId,
		providerKeyLabel: providerId,
		providerKeyFingerprint: `…${providerId.slice(-4)}`,
		...overrides,
	};
}

beforeEach(() => {
	resetProviderCircuitStateForTests();
	resetRoundRobinStateForTests();
});

describe('buildRouteAttemptPlan', () => {
	it('orders higher priority tiers first', () => {
		const routes = [
			makeRoute('low', { routePriority: 1 }),
			makeRoute('high', { routePriority: 10 }),
		];
		const plan = buildRouteAttemptPlan(
			routes,
			{ affinityKey: 'u|m|default|openai', tierKeyPrefix: 'm|default|openai' },
			'strict'
		);
		assert.deepEqual(
			plan.attempts.map((r) => r.providerId),
			['high', 'low']
		);
	});

	it('skips circuit-open providers and tracks earliest retry', () => {
		const t0 = 1_000_000;
		markProviderFailure('p1', 'rate_limit', 8_000, t0);
		const routes = [makeRoute('p1'), makeRoute('p2')];
		const plan = buildRouteAttemptPlan(
			routes,
			{ affinityKey: 'u|m|default|openai', tierKeyPrefix: 'm|default|openai' },
			'strict',
			t0
		);
		assert.deepEqual(
			plan.attempts.map((r) => r.providerId),
			['p2']
		);
		assert.equal(plan.skippedByCircuit, 1);
		assert.equal(plan.earliestRetryAfterMs, 8_000);
	});

	it('returns empty attempts when all providers are circuit-open', () => {
		const t0 = 1_000_000;
		markProviderFailure('p1', 'rate_limit', 5_000, t0);
		const plan = buildRouteAttemptPlan(
			[makeRoute('p1')],
			{ affinityKey: 'u|m|default|openai', tierKeyPrefix: 'm|default|openai' },
			'affinity',
			t0
		);
		assert.equal(plan.attempts.length, 0);
		assert.equal(plan.skippedByCircuit, 1);
		assert.equal(plan.earliestRetryAfterMs, 5_000);
	});

	it('applies strict ordering within a tier by weight then providerId', () => {
		const routes = [
			makeRoute('b', { routeWeight: 1 }),
			makeRoute('a', { routeWeight: 5 }),
			makeRoute('c', { routeWeight: 5 }),
		];
		const plan = buildRouteAttemptPlan(
			routes,
			{ affinityKey: 'u|m|default|openai', tierKeyPrefix: 'm|default|openai' },
			'strict'
		);
		assert.deepEqual(
			plan.attempts.map((r) => r.providerId),
			['a', 'c', 'b']
		);
	});

	describe('preferInTier', () => {
		/** 直通 provider 显式声明 responses endpoint；chat-only 只有 base。 */
		const native = (id: string, overrides: Partial<RouteResult> = {}): RouteResult =>
			makeRoute(id, {
				providerEndpoints: {
					openai: {
						base: 'https://example.com/v1',
						endpoints: { responses: 'https://example.com/v1/responses' },
					},
				},
				...overrides,
			});
		const prefersResponses = (route: RouteResult): boolean =>
			Boolean(route.providerEndpoints.openai?.endpoints?.responses);

		it('moves preferred routes ahead within the same tier', () => {
			const routes = [makeRoute('chat-only'), native('passthrough')];
			const plan = buildRouteAttemptPlan(
				routes,
				{
					affinityKey: 'u|m|default|openai',
					tierKeyPrefix: 'm|default|openai',
					preferInTier: prefersResponses,
				},
				'strict'
			);
			assert.deepEqual(
				plan.attempts.map((r) => r.providerId),
				['passthrough', 'chat-only']
			);
		});

		it('never lets a preferred route jump a higher priority tier', () => {
			// admin 把 chat-only 配成高优先级：偏好不得跨层，否则等于覆盖 admin 配置。
			const routes = [
				native('low-native', { routePriority: 1 }),
				makeRoute('high-chat-only', { routePriority: 10 }),
			];
			const plan = buildRouteAttemptPlan(
				routes,
				{
					affinityKey: 'u|m|default|openai',
					tierKeyPrefix: 'm|default|openai',
					preferInTier: prefersResponses,
				},
				'strict'
			);
			assert.deepEqual(
				plan.attempts.map((r) => r.providerId),
				['high-chat-only', 'low-native']
			);
		});

		it('keeps strategy order inside each partition', () => {
			const routes = [
				makeRoute('chat-low', { routeWeight: 1 }),
				native('native-low', { routeWeight: 1 }),
				native('native-high', { routeWeight: 9 }),
				makeRoute('chat-high', { routeWeight: 9 }),
			];
			const plan = buildRouteAttemptPlan(
				routes,
				{
					affinityKey: 'u|m|default|openai',
					tierKeyPrefix: 'm|default|openai',
					preferInTier: prefersResponses,
				},
				'strict'
			);
			// strict = weight DESC, 然后 providerId；分区稳定，故各分区内仍是 high 在前。
			assert.deepEqual(
				plan.attempts.map((r) => r.providerId),
				['native-high', 'native-low', 'chat-high', 'chat-low']
			);
		});

		it('is a no-op when every route matches or none do', () => {
			const ctx = {
				affinityKey: 'u|m|default|openai',
				tierKeyPrefix: 'm|default|openai',
				preferInTier: prefersResponses,
			};
			const allNative = buildRouteAttemptPlan(
				[native('a', { routeWeight: 9 }), native('b', { routeWeight: 1 })],
				ctx,
				'strict'
			);
			assert.deepEqual(
				allNative.attempts.map((r) => r.providerId),
				['a', 'b']
			);
			const noneNative = buildRouteAttemptPlan(
				[makeRoute('a', { routeWeight: 9 }), makeRoute('b', { routeWeight: 1 })],
				ctx,
				'strict'
			);
			assert.deepEqual(
				noneNative.attempts.map((r) => r.providerId),
				['a', 'b']
			);
		});

		it('still skips circuit-open providers in the preferred partition', () => {
			const t0 = 1_000_000;
			markProviderFailure('native-open', 'rate_limit', 7_000, t0);
			const plan = buildRouteAttemptPlan(
				[native('native-open'), makeRoute('chat-ok')],
				{
					affinityKey: 'u|m|default|openai',
					tierKeyPrefix: 'm|default|openai',
					preferInTier: prefersResponses,
				},
				'strict',
				t0
			);
			assert.deepEqual(
				plan.attempts.map((r) => r.providerId),
				['chat-ok']
			);
			assert.equal(plan.skippedByCircuit, 1);
		});
	});
});
