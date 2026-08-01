-- Route topology v2. Historical rows are preserved through wildcard surfaces.

CREATE TABLE route_pools (
  id VARCHAR(512) PRIMARY KEY,
  model_id VARCHAR(512) NOT NULL,
  route_group VARCHAR(64) NOT NULL DEFAULT 'default',
  name VARCHAR(512) NOT NULL,
  strategy VARCHAR(32) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_route_pools_model FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE,
  INDEX idx_route_pools_model_group (model_id, route_group)
) ENGINE=InnoDB;

CREATE TABLE model_surfaces (
  id VARCHAR(512) PRIMARY KEY,
  model_id VARCHAR(512) NOT NULL,
  route_group VARCHAR(64) NOT NULL DEFAULT 'default',
  request_protocol VARCHAR(32) NOT NULL,
  request_operation VARCHAR(64) NOT NULL DEFAULT '*',
  route_pool_id VARCHAR(512) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_model_surfaces_model FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE,
  CONSTRAINT fk_model_surfaces_pool FOREIGN KEY (route_pool_id) REFERENCES route_pools(id) ON DELETE CASCADE,
  UNIQUE KEY uk_model_surfaces_lookup (model_id, route_group, request_protocol, request_operation),
  INDEX idx_model_surfaces_pool (route_pool_id)
) ENGINE=InnoDB;

ALTER TABLE model_routes ADD COLUMN route_pool_id VARCHAR(512) NULL;
ALTER TABLE model_routes ADD COLUMN upstream_operation VARCHAR(64) NOT NULL DEFAULT '*';
ALTER TABLE model_routes ADD COLUMN adapter VARCHAR(128) NOT NULL DEFAULT 'passthrough';

INSERT IGNORE INTO route_pools (
  id, model_id, route_group, name, strategy, status, created_at, updated_at
)
SELECT
  CONCAT(
    'legacy_pool_',
    MD5(CONCAT(
      model_id, CHAR(31),
      LOWER(COALESCE(NULLIF(TRIM(route_group), ''), 'default')), CHAR(31),
      LOWER(upstream_protocol)
    ))
  ),
  model_id,
  COALESCE(NULLIF(TRIM(route_group), ''), 'default'),
  CONCAT(
    UPPER(LEFT(upstream_protocol, 1)), SUBSTRING(upstream_protocol, 2),
    ' · ', COALESCE(NULLIF(TRIM(route_group), ''), 'default')
  ),
  NULL,
  'active',
  MIN(COALESCE(created_at, CURRENT_TIMESTAMP(6))),
  CURRENT_TIMESTAMP(6)
FROM model_routes
GROUP BY
  model_id,
  LOWER(COALESCE(NULLIF(TRIM(route_group), ''), 'default')),
  COALESCE(NULLIF(TRIM(route_group), ''), 'default'),
  LOWER(upstream_protocol);

INSERT IGNORE INTO model_surfaces (
  id, model_id, route_group, request_protocol, request_operation,
  route_pool_id, status, created_at, updated_at
)
SELECT
  CONCAT(
    'legacy_surface_',
    MD5(CONCAT(
      model_id, CHAR(31),
      LOWER(COALESCE(NULLIF(TRIM(route_group), ''), 'default')), CHAR(31),
      LOWER(upstream_protocol), CHAR(31), '*'
    ))
  ),
  model_id,
  COALESCE(NULLIF(TRIM(route_group), ''), 'default'),
  LOWER(upstream_protocol),
  '*',
  CONCAT(
    'legacy_pool_',
    MD5(CONCAT(
      model_id, CHAR(31),
      LOWER(COALESCE(NULLIF(TRIM(route_group), ''), 'default')), CHAR(31),
      LOWER(upstream_protocol)
    ))
  ),
  'active',
  MIN(COALESCE(created_at, CURRENT_TIMESTAMP(6))),
  CURRENT_TIMESTAMP(6)
FROM model_routes
GROUP BY
  model_id,
  LOWER(COALESCE(NULLIF(TRIM(route_group), ''), 'default')),
  COALESCE(NULLIF(TRIM(route_group), ''), 'default'),
  LOWER(upstream_protocol);

UPDATE model_routes
SET route_pool_id = CONCAT(
  'legacy_pool_',
  MD5(CONCAT(
    model_id, CHAR(31),
    LOWER(COALESCE(NULLIF(TRIM(route_group), ''), 'default')), CHAR(31),
    LOWER(upstream_protocol)
  ))
)
WHERE route_pool_id IS NULL;

ALTER TABLE model_routes
  ADD CONSTRAINT fk_model_routes_pool
  FOREIGN KEY (route_pool_id) REFERENCES route_pools(id);
CREATE INDEX idx_model_routes_pool_status_priority
  ON model_routes(route_pool_id, status, priority);

ALTER TABLE api_key_request_logs ADD COLUMN request_operation VARCHAR(64) NULL;
ALTER TABLE api_key_request_logs ADD COLUMN model_surface_id VARCHAR(512) NULL;
ALTER TABLE api_key_request_logs ADD COLUMN route_pool_id VARCHAR(512) NULL;
ALTER TABLE api_key_request_logs ADD COLUMN route_target_id VARCHAR(512) NULL;
ALTER TABLE api_key_request_logs ADD COLUMN upstream_operation VARCHAR(64) NULL;
ALTER TABLE api_key_request_logs ADD COLUMN adapter VARCHAR(128) NULL;
ALTER TABLE api_key_request_logs ADD COLUMN route_trace TEXT NULL;

CREATE INDEX idx_request_logs_surface_created
  ON api_key_request_logs(model_surface_id, created_at);
CREATE INDEX idx_request_logs_pool_created
  ON api_key_request_logs(route_pool_id, created_at);
CREATE INDEX idx_request_logs_target_created
  ON api_key_request_logs(route_target_id, created_at);
