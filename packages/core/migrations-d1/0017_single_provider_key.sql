-- Single provider key: fold provider_api_keys into providers; route weight + route_policy.
-- Migration keeps the first active key per provider (priority DESC, created_at ASC).
-- Export provider_api_keys before applying if you need to rebuild discarded keys as new providers.

ALTER TABLE providers ADD COLUMN api_key TEXT NOT NULL DEFAULT '';
ALTER TABLE providers ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

UPDATE providers SET api_key = COALESCE((
  SELECT k.api_key FROM provider_api_keys k
  WHERE k.provider_id = providers.id AND k.status = 'active'
  ORDER BY k.priority DESC, k.created_at ASC LIMIT 1
), '');

UPDATE providers SET status = 'disabled' WHERE api_key = '';

ALTER TABLE model_routes ADD COLUMN weight INTEGER NOT NULL DEFAULT 1;

DROP TABLE provider_api_keys;

ALTER TABLE models DROP COLUMN sticky_config;
ALTER TABLE models ADD COLUMN route_policy TEXT;

INSERT OR IGNORE INTO system_config (key, value) VALUES ('ROUTE_STRATEGY', 'affinity');
