-- Per-priority-tier route strategies on route_pools (JSON map: {"10":"affinity","0":"strict"}).
ALTER TABLE route_pools ADD COLUMN tier_strategies TEXT;
