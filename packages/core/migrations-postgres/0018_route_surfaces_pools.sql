-- Route topology v2. Historical rows are preserved through wildcard surfaces.
SET search_path TO octafuse_gateway;

CREATE TABLE IF NOT EXISTS route_pools (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  route_group TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  strategy TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS model_surfaces (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  route_group TEXT NOT NULL DEFAULT 'default',
  request_protocol TEXT NOT NULL,
  request_operation TEXT NOT NULL DEFAULT '*',
  route_pool_id TEXT NOT NULL REFERENCES route_pools(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (model_id, route_group, request_protocol, request_operation)
);

CREATE INDEX IF NOT EXISTS idx_model_surfaces_pool ON model_surfaces(route_pool_id);
CREATE INDEX IF NOT EXISTS idx_route_pools_model_group ON route_pools(model_id, route_group);

ALTER TABLE model_routes ADD COLUMN IF NOT EXISTS route_pool_id TEXT REFERENCES route_pools(id);
ALTER TABLE model_routes ADD COLUMN IF NOT EXISTS upstream_operation TEXT NOT NULL DEFAULT '*';
ALTER TABLE model_routes ADD COLUMN IF NOT EXISTS adapter TEXT NOT NULL DEFAULT 'passthrough';

INSERT INTO route_pools (
  id, model_id, route_group, name, strategy, status, created_at, updated_at
)
SELECT
  'legacy_pool_' || md5(
    model_id || chr(31) ||
    lower(COALESCE(NULLIF(btrim(route_group), ''), 'default')) || chr(31) ||
    lower(upstream_protocol)
  ),
  model_id,
  COALESCE(NULLIF(btrim(route_group), ''), 'default'),
  initcap(lower(upstream_protocol)) || ' · ' ||
    COALESCE(NULLIF(btrim(route_group), ''), 'default'),
  NULL,
  'active',
  MIN(COALESCE(created_at, CURRENT_TIMESTAMP)),
  CURRENT_TIMESTAMP
FROM model_routes
GROUP BY
  model_id,
  lower(COALESCE(NULLIF(btrim(route_group), ''), 'default')),
  COALESCE(NULLIF(btrim(route_group), ''), 'default'),
  lower(upstream_protocol)
ON CONFLICT (id) DO NOTHING;

INSERT INTO model_surfaces (
  id, model_id, route_group, request_protocol, request_operation,
  route_pool_id, status, created_at, updated_at
)
SELECT
  'legacy_surface_' || md5(
    model_id || chr(31) ||
    lower(COALESCE(NULLIF(btrim(route_group), ''), 'default')) || chr(31) ||
    lower(upstream_protocol) || chr(31) || '*'
  ),
  model_id,
  COALESCE(NULLIF(btrim(route_group), ''), 'default'),
  lower(upstream_protocol),
  '*',
  'legacy_pool_' || md5(
    model_id || chr(31) ||
    lower(COALESCE(NULLIF(btrim(route_group), ''), 'default')) || chr(31) ||
    lower(upstream_protocol)
  ),
  'active',
  MIN(COALESCE(created_at, CURRENT_TIMESTAMP)),
  CURRENT_TIMESTAMP
FROM model_routes
GROUP BY
  model_id,
  lower(COALESCE(NULLIF(btrim(route_group), ''), 'default')),
  COALESCE(NULLIF(btrim(route_group), ''), 'default'),
  lower(upstream_protocol)
ON CONFLICT (model_id, route_group, request_protocol, request_operation) DO NOTHING;

UPDATE model_routes
SET route_pool_id =
  'legacy_pool_' || md5(
    model_id || chr(31) ||
    lower(COALESCE(NULLIF(btrim(route_group), ''), 'default')) || chr(31) ||
    lower(upstream_protocol)
  )
WHERE route_pool_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_model_routes_pool_status_priority
  ON model_routes(route_pool_id, status, priority);

ALTER TABLE api_key_request_logs ADD COLUMN IF NOT EXISTS request_operation TEXT;
ALTER TABLE api_key_request_logs ADD COLUMN IF NOT EXISTS model_surface_id TEXT;
ALTER TABLE api_key_request_logs ADD COLUMN IF NOT EXISTS route_pool_id TEXT;
ALTER TABLE api_key_request_logs ADD COLUMN IF NOT EXISTS route_target_id TEXT;
ALTER TABLE api_key_request_logs ADD COLUMN IF NOT EXISTS upstream_operation TEXT;
ALTER TABLE api_key_request_logs ADD COLUMN IF NOT EXISTS adapter TEXT;
ALTER TABLE api_key_request_logs ADD COLUMN IF NOT EXISTS route_trace TEXT;

CREATE INDEX IF NOT EXISTS idx_request_logs_surface_created
  ON api_key_request_logs(model_surface_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_pool_created
  ON api_key_request_logs(route_pool_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_target_created
  ON api_key_request_logs(route_target_id, created_at);
