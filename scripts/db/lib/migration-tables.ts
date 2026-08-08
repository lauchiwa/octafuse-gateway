// Order matters: parents before children, so inserts never violate a foreign key.
// `route_pools` / `model_surfaces` (migration 0018) reference `models`, and
// `model_routes.route_pool_id` references `route_pools`, so both sit between them.
// `route_pool_sticky_bindings` (migration 0022) has FKs to BOTH `route_pools` and
// `model_routes`, so it must come after both.
export const ETL_TABLE_ORDER = [
	'users',
	'api_keys',
	'providers',
	'models',
	'model_tags',
	'route_pools',
	'model_surfaces',
	'model_routes',
	'route_pool_sticky_bindings',
	'api_key_request_logs',
	'system_config',
	'user_audit_logs',
] as const;

export type EtlTableName = (typeof ETL_TABLE_ORDER)[number];

export const ETL_TABLES_TO_TRUNCATE = [...ETL_TABLE_ORDER].reverse();

export const TABLE_CONFLICT_KEYS: Record<EtlTableName, string[]> = {
	users: ['id'],
	api_keys: ['id'],
	providers: ['id'],
	models: ['id'],
	model_tags: ['model_id', 'tag'],
	route_pools: ['id'],
	model_surfaces: ['id'],
	model_routes: ['id'],
	// 复合主键（见 0022 迁移），不是单列 id。
	route_pool_sticky_bindings: ['route_pool_id', 'affinity_hash'],
	api_key_request_logs: ['id'],
	system_config: ['key'],
	user_audit_logs: ['id'],
};
