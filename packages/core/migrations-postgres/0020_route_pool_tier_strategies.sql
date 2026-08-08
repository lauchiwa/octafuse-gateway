-- Per-priority-tier route strategies on route_pools (JSON map: {"10":"affinity","0":"strict"}).
SET search_path TO octafuse_gateway;

ALTER TABLE route_pools ADD COLUMN IF NOT EXISTS tier_strategies TEXT;
