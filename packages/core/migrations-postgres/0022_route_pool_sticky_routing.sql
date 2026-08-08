-- Provider sticky routing (Route Pool level): config columns + shared bindings table.
SET search_path TO octafuse_gateway;

ALTER TABLE route_pools ADD COLUMN IF NOT EXISTS sticky_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE route_pools ADD COLUMN IF NOT EXISTS sticky_idle_ttl_seconds INTEGER NOT NULL DEFAULT 3600;
ALTER TABLE route_pools ADD COLUMN IF NOT EXISTS sticky_epoch INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS route_pool_sticky_bindings (
  route_pool_id TEXT NOT NULL REFERENCES route_pools(id) ON DELETE CASCADE,
  affinity_hash TEXT NOT NULL,
  route_target_id TEXT NOT NULL REFERENCES model_routes(id) ON DELETE CASCADE,
  binding_token TEXT NOT NULL,
  pool_epoch INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (route_pool_id, affinity_hash)
);

CREATE INDEX IF NOT EXISTS idx_route_pool_sticky_expires_at
  ON route_pool_sticky_bindings(expires_at);
CREATE INDEX IF NOT EXISTS idx_route_pool_sticky_target
  ON route_pool_sticky_bindings(route_target_id);
