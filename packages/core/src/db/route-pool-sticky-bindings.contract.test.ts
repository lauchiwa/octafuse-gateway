/**
 * In-memory contract for RoutePoolStickyBindingsRepository CAS semantics
 * (shared by D1 / Postgres / MySQL SQL implementations).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RoutePoolStickyBindingsRepository } from '../storage/gateway-repository-interfaces';
import type { RoutePoolStickyBindingRow } from './route-pool-sticky-types';

type MemoryStickyRepo = RoutePoolStickyBindingsRepository & {
	setPoolEpoch(poolId: string, epoch: number): void;
	bumpPoolEpoch(poolId: string): number;
};

function createMemoryStickyBindingsRepository(): MemoryStickyRepo {
	const rows = new Map<string, RoutePoolStickyBindingRow>();
	const poolEpochs = new Map<string, number>();
	const keyOf = (poolId: string, hash: string) => `${poolId}\0${hash}`;
	const epochOf = (poolId: string) => poolEpochs.get(poolId) ?? 0;

	return {
		setPoolEpoch(poolId, epoch) {
			poolEpochs.set(poolId, epoch);
		},
		bumpPoolEpoch(poolId) {
			const next = epochOf(poolId) + 1;
			poolEpochs.set(poolId, next);
			return next;
		},

		async getBinding(routePoolId, affinityHash) {
			return rows.get(keyOf(routePoolId, affinityHash)) ?? null;
		},

		async tryBind(params) {
			const key = keyOf(params.routePoolId, params.affinityHash);
			const existing = rows.get(key);
			const nowMs = Date.parse(params.nowIso);
			const expectedToken = params.expectedToken?.trim() || '';
			if (existing) {
				const expired = Date.parse(existing.expires_at) <= nowMs;
				const epochMismatch = existing.pool_epoch !== params.poolEpoch;
				const tokenMatch = expectedToken !== '' && existing.binding_token === expectedToken;
				if (!expired && !epochMismatch && !tokenMatch) return false;
			}
			const stamp = new Date().toISOString();
			rows.set(key, {
				route_pool_id: params.routePoolId,
				affinity_hash: params.affinityHash,
				route_target_id: params.routeTargetId,
				binding_token: params.bindingToken,
				pool_epoch: params.poolEpoch,
				expires_at: params.expiresAt,
				created_at: existing?.created_at ?? stamp,
				updated_at: stamp,
			});
			return true;
		},

		async touchBinding(params) {
			const key = keyOf(params.routePoolId, params.affinityHash);
			const existing = rows.get(key);
			if (!existing || existing.binding_token !== params.expectedToken) return false;
			rows.set(key, {
				...existing,
				expires_at: params.expiresAt,
				updated_at: new Date().toISOString(),
			});
			return true;
		},

		async clearBinding(params) {
			const key = keyOf(params.routePoolId, params.affinityHash);
			const existing = rows.get(key);
			if (!existing || existing.binding_token !== params.expectedToken) return false;
			rows.delete(key);
			return true;
		},

		async forceClearBinding(params) {
			const key = keyOf(params.routePoolId, params.affinityHash);
			if (!rows.has(key)) return false;
			rows.delete(key);
			return true;
		},

		async listBindingTargetCounts(routePoolId, nowIso) {
			const nowMs = Date.parse(nowIso);
			const epoch = epochOf(routePoolId);
			const byTarget = new Map<string, { active_count: number; last_updated_at: string | null }>();
			for (const row of rows.values()) {
				if (row.route_pool_id !== routePoolId) continue;
				if (row.pool_epoch !== epoch) continue;
				if (Date.parse(row.expires_at) <= nowMs) continue;
				const cur = byTarget.get(row.route_target_id) ?? {
					active_count: 0,
					last_updated_at: null,
				};
				cur.active_count += 1;
				const updated = row.updated_at ?? null;
				if (
					updated &&
					(!cur.last_updated_at || Date.parse(updated) > Date.parse(cur.last_updated_at))
				) {
					cur.last_updated_at = updated;
				}
				byTarget.set(row.route_target_id, cur);
			}
			return [...byTarget.entries()]
				.map(([route_target_id, v]) => ({
					route_target_id,
					active_count: v.active_count,
					last_updated_at: v.last_updated_at,
				}))
				.sort(
					(a, b) =>
						b.active_count - a.active_count ||
						a.route_target_id.localeCompare(b.route_target_id)
				);
		},

		async countStaleBindings(routePoolId, nowIso) {
			const nowMs = Date.parse(nowIso);
			const epoch = epochOf(routePoolId);
			let n = 0;
			for (const row of rows.values()) {
				if (row.route_pool_id !== routePoolId) continue;
				if (Date.parse(row.expires_at) <= nowMs || row.pool_epoch !== epoch) n += 1;
			}
			return n;
		},

		async deleteStaleBefore(cutoffIso, limit) {
			const cutoffMs = Date.parse(cutoffIso);
			let removed = 0;
			for (const [key, row] of [...rows.entries()]) {
				if (removed >= limit) break;
				const epoch = epochOf(row.route_pool_id);
				const expired = Date.parse(row.expires_at) < cutoffMs;
				const epochMismatch = row.pool_epoch !== epoch;
				if (expired || epochMismatch) {
					rows.delete(key);
					removed += 1;
				}
			}
			return removed;
		},
	};
}

describe('route-pool-sticky-bindings CAS contract', () => {
	it('first concurrent bind wins; later bind cannot overwrite fresh binding', async () => {
		const repo = createMemoryStickyBindingsRepository();
		const nowIso = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 3600_000).toISOString();
		const base = {
			routePoolId: 'pool-1',
			affinityHash: 'hash-a',
			poolEpoch: 1,
			expiresAt,
			nowIso,
		};

		const [a, b] = await Promise.all([
			repo.tryBind({ ...base, routeTargetId: 't1', bindingToken: 'tok-a' }),
			repo.tryBind({ ...base, routeTargetId: 't2', bindingToken: 'tok-b' }),
		]);
		assert.equal(a || b, true);
		assert.equal(a && b, false);
		const row = await repo.getBinding('pool-1', 'hash-a');
		assert.ok(row);
		assert.ok(row.route_target_id === 't1' || row.route_target_id === 't2');
		assert.equal(
			await repo.tryBind({ ...base, routeTargetId: 't3', bindingToken: 'tok-c' }),
			false
		);
		const after = await repo.getBinding('pool-1', 'hash-a');
		assert.equal(after?.route_target_id, row.route_target_id);
	});

	it('allows replace when expired or epoch mismatched', async () => {
		const repo = createMemoryStickyBindingsRepository();
		const past = new Date(Date.now() - 1000).toISOString();
		const future = new Date(Date.now() + 3600_000).toISOString();
		const nowIso = new Date().toISOString();

		assert.equal(
			await repo.tryBind({
				routePoolId: 'pool-1',
				affinityHash: 'h',
				routeTargetId: 't1',
				bindingToken: 'tok-1',
				poolEpoch: 0,
				expiresAt: past,
				nowIso,
			}),
			true
		);
		assert.equal(
			await repo.tryBind({
				routePoolId: 'pool-1',
				affinityHash: 'h',
				routeTargetId: 't2',
				bindingToken: 'tok-2',
				poolEpoch: 0,
				expiresAt: future,
				nowIso,
			}),
			true
		);
		assert.equal((await repo.getBinding('pool-1', 'h'))?.route_target_id, 't2');

		assert.equal(
			await repo.tryBind({
				routePoolId: 'pool-1',
				affinityHash: 'h',
				routeTargetId: 't3',
				bindingToken: 'tok-3',
				poolEpoch: 2,
				expiresAt: future,
				nowIso,
			}),
			true
		);
		assert.equal((await repo.getBinding('pool-1', 'h'))?.binding_token, 'tok-3');
	});

	it('touch and clear require matching binding_token', async () => {
		const repo = createMemoryStickyBindingsRepository();
		const nowIso = new Date().toISOString();
		const expiresAt = new Date(Date.now() + 3600_000).toISOString();
		await repo.tryBind({
			routePoolId: 'pool-1',
			affinityHash: 'h',
			routeTargetId: 't1',
			bindingToken: 'tok-1',
			poolEpoch: 0,
			expiresAt,
			nowIso,
		});

		assert.equal(
			await repo.touchBinding({
				routePoolId: 'pool-1',
				affinityHash: 'h',
				expectedToken: 'wrong',
				expiresAt: new Date(Date.now() + 7200_000).toISOString(),
				nowIso,
			}),
			false
		);
		assert.equal(
			await repo.touchBinding({
				routePoolId: 'pool-1',
				affinityHash: 'h',
				expectedToken: 'tok-1',
				expiresAt: new Date(Date.now() + 7200_000).toISOString(),
				nowIso,
			}),
			true
		);
		assert.equal(
			await repo.clearBinding({
				routePoolId: 'pool-1',
				affinityHash: 'h',
				expectedToken: 'wrong',
			}),
			false
		);
		assert.equal(
			await repo.clearBinding({
				routePoolId: 'pool-1',
				affinityHash: 'h',
				expectedToken: 'tok-1',
			}),
			true
		);
		assert.equal(await repo.getBinding('pool-1', 'h'), null);
	});

	it('allows replace when expectedToken matches a still-valid row', async () => {
		const repo = createMemoryStickyBindingsRepository();
		const nowIso = new Date().toISOString();
		const future = new Date(Date.now() + 3600_000).toISOString();
		assert.equal(
			await repo.tryBind({
				routePoolId: 'pool-1',
				affinityHash: 'h',
				routeTargetId: 't1',
				bindingToken: 'tok-1',
				poolEpoch: 0,
				expiresAt: future,
				nowIso,
			}),
			true
		);
		assert.equal(
			await repo.tryBind({
				routePoolId: 'pool-1',
				affinityHash: 'h',
				routeTargetId: 't2',
				bindingToken: 'tok-2',
				poolEpoch: 0,
				expiresAt: future,
				nowIso,
				expectedToken: 'wrong',
			}),
			false
		);
		assert.equal(
			await repo.tryBind({
				routePoolId: 'pool-1',
				affinityHash: 'h',
				routeTargetId: 't2',
				bindingToken: 'tok-2',
				poolEpoch: 0,
				expiresAt: future,
				nowIso,
				expectedToken: 'tok-1',
			}),
			true
		);
		const row = await repo.getBinding('pool-1', 'h');
		assert.equal(row?.route_target_id, 't2');
		assert.equal(row?.binding_token, 'tok-2');
	});

	it('deleteStaleBefore only removes expired rows up to limit', async () => {
		const repo = createMemoryStickyBindingsRepository();
		const nowIso = new Date().toISOString();
		const past = new Date(Date.now() - 10_000).toISOString();
		const future = new Date(Date.now() + 3600_000).toISOString();
		await repo.tryBind({
			routePoolId: 'pool-1',
			affinityHash: 'old-1',
			routeTargetId: 't1',
			bindingToken: 'a',
			poolEpoch: 0,
			expiresAt: past,
			nowIso: past,
		});
		await repo.tryBind({
			routePoolId: 'pool-1',
			affinityHash: 'old-2',
			routeTargetId: 't2',
			bindingToken: 'b',
			poolEpoch: 0,
			expiresAt: past,
			nowIso: past,
		});
		await repo.tryBind({
			routePoolId: 'pool-1',
			affinityHash: 'fresh',
			routeTargetId: 't3',
			bindingToken: 'c',
			poolEpoch: 0,
			expiresAt: future,
			nowIso,
		});

		const removed = await repo.deleteStaleBefore(nowIso, 1);
		assert.equal(removed, 1);
		const remainingStale =
			Number(Boolean(await repo.getBinding('pool-1', 'old-1'))) +
			Number(Boolean(await repo.getBinding('pool-1', 'old-2')));
		assert.equal(remainingStale, 1);
		assert.ok(await repo.getBinding('pool-1', 'fresh'));
	});

	it('forceClearBinding deletes without token CAS', async () => {
		const repo = createMemoryStickyBindingsRepository();
		const nowIso = new Date().toISOString();
		const future = new Date(Date.now() + 3600_000).toISOString();
		await repo.tryBind({
			routePoolId: 'pool-1',
			affinityHash: 'h',
			routeTargetId: 't1',
			bindingToken: 'tok-1',
			poolEpoch: 0,
			expiresAt: future,
			nowIso,
		});
		assert.equal(await repo.forceClearBinding({ routePoolId: 'pool-1', affinityHash: 'h' }), true);
		assert.equal(await repo.getBinding('pool-1', 'h'), null);
		assert.equal(await repo.forceClearBinding({ routePoolId: 'pool-1', affinityHash: 'h' }), false);
	});

	it('listBindingTargetCounts ignores expired and epoch-mismatched rows', async () => {
		const repo = createMemoryStickyBindingsRepository();
		const nowIso = new Date().toISOString();
		const past = new Date(Date.now() - 1000).toISOString();
		const future = new Date(Date.now() + 3600_000).toISOString();
		repo.setPoolEpoch('pool-1', 1);

		await repo.tryBind({
			routePoolId: 'pool-1',
			affinityHash: 'a',
			routeTargetId: 't1',
			bindingToken: 'tok-a',
			poolEpoch: 1,
			expiresAt: future,
			nowIso,
		});
		await repo.tryBind({
			routePoolId: 'pool-1',
			affinityHash: 'b',
			routeTargetId: 't1',
			bindingToken: 'tok-b',
			poolEpoch: 1,
			expiresAt: future,
			nowIso,
		});
		await repo.tryBind({
			routePoolId: 'pool-1',
			affinityHash: 'c',
			routeTargetId: 't2',
			bindingToken: 'tok-c',
			poolEpoch: 1,
			expiresAt: past,
			nowIso,
		});
		await repo.tryBind({
			routePoolId: 'pool-1',
			affinityHash: 'd',
			routeTargetId: 't2',
			bindingToken: 'tok-d',
			poolEpoch: 0,
			expiresAt: future,
			nowIso,
		});
		// tryBind with poolEpoch 0 would reset tracked epoch; restore current pool epoch.
		repo.setPoolEpoch('pool-1', 1);

		const counts = await repo.listBindingTargetCounts('pool-1', nowIso);
		assert.deepEqual(counts.map((r) => ({ id: r.route_target_id, n: r.active_count })), [
			{ id: 't1', n: 2 },
		]);
		assert.equal(await repo.countStaleBindings('pool-1', nowIso), 2);
	});

	it('bumping pool epoch zeroes active summary until rebound', async () => {
		const repo = createMemoryStickyBindingsRepository();
		const nowIso = new Date().toISOString();
		const future = new Date(Date.now() + 3600_000).toISOString();
		repo.setPoolEpoch('pool-1', 3);
		await repo.tryBind({
			routePoolId: 'pool-1',
			affinityHash: 'a',
			routeTargetId: 't1',
			bindingToken: 'tok-a',
			poolEpoch: 3,
			expiresAt: future,
			nowIso,
		});
		assert.equal((await repo.listBindingTargetCounts('pool-1', nowIso))[0]?.active_count, 1);
		const next = repo.bumpPoolEpoch('pool-1');
		assert.equal(next, 4);
		assert.deepEqual(await repo.listBindingTargetCounts('pool-1', nowIso), []);
		assert.equal(await repo.countStaleBindings('pool-1', nowIso), 1);
	});
});
