-- Hard cutover: align strategy IDs with Admin display names.
-- cache_affinity → hash_affinity, fixed_order → weight_priority
-- weighted_random / weighted_round_robin unchanged.
-- No legacy aliases in application code after this migration.
SET search_path TO octafuse_gateway;

-- 1) Global default
UPDATE system_config
SET value = CASE value
	WHEN 'cache_affinity' THEN 'hash_affinity'
	WHEN 'fixed_order' THEN 'weight_priority'
	ELSE value
END
WHERE key = 'ROUTE_STRATEGY'
  AND value IN ('cache_affinity', 'fixed_order');

-- 2) Pool base strategy (plain text)
UPDATE route_pools
SET strategy = CASE strategy
	WHEN 'cache_affinity' THEN 'hash_affinity'
	WHEN 'fixed_order' THEN 'weight_priority'
	ELSE strategy
END
WHERE strategy IN ('cache_affinity', 'fixed_order');

-- 3) Per-tier strategies JSON map values (keys are priority integers as strings)
UPDATE route_pools
SET tier_strategies = REPLACE(
	REPLACE(tier_strategies, '"cache_affinity"', '"hash_affinity"'),
	'"fixed_order"',
	'"weight_priority"'
)
WHERE tier_strategies IS NOT NULL
  AND (
	tier_strategies LIKE '%"cache_affinity"%'
	OR tier_strategies LIKE '%"fixed_order"%'
  );

-- 4) Model route_policy: only rewrite "strategy" field values (not rule keys)
UPDATE models
SET route_policy = REPLACE(
	REPLACE(
		REPLACE(
			REPLACE(route_policy, '"strategy":"cache_affinity"', '"strategy":"hash_affinity"'),
			'"strategy": "cache_affinity"',
			'"strategy":"hash_affinity"'
		),
		'"strategy":"fixed_order"',
		'"strategy":"weight_priority"'
	),
	'"strategy": "fixed_order"',
	'"strategy":"weight_priority"'
)
WHERE route_policy IS NOT NULL
  AND (
	route_policy LIKE '%"strategy":"cache_affinity"%'
	OR route_policy LIKE '%"strategy": "cache_affinity"%'
	OR route_policy LIKE '%"strategy":"fixed_order"%'
	OR route_policy LIKE '%"strategy": "fixed_order"%'
  );
