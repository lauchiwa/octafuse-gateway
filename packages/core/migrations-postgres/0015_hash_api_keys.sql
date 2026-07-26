-- Gateway 下游密钥不再明文入库：`key` 改为存 SHA-256 摘要，另加展示用前缀。
--
-- 采用「重命名列」而非重建表：`api_key_request_logs.api_key_id` 等外键指向 `api_keys(id)`，
-- 重建表会破坏历史关联；重命名时原 UNIQUE 约束随列迁移，外键不受影响。
--
-- 存量行保留（用户关联、预算、日志历史不丢），但密钥作废：
-- 明文无法反推哈希，故存量密钥统一置为不可匹配的哨兵值并吊销，由管理员重新签发。
-- 顺序有依赖：`key_prefix` 取自旧明文，必须在覆盖 `key_hash` 之前写入。
ALTER TABLE api_keys RENAME COLUMN key TO key_hash;
ALTER TABLE api_keys ADD COLUMN key_prefix TEXT;
UPDATE api_keys SET key_prefix = substr(key_hash, 1, 11);
UPDATE api_keys SET key_hash = 'migrated:' || id, status = 'revoked';
