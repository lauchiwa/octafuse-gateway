/**
 * Postgres：`route_pool_sticky_bindings` with token / expiry CAS.
 */
import type { PostgresDatabaseClient } from '../../storage/database-client';
import type { RoutePoolStickyBindingsRepository } from '../../storage/gateway-repository-interfaces';
import type {
	RoutePoolStickyBindingRow,
	RoutePoolStickyBindingTargetCount,
} from '../route-pool-sticky-types';

export function createPostgresRoutePoolStickyBindingsRepository(
	db: PostgresDatabaseClient
): RoutePoolStickyBindingsRepository {
	const pg = db.raw;
	return {
		async getBinding(routePoolId, affinityHash): Promise<RoutePoolStickyBindingRow | null> {
			const rows = await pg<RoutePoolStickyBindingRow[]>`
				SELECT route_pool_id, affinity_hash, route_target_id, binding_token,
					pool_epoch, expires_at::text AS expires_at,
					created_at::text AS created_at, updated_at::text AS updated_at
				FROM route_pool_sticky_bindings
				WHERE route_pool_id = ${routePoolId} AND affinity_hash = ${affinityHash}
				LIMIT 1
			`;
			return rows[0] ?? null;
		},

		async tryBind(params): Promise<boolean> {
			const expectedToken = params.expectedToken?.trim() || '';
			const rows = await pg<Array<{ route_pool_id: string }>>`
				INSERT INTO route_pool_sticky_bindings (
					route_pool_id, affinity_hash, route_target_id, binding_token,
					pool_epoch, expires_at, created_at, updated_at
				) VALUES (
					${params.routePoolId}, ${params.affinityHash}, ${params.routeTargetId},
					${params.bindingToken}, ${params.poolEpoch}, ${params.expiresAt}::timestamptz,
					CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
				)
				ON CONFLICT (route_pool_id, affinity_hash) DO UPDATE SET
					route_target_id = EXCLUDED.route_target_id,
					binding_token = EXCLUDED.binding_token,
					pool_epoch = EXCLUDED.pool_epoch,
					expires_at = EXCLUDED.expires_at,
					updated_at = CURRENT_TIMESTAMP
				WHERE route_pool_sticky_bindings.expires_at <= ${params.nowIso}::timestamptz
				   OR route_pool_sticky_bindings.pool_epoch <> EXCLUDED.pool_epoch
				   OR (${expectedToken} <> '' AND route_pool_sticky_bindings.binding_token = ${expectedToken})
				RETURNING route_pool_id
			`;
			return rows.length > 0;
		},

		async touchBinding(params): Promise<boolean> {
			const rows = await pg<Array<{ route_pool_id: string }>>`
				UPDATE route_pool_sticky_bindings
				SET expires_at = ${params.expiresAt}::timestamptz,
					updated_at = CURRENT_TIMESTAMP
				WHERE route_pool_id = ${params.routePoolId}
				  AND affinity_hash = ${params.affinityHash}
				  AND binding_token = ${params.expectedToken}
				RETURNING route_pool_id
			`;
			return rows.length > 0;
		},

		async clearBinding(params): Promise<boolean> {
			const rows = await pg<Array<{ route_pool_id: string }>>`
				DELETE FROM route_pool_sticky_bindings
				WHERE route_pool_id = ${params.routePoolId}
				  AND affinity_hash = ${params.affinityHash}
				  AND binding_token = ${params.expectedToken}
				RETURNING route_pool_id
			`;
			return rows.length > 0;
		},

		async forceClearBinding(params): Promise<boolean> {
			const rows = await pg<Array<{ route_pool_id: string }>>`
				DELETE FROM route_pool_sticky_bindings
				WHERE route_pool_id = ${params.routePoolId}
				  AND affinity_hash = ${params.affinityHash}
				RETURNING route_pool_id
			`;
			return rows.length > 0;
		},

		async listBindingTargetCounts(
			routePoolId,
			nowIso
		): Promise<RoutePoolStickyBindingTargetCount[]> {
			const rows = await pg<
				Array<{
					route_target_id: string;
					active_count: number | string;
					last_updated_at: string | null;
				}>
			>`
				SELECT b.route_target_id AS route_target_id,
					COUNT(*)::int AS active_count,
					MAX(b.updated_at)::text AS last_updated_at
				FROM route_pool_sticky_bindings b
				JOIN route_pools p ON p.id = b.route_pool_id
				WHERE b.route_pool_id = ${routePoolId}
				  AND b.pool_epoch = p.sticky_epoch
				  AND b.expires_at > ${nowIso}::timestamptz
				GROUP BY b.route_target_id
				ORDER BY active_count DESC, b.route_target_id ASC
			`;
			return rows.map((r) => ({
				route_target_id: r.route_target_id,
				active_count: Number(r.active_count) || 0,
				last_updated_at: r.last_updated_at ?? null,
			}));
		},

		async countStaleBindings(routePoolId, nowIso): Promise<number> {
			const rows = await pg<Array<{ cnt: number | string }>>`
				SELECT COUNT(*)::int AS cnt
				FROM route_pool_sticky_bindings b
				JOIN route_pools p ON p.id = b.route_pool_id
				WHERE b.route_pool_id = ${routePoolId}
				  AND (b.expires_at <= ${nowIso}::timestamptz OR b.pool_epoch <> p.sticky_epoch)
			`;
			return Number(rows[0]?.cnt) || 0;
		},

		async deleteStaleBefore(cutoffIso, limit): Promise<number> {
			const rows = await pg<Array<{ route_pool_id: string }>>`
				DELETE FROM route_pool_sticky_bindings
				WHERE ctid IN (
					SELECT b.ctid FROM route_pool_sticky_bindings b
					LEFT JOIN route_pools p ON p.id = b.route_pool_id
					WHERE b.expires_at < ${cutoffIso}::timestamptz
					   OR (p.id IS NOT NULL AND b.pool_epoch <> p.sticky_epoch)
					LIMIT ${limit}
				)
				RETURNING route_pool_id
			`;
			return rows.length;
		},
	};
}
