import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { GatewayRepositories } from '@octafuse/core';
import type { RouteResult } from './model-router';
import {
	hashAffinityKey,
	mergeStickyIntoAttempts,
	resolveStickySession,
	resolveStickyTrace,
	scheduleStickyBind,
	scheduleStickyTouchIfNeeded,
	shouldInvalidateStickyBinding,
	stickyMutationPromise,
} from './provider-sticky-routing';
import { resetProviderCircuitStateForTests, markProviderFailure } from './provider-circuit-breaker';

function makeRoute(targetId: string, providerId: string, priority = 0): RouteResult {
	return {
		targetId,
		modelSurfaceId: null,
		routePoolId: 'pool-1',
		providerId,
		providerName: providerId,
		providerModelName: 'm',
		upstreamProtocol: 'openai',
		upstreamOperation: 'chat',
		adapter: 'passthrough',
		providerEndpoints: { openai: { base: 'https://example.com/v1' } },
		providerApiKey: `sk-${providerId}`,
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routeGroup: 'default',
		routePriority: priority,
		routeWeight: 1,
	};
}

describe('provider-sticky-routing helpers', () => {
	it('hashes affinity keys stably with SHA-256 hex', async () => {
		const a = await hashAffinityKey('u|m|default|openai');
		const b = await hashAffinityKey('u|m|default|openai');
		assert.equal(a, b);
		assert.equal(a.length, 64);
	});

	it('merges sticky route to front and dedupes by targetId', () => {
		const a = makeRoute('t1', 'p1', 10);
		const b = makeRoute('t2', 'p2', 0);
		const merged = mergeStickyIntoAttempts([a, b], b);
		assert.deepEqual(
			merged.map((r) => r.targetId),
			['t2', 't1']
		);
	});

	it('invalidates sticky only on retry_key (not image abort / fail_immediately)', () => {
		assert.equal(shouldInvalidateStickyBinding({ action: 'retry_key' }), true);
		assert.equal(shouldInvalidateStickyBinding({ action: 'fail_immediately' }), false);
		assert.equal(
			shouldInvalidateStickyBinding({ action: 'retry_key' }, { imageAbort: true }),
			false
		);
	});
});

