# 0020 Route Pool Provider Sticky Routing — cutover

## Summary

Migration **`0022_route_pool_sticky_routing`** adds:

- `route_pools.sticky_enabled` / `sticky_idle_ttl_seconds` / `sticky_epoch`
- Table `route_pool_sticky_bindings` (shared sticky state across Worker isolates / Node instances)

Apply the same-named SQL under `packages/core/migrations-{d1,postgres,mysql}/`.

## Deploy order

1. Run migrate on **all** environments (D1 remote + Postgres/MySQL self-host).
2. Deploy **Proxy + Admin** on the same release (both understand sticky columns).
3. Enable sticky per Route Pool in Admin Routes Flow (default remains **off**).

Old Proxy builds ignore the new columns/table (safe). New Proxy with sticky enabled against an unmigrated DB will fail-open to normal routing and log storage errors.

## Semantics (operators)

| Item | Behavior |
|------|----------|
| Scope key | `userId\|model\|routeGroup\|protocol` (SHA-256 stored, not plaintext) |
| Default TTL | 3600s idle sliding; configurable 60–86400 |
| Cross-tier | Sticky target is tried **before** priority layers |
| Lower-tier stick | No proactive probe of higher tiers while binding is valid |
| Config change | Saving sticky settings bumps `sticky_epoch` → old bindings invalidate |
| Failures that unbind | 429 / 401–403 / 5xx / 524 / network (failover path) |
| Failures that keep bind | 400 / 404 / image client abort |

## Observability

`api_key_request_logs.route_trace` may include:

```json
{
  "sticky": {
    "lookup": "hit|miss|expired|invalid_epoch|invalid_target|invalid_circuit|disabled",
    "attempted_target": "model_routes.id",
    "result": "kept|cleared|bound|rebound|storage_error|unchanged"
  }
}
```

| `lookup` | Meaning |
|----------|---------|
| `hit` | Binding used as first attempt |
| `miss` | No row |
| `expired` | Row past `expires_at` (idle TTL) |
| `invalid_epoch` | `pool_epoch` mismatch after sticky config change |
| `invalid_target` | Bound target not in current candidates (disabled/removed from pool) |
| `invalid_circuit` | Bound provider is cooling down; binding kept, normal plan used |
| `disabled` | Sticky off for this pool / request |

`result` is resolved **after** bind/touch CAS settles (`unchanged` = lost CAS; `storage_error` = write failed). Correlate with `cache_read_tokens` and `upstream_failover_count` to measure Prompt Cache benefit vs failover cost.

## Admin ops (Routes Flow → Provider sticky dialog)

| Goal | Action |
|------|--------|
| See skew vs `route_weight` | Open sticky dialog → **Current bindings** (active count + share bars vs weight share) |
| Unstick one user | **Lookup user binding** with email or user id → **Unbind** |
| Flush whole pool | **Invalidate all bindings** (`POST /api/admin/routes/pools/:poolId/sticky/reset` / epoch bump) |
| Same effect via config | Saving sticky settings also bumps `sticky_epoch` |

Bindings store only `affinity_hash` (not plaintext user id). Lookup recomputes `SHA-256(userId\|model\|routeGroup\|protocol)` from the dialog's surface context.

## Cleanup

Expired rows are treated as miss at read time. Proxy also runs **opportunistic GC** (~1/500 sticky-enabled requests): `deleteStaleBefore(...)` removes expired rows **and** epoch-mismatched rows (after a sticky_epoch bump). Manual hygiene remains available:

```sql
DELETE FROM route_pool_sticky_bindings
WHERE expires_at < CURRENT_TIMESTAMP - INTERVAL '7 days'
LIMIT 1000;
```

(D1: use ISO text cutoff; MySQL: `LIMIT` supported.)
