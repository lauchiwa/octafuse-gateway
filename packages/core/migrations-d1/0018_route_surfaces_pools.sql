-- Route topology v2: public request surfaces -> route pools -> upstream targets.
--
-- Compatibility strategy:
-- - Every historical protocol/group target set becomes one pool.
-- - Every pool receives a wildcard (`request_operation = '*'`) surface.
-- - Runtime resolves an exact operation first and then falls back to `*`.
-- This preserves Chat / Images / Audio / Gemini behavior without guessing a
-- historical route's capability, while allowing new installations to split
-- operations into independent pools later.

CREATE TABLE route_pools (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  route_group TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  strategy TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE model_surfaces (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  route_group TEXT NOT NULL DEFAULT 'default',
  request_protocol TEXT NOT NULL,
  request_operation TEXT NOT NULL DEFAULT '*',
  route_pool_id TEXT NOT NULL REFERENCES route_pools(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX uk_model_surfaces_lookup
  ON model_surfaces(model_id, route_group, request_protocol, request_operation);
CREATE INDEX idx_model_surfaces_pool ON model_surfaces(route_pool_id);
CREATE INDEX idx_route_pools_model_group ON route_pools(model_id, route_group);

ALTER TABLE model_routes ADD COLUMN route_pool_id TEXT REFERENCES route_pools(id);
ALTER TABLE model_routes ADD COLUMN upstream_operation TEXT NOT NULL DEFAULT '*';
ALTER TABLE model_routes ADD COLUMN adapter TEXT NOT NULL DEFAULT 'passthrough';

INSERT OR IGNORE INTO route_pools (
  id, model_id, route_group, name, strategy, status, created_at, updated_at
)
SELECT
  'legacy_pool_' || hex(
    model_id || char(31) ||
    lower(COALESCE(NULLIF(trim(route_group), ''), 'default')) || char(31) ||
    lower(upstream_protocol)
  ),
  model_id,
  COALESCE(NULLIF(trim(route_group), ''), 'default'),
  upper(substr(upstream_protocol, 1, 1)) || substr(upstream_protocol, 2) ||
    ' · ' || COALESCE(NULLIF(trim(route_group), ''), 'default'),
  NULL,
  'active',
  MIN(COALESCE(created_at, datetime('now'))),
  datetime('now')
FROM model_routes
GROUP BY
  model_id,
  lower(COALESCE(NULLIF(trim(route_group), ''), 'default')),
  lower(upstream_protocol);

INSERT OR IGNORE INTO model_surfaces (
  id, model_id, route_group, request_protocol, request_operation,
  route_pool_id, status, created_at, updated_at
)
SELECT
  'legacy_surface_' || hex(
    model_id || char(31) ||
    lower(COALESCE(NULLIF(trim(route_group), ''), 'default')) || char(31) ||
    lower(upstream_protocol) || char(31) || '*'
  ),
  model_id,
  COALESCE(NULLIF(trim(route_group), ''), 'default'),
  lower(upstream_protocol),
  '*',
  'legacy_pool_' || hex(
    model_id || char(31) ||
    lower(COALESCE(NULLIF(trim(route_group), ''), 'default')) || char(31) ||
    lower(upstream_protocol)
  ),
  'active',
  MIN(COALESCE(created_at, datetime('now'))),
  datetime('now')
FROM model_routes
GROUP BY
  model_id,
  lower(COALESCE(NULLIF(trim(route_group), ''), 'default')),
  lower(upstream_protocol);

UPDATE model_routes
SET route_pool_id =
  'legacy_pool_' || hex(
    model_id || char(31) ||
    lower(COALESCE(NULLIF(trim(route_group), ''), 'default')) || char(31) ||
    lower(upstream_protocol)
  )
WHERE route_pool_id IS NULL;

CREATE INDEX idx_model_routes_pool_status_priority
  ON model_routes(route_pool_id, status, priority);

ALTER TABLE api_key_request_logs ADD COLUMN request_operation TEXT;
ALTER TABLE api_key_request_logs ADD COLUMN model_surface_id TEXT;
ALTER TABLE api_key_request_logs ADD COLUMN route_pool_id TEXT;
ALTER TABLE api_key_request_logs ADD COLUMN route_target_id TEXT;
ALTER TABLE api_key_request_logs ADD COLUMN upstream_operation TEXT;
ALTER TABLE api_key_request_logs ADD COLUMN adapter TEXT;
ALTER TABLE api_key_request_logs ADD COLUMN route_trace TEXT;

CREATE INDEX idx_request_logs_surface_created
  ON api_key_request_logs(model_surface_id, created_at);
CREATE INDEX idx_request_logs_pool_created
  ON api_key_request_logs(route_pool_id, created_at);
CREATE INDEX idx_request_logs_target_created
  ON api_key_request_logs(route_target_id, created_at);
