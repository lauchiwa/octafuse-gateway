-- v2.2.0: Collapse Gemini generateContent / streamGenerateContent into models.generate.
-- Conflict rule: keep generateContent's pool; demote the other pool to inactive with
-- a [v220-conflict] name prefix (targets retained). Wildcard (*) surfaces are untouched.
SET search_path TO octafuse_gateway;

-- 1) Same (model_id, route_group) with both legacy ops on DIFFERENT pools:
--    delete stream surface; demote its pool.
UPDATE route_pools
SET
  status = 'inactive',
  name = CASE
    WHEN name LIKE '[v220-conflict] %' THEN name
    ELSE '[v220-conflict] ' || name
  END,
  updated_at = CURRENT_TIMESTAMP
WHERE id IN (
  SELECT s.route_pool_id
  FROM model_surfaces s
  INNER JOIN model_surfaces g
    ON g.model_id = s.model_id
   AND lower(g.route_group) = lower(s.route_group)
   AND lower(g.request_protocol) = 'gemini'
   AND g.request_operation = 'generateContent'
  WHERE lower(s.request_protocol) = 'gemini'
    AND s.request_operation = 'streamGenerateContent'
    AND s.route_pool_id <> g.route_pool_id
);

DELETE FROM model_surfaces
WHERE id IN (
  SELECT s.id
  FROM model_surfaces s
  INNER JOIN model_surfaces g
    ON g.model_id = s.model_id
   AND lower(g.route_group) = lower(s.route_group)
   AND lower(g.request_protocol) = 'gemini'
   AND g.request_operation = 'generateContent'
  WHERE lower(s.request_protocol) = 'gemini'
    AND s.request_operation = 'streamGenerateContent'
    AND s.route_pool_id <> g.route_pool_id
);

-- 2) Same pool with both legacy ops: drop the streamGenerateContent surface.
DELETE FROM model_surfaces
WHERE id IN (
  SELECT s.id
  FROM model_surfaces s
  INNER JOIN model_surfaces g
    ON g.model_id = s.model_id
   AND lower(g.route_group) = lower(s.route_group)
   AND lower(g.request_protocol) = 'gemini'
   AND g.request_operation = 'generateContent'
   AND g.route_pool_id = s.route_pool_id
  WHERE lower(s.request_protocol) = 'gemini'
    AND s.request_operation = 'streamGenerateContent'
);

-- 3) Rename remaining legacy surfaces to models.generate when no family row exists yet.
UPDATE model_surfaces
SET
  request_operation = 'models.generate',
  updated_at = CURRENT_TIMESTAMP
WHERE lower(request_protocol) = 'gemini'
  AND request_operation IN ('generateContent', 'streamGenerateContent')
  AND NOT EXISTS (
    SELECT 1
    FROM model_surfaces existing
    WHERE existing.model_id = model_surfaces.model_id
      AND lower(existing.route_group) = lower(model_surfaces.route_group)
      AND lower(existing.request_protocol) = 'gemini'
      AND existing.request_operation = 'models.generate'
  );

-- 4) Normalize gemini target upstream_operation (keep '*').
UPDATE model_routes
SET upstream_operation = 'models.generate'
WHERE lower(upstream_protocol) = 'gemini'
  AND upstream_operation IN ('generateContent', 'streamGenerateContent');

-- 5) Rewrite auto-generated pool names that match ensureModelSurfacePool pattern.
UPDATE route_pools
SET
  name = 'gemini.models.generate · ' || substr(name, length('gemini.generateContent · ') + 1),
  updated_at = CURRENT_TIMESTAMP
WHERE name LIKE 'gemini.generateContent · %';

UPDATE route_pools
SET
  name = 'gemini.models.generate · ' || substr(name, length('gemini.streamGenerateContent · ') + 1),
  updated_at = CURRENT_TIMESTAMP
WHERE name LIKE 'gemini.streamGenerateContent · %';
