-- 新增 providers.custom_headers：按协议注入上游 fetch 的自定义 header（JSON）。
-- 纯增量：可空、不回填；旧数据 NULL 时行为与今天一致。
ALTER TABLE providers ADD COLUMN custom_headers TEXT;
