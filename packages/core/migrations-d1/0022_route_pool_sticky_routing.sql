-- Provider sticky routing (Route Pool level): config columns + shared bindings table.
-- sticky_enabled: 0/1; sticky_idle_ttl_seconds: idle sliding TTL; sticky_epoch: bump to invalidate bindings.

ALTER TABLE route_pools ADD COLUMN sticky_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE route_pools ADD COLUMN sticky_idle_ttl_seconds INTEGER NOT NULL DEFAULT 3600;
ALTER TABLE route_pools ADD COLUMN sticky_epoch INTEGER NOT NULL DEFAULT 0;

CREATE TABLE route_pool_sticky_bindings (
  route_pool_id TEXT NOT NULL REFERENCES route_pools(id) ON DELETE CASCADE,
  affinity_hash TEXT NOT NULL,
  route_target_id TEXT NOT NULL REFERENCES model_routes(id) ON DELETE CASCADE,
  binding_token TEXT NOT NULL,
  pool_epoch INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (route_pool_id, affinity_hash)
);

CREATE INDEX idx_route_pool_sticky_expires_at
  ON route_pool_sticky_bindings(expires_at);
CREATE INDEX idx_route_pool_sticky_target
  ON route_pool_sticky_bindings(route_target_id);
