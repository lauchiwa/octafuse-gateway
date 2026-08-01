-- Single provider key: fold provider_api_keys into providers; route weight + route_policy.

ALTER TABLE providers ADD COLUMN api_key TEXT NOT NULL DEFAULT '';
ALTER TABLE providers ADD COLUMN status VARCHAR(32) NOT NULL DEFAULT 'active';

UPDATE providers p
LEFT JOIN (
  SELECT provider_id, api_key
  FROM (
    SELECT provider_id, api_key,
           ROW_NUMBER() OVER (PARTITION BY provider_id ORDER BY priority DESC, created_at ASC) AS rn
    FROM provider_api_keys
    WHERE status = 'active'
  ) ranked
  WHERE rn = 1
) x ON x.provider_id = p.id
SET p.api_key = COALESCE(x.api_key, '');

UPDATE providers SET status = 'disabled' WHERE api_key = '';

ALTER TABLE model_routes ADD COLUMN weight INT NOT NULL DEFAULT 1;

DROP TABLE provider_api_keys;

ALTER TABLE models DROP COLUMN sticky_config;
ALTER TABLE models ADD COLUMN route_policy TEXT NULL;

INSERT IGNORE INTO system_config (`key`, value) VALUES ('ROUTE_STRATEGY', 'affinity');