describe('resolveStickySession', () => {
	it('returns miss when disabled / no pool', async () => {
		const repos = {} as GatewayRepositories;
		const r1 = await resolveStickySession(repos, {
			routePoolId: null,
			affinityKey: 'k',
			config: { enabled: true, idleTtlSeconds: 3600, epoch: 0 },
			candidates: [makeRoute('t1', 'p1')],
		});
		assert.equal(r1.stickyRoute, null);

		const r2 = await resolveStickySession(repos, {
			routePoolId: 'pool-1',
			affinityKey: 'k',
			config: { enabled: false, idleTtlSeconds: 3600, epoch: 0 },
			candidates: [makeRoute('t1', 'p1')],
		});
		assert.equal(r2.session, null);
	});

	it('returns hit for valid binding and invalid_circuit when circuit-open', async () => {
		resetProviderCircuitStateForTests();
		const now = Date.now();
		const getBinding = mock.fn(async () => ({
			route_pool_id: 'pool-1',
			affinity_hash: 'x',
			route_target_id: 't2',
			binding_token: 'tok',
			pool_epoch: 1,
			expires_at: new Date(now + 60_000).toISOString(),
		}));
		const repos = {
			routePoolSticky: { getBinding },
		} as unknown as GatewayRepositories;
		const candidates = [makeRoute('t1', 'p1', 10), makeRoute('t2', 'p2', 0)];

		const hit = await resolveStickySession(repos, {
			routePoolId: 'pool-1',
			affinityKey: 'u|m|default|openai',
			config: { enabled: true, idleTtlSeconds: 3600, epoch: 1 },
			candidates,
			nowMs: now,
		});
		assert.equal(hit.session?.lookup, 'hit');
		assert.equal(hit.stickyRoute?.targetId, 't2');

		markProviderFailure('p2', 'rate_limit', 30_000);
		const invalid = await resolveStickySession(repos, {
			routePoolId: 'pool-1',
			affinityKey: 'u|m|default|openai',
			config: { enabled: true, idleTtlSeconds: 3600, epoch: 1 },
			candidates,
			nowMs: now,
		});
		assert.equal(invalid.session?.lookup, 'invalid_circuit');
		assert.equal(invalid.stickyRoute, null);
		assert.equal(invalid.session?.staleToken, null);
	});

	it('returns invalid_target with staleToken when bound target missing from candidates', async () => {
		const now = Date.now();
		const repos = {
			routePoolSticky: {
				getBinding: async () => ({
					route_pool_id: 'pool-1',
					affinity_hash: 'x',
					route_target_id: 'gone',
					binding_token: 'tok-stale',
					pool_epoch: 0,
					expires_at: new Date(now + 60_000).toISOString(),
				}),
			},
		} as unknown as GatewayRepositories;
		const result = await resolveStickySession(repos, {
			routePoolId: 'pool-1',
			affinityKey: 'k',
			config: { enabled: true, idleTtlSeconds: 3600, epoch: 0 },
			candidates: [makeRoute('t1', 'p1')],
			nowMs: now,
		});
		assert.equal(result.session?.lookup, 'invalid_target');
		assert.equal(result.session?.staleToken, 'tok-stale');
		assert.equal(result.stickyRoute, null);
	});

	it('fails open on storage errors', async () => {
		const repos = {
			routePoolSticky: {
				getBinding: async () => {
					throw new Error('d1 unavailable');
				},
			},
		} as unknown as GatewayRepositories;
		const result = await resolveStickySession(repos, {
			routePoolId: 'pool-1',
			affinityKey: 'k',
			config: { enabled: true, idleTtlSeconds: 3600, epoch: 0 },
			candidates: [makeRoute('t1', 'p1')],
		});
		assert.equal(result.stickyRoute, null);
		assert.equal(result.session?.result, 'storage_error');
	});

	it('treats expired and epoch-mismatched bindings as expired/invalid_epoch', async () => {
		const now = Date.now();
		const getBinding = mock.fn(async () => ({
			route_pool_id: 'pool-1',
			affinity_hash: 'x',
			route_target_id: 't1',
			binding_token: 'tok',
			pool_epoch: 0,
			expires_at: new Date(now - 1000).toISOString(),
		}));
		const repos = {
			routePoolSticky: { getBinding },
		} as unknown as GatewayRepositories;
		const expired = await resolveStickySession(repos, {
			routePoolId: 'pool-1',
			affinityKey: 'k',
			config: { enabled: true, idleTtlSeconds: 3600, epoch: 0 },
			candidates: [makeRoute('t1', 'p1')],
			nowMs: now,
		});
		assert.equal(expired.session?.lookup, 'expired');
		assert.equal(expired.stickyRoute, null);

		getBinding.mock.mockImplementation(async () => ({
			route_pool_id: 'pool-1',
			affinity_hash: 'x',
			route_target_id: 't1',
			binding_token: 'tok',
			pool_epoch: 1,
			expires_at: new Date(now + 60_000).toISOString(),
		}));
		const invalidEpoch = await resolveStickySession(repos, {
			routePoolId: 'pool-1',
			affinityKey: 'k',
			config: { enabled: true, idleTtlSeconds: 3600, epoch: 2 },
			candidates: [makeRoute('t1', 'p1')],
			nowMs: now,
		});
		assert.equal(invalidEpoch.session?.lookup, 'invalid_epoch');
	});

	it('throttles touch within 60s and fail-opens bind storage errors', async () => {
		const now = Date.now();
		const touchBinding = mock.fn(async () => true);
		const tryBind = mock.fn(async () => {
			throw new Error('write failed');
		});
		const writeRepos = {
			routePoolSticky: { touchBinding, tryBind },
		} as unknown as GatewayRepositories;

		const throttled = await resolveStickySession(
			{
				routePoolSticky: {
					getBinding: async () => ({
						route_pool_id: 'pool-1',
						affinity_hash: 'x',
						route_target_id: 't1',
						binding_token: 'tok',
						pool_epoch: 0,
						expires_at: new Date(now + 3600_000).toISOString(),
					}),
				},
			} as unknown as GatewayRepositories,
			{
				routePoolId: 'pool-1',
				affinityKey: 'k',
				config: { enabled: true, idleTtlSeconds: 3600, epoch: 0 },
				candidates: [makeRoute('t1', 'p1')],
				nowMs: now,
			}
		);
		assert.ok(throttled.session);
		scheduleStickyTouchIfNeeded(writeRepos, throttled.session!, now);
		assert.equal(touchBinding.mock.callCount(), 0);
		assert.equal(throttled.session!.result, 'kept');

		const missSession = (
			await resolveStickySession(
				{
					routePoolSticky: { getBinding: async () => null },
				} as unknown as GatewayRepositories,
				{
					routePoolId: 'pool-1',
					affinityKey: 'k2',
					config: { enabled: true, idleTtlSeconds: 3600, epoch: 0 },
					candidates: [makeRoute('t1', 'p1')],
					nowMs: now,
				}
			)
		).session!;
		assert.equal(missSession.lookup, 'miss');
		scheduleStickyBind(writeRepos, missSession, makeRoute('t1', 'p1'), { nowMs: now });
		await stickyMutationPromise(missSession);
		assert.equal(missSession.result, 'storage_error');
	});

	it('passes staleToken as expectedToken and sets attemptedTargetId on bind', async () => {
		const now = Date.now();
		const tryBind = mock.fn(async () => true);
		const repos = {
			routePoolSticky: { tryBind },
		} as unknown as GatewayRepositories;
		const session = (
			await resolveStickySession(
				{
					routePoolSticky: {
						getBinding: async () => ({
							route_pool_id: 'pool-1',
							affinity_hash: 'x',
							route_target_id: 'gone',
							binding_token: 'tok-stale',
							pool_epoch: 0,
							expires_at: new Date(now + 60_000).toISOString(),
						}),
					},
				} as unknown as GatewayRepositories,
				{
					routePoolId: 'pool-1',
					affinityKey: 'k',
					config: { enabled: true, idleTtlSeconds: 3600, epoch: 0 },
					candidates: [makeRoute('t1', 'p1')],
					nowMs: now,
				}
			)
		).session!;
		assert.equal(session.lookup, 'invalid_target');
		scheduleStickyBind(repos, session, makeRoute('t1', 'p1'), { nowMs: now, rebound: true });
		await stickyMutationPromise(session);
		assert.equal(session.result, 'rebound');
		assert.equal(session.attemptedTargetId, 't1');
		const args = tryBind.mock.calls[0]?.arguments[0] as { expectedToken?: string };
		assert.equal(args.expectedToken, 'tok-stale');
	});

	it('resolveStickyTrace waits for mutations before snapshotting result', async () => {
		const now = Date.now();
		let resolveBind!: (ok: boolean) => void;
		const tryBind = mock.fn(
			() =>
				new Promise<boolean>((resolve) => {
					resolveBind = resolve;
				})
		);
		const session = (
			await resolveStickySession(
				{
					routePoolSticky: { getBinding: async () => null },
				} as unknown as GatewayRepositories,
				{
					routePoolId: 'pool-1',
					affinityKey: 'k',
					config: { enabled: true, idleTtlSeconds: 3600, epoch: 0 },
					candidates: [makeRoute('t1', 'p1')],
					nowMs: now,
				}
			)
		).session!;
		scheduleStickyBind(
			{ routePoolSticky: { tryBind } } as unknown as GatewayRepositories,
			session,
			makeRoute('t1', 'p1'),
			{ nowMs: now }
		);
		assert.equal(session.result, 'bound');
		const tracePromise = resolveStickyTrace(session);
		resolveBind(false);
		const trace = await tracePromise;
		assert.equal(trace.result, 'unchanged');
		assert.equal(trace.attempted_target, 't1');
	});
});
