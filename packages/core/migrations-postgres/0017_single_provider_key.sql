-- Single provider key: fold provider_api_keys into providers; route weight + route_policy.
SET search_path TO octafuse_gateway;

ALTER TABLE providers ADD COLUMN IF NOT EXISTS api_key TEXT NOT NULL DEFAULT '';
ALTER TABLE providers ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

UPDATE providers SET api_key = COALESCE((
  SELECT k.api_key FROM provider_api_keys k
  WHERE k.provider_id = providers.id AND k.status = 'active'
  ORDER BY k.priority DESC, k.created_at ASC LIMIT 1
), '')
WHERE api_key = '';

UPDATE providers SET status = 'disabled' WHERE api_key = '';

ALTER TABLE model_routes ADD COLUMN IF NOT EXISTS weight INTEGER NOT NULL DEFAULT 1;

DROP TABLE IF EXISTS provider_api_keys;

ALTER TABLE models DROP COLUMN IF EXISTS sticky_config;
ALTER TABLE models ADD COLUMN IF NOT EXISTS route_policy TEXT;

INSERT INTO system_config (key, value)
VALUES ('ROUTE_STRATEGY', 'affinity')
ON CONFLICT (key) DO NOTHING;
