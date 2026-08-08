-- Provider sticky routing (Route Pool level): config columns + shared bindings table.

ALTER TABLE route_pools ADD COLUMN sticky_enabled TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE route_pools ADD COLUMN sticky_idle_ttl_seconds INT NOT NULL DEFAULT 3600;
ALTER TABLE route_pools ADD COLUMN sticky_epoch INT NOT NULL DEFAULT 0;

CREATE TABLE route_pool_sticky_bindings (
  route_pool_id VARCHAR(128) NOT NULL,
  affinity_hash VARCHAR(64) NOT NULL,
  route_target_id VARCHAR(128) NOT NULL,
  binding_token VARCHAR(64) NOT NULL,
  pool_epoch INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMP(6) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (route_pool_id, affinity_hash),
  CONSTRAINT fk_sticky_bindings_pool
    FOREIGN KEY (route_pool_id) REFERENCES route_pools(id) ON DELETE CASCADE,
  CONSTRAINT fk_sticky_bindings_target
    FOREIGN KEY (route_target_id) REFERENCES model_routes(id) ON DELETE CASCADE
);

CREATE INDEX idx_route_pool_sticky_expires_at
  ON route_pool_sticky_bindings(expires_at);
CREATE INDEX idx_route_pool_sticky_target
  ON route_pool_sticky_bindings(route_target_id);
