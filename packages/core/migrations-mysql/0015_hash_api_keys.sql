-- 见 migrations-d1/0015_hash_api_keys.sql 的说明。
-- MySQL 差异：用 CHANGE 重命名列（RENAME COLUMN 需 8.0），且 `||` 是逻辑或，拼接须用 CONCAT。
ALTER TABLE api_keys CHANGE `key` key_hash VARCHAR(767) NOT NULL;
ALTER TABLE api_keys ADD COLUMN key_prefix VARCHAR(64) DEFAULT NULL;
UPDATE api_keys SET key_prefix = SUBSTRING(key_hash, 1, 11);
UPDATE api_keys SET key_hash = CONCAT('migrated:', id), status = 'revoked';
