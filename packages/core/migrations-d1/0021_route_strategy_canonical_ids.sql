-- Hard cutover: rename route strategy IDs to descriptive snake_case.
-- affinity → cache_affinity, strict → fixed_order, round_robin → weighted_round_robin
-- weighted_random unchanged. No legacy aliases in application code after this migration.

-- 1) Global default
UPDATE system_config
SET value = CASE value
	WHEN 'affinity' THEN 'cache_affinity'
	WHEN 'strict' THEN 'fixed_order'
	WHEN 'round_robin' THEN 'weighted_round_robin'
	ELSE value
END
WHERE key = 'ROUTE_STRATEGY'
  AND value IN ('affinity', 'strict', 'round_robin');

-- 2) Pool base strategy (plain text)
UPDATE route_pools
SET strategy = CASE strategy
	WHEN 'affinity' THEN 'cache_affinity'
	WHEN 'strict' THEN 'fixed_order'
	WHEN 'round_robin' THEN 'weighted_round_robin'
	ELSE strategy
END
WHERE strategy IN ('affinity', 'strict', 'round_robin');

-- 3) Per-tier strategies JSON map values (keys are priority integers as strings)
UPDATE route_pools
SET tier_strategies = REPLACE(
	REPLACE(
		REPLACE(tier_strategies, '"affinity"', '"cache_affinity"'),
		'"strict"',
		'"fixed_order"'
	),
	'"round_robin"',
	'"weighted_round_robin"'
)
WHERE tier_strategies IS NOT NULL
  AND (
	tier_strategies LIKE '%"affinity"%'
	OR tier_strategies LIKE '%"strict"%'
	OR tier_strategies LIKE '%"round_robin"%'
  );

-- 4) Model route_policy: only rewrite "strategy" field values (not rule keys)
UPDATE models
SET route_policy = REPLACE(
	REPLACE(
		REPLACE(
			REPLACE(
				REPLACE(
					REPLACE(route_policy, '"strategy":"affinity"', '"strategy":"cache_affinity"'),
					'"strategy": "affinity"',
					'"strategy": "cache_affinity"'
				),
				'"strategy":"strict"',
				'"strategy":"fixed_order"'
			),
			'"strategy": "strict"',
			'"strategy": "fixed_order"'
		),
		'"strategy":"round_robin"',
		'"strategy":"weighted_round_robin"'
	),
	'"strategy": "round_robin"',
	'"strategy": "weighted_round_robin"'
)
WHERE route_policy IS NOT NULL
  AND (
	route_policy LIKE '%"strategy":"affinity"%'
	OR route_policy LIKE '%"strategy": "affinity"%'
	OR route_policy LIKE '%"strategy":"strict"%'
	OR route_policy LIKE '%"strategy": "strict"%'
	OR route_policy LIKE '%"strategy":"round_robin"%'
	OR route_policy LIKE '%"strategy": "round_robin"%'
  );
