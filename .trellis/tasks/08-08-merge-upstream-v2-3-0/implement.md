# Implementation log — merge upstream v2.3.0

Merge commit: `b6ba947`. Rollback tag: `pre-v2.3.0-merge` → `921caa5`.

## Conflicts (12)

| File | Shape | Resolution |
|---|---|---|
| 3 × `package.json` | test manifests | union of both sides (+6 upstream test files) |
| `docs/operators/README.md` | docs reverting fork numbering | fork numbers 0017–0023 |
| `docs/developers/architecture/runtime-data.md` | same | same, plus corrected upstream's wrong 0019 description |
| `providers/types.ts` | additive | kept `CustomHeaderRow` + `GeminiLegacyPerActionEndpoints` |
| `providers/provider-utils.ts` | structural rewrite | took upstream's early-return shape, grafted `customHeaders` **before** the returns, restored fork-only `form.responses` |
| `providers/provider-utils.test.ts` | two independent suites | merged imports, kept all 9 tests |
| `routes/route-utils.ts` | semantic | took upstream's shared helper after pushing the fork's rule into it |
| `route-attempt-planner.ts` | semantic | upstream's `tierOverrides` lookup, fork's `applyTierPreference` wrapped **outside** it |
| `route-attempt-planner.test.ts` | two suites | kept both; fixed 6 stale `'strict'` IDs |
| `failover-dispatch.ts` | 2 blocks | upstream's required fields + `tierStrategies`, kept `preferWithinTier` |

## Migration renumbering

Incoming upstream `0017`–`0021` → `0019`–`0023`, all three dialects, via `git mv`
in descending order (ascending would collide with upstream's own 0019–0021).

Verified:
- Fresh-DB lexicographic order now has `0018_route_surfaces_pools` (creates
  `model_surfaces` / `route_pools`) before `0019_gemini_models_generate` (uses them).
- No code enumerates migration filenames — directory-scanned, so only docs needed edits (6 files).
- Prod `migrations list` shows exactly the 5 renumbered files pending; applied
  `0017`/`0018` untouched.

Strategy ID chain against real prod values:

| Prod value | 0021 | 0023 |
|---|---|---|
| `affinity` | `cache_affinity` | `hash_affinity` |
| `round_robin` | `weighted_round_robin` | (unchanged) |

## Defects found with no conflict marker

1. **`/v1/responses` missing all sticky/tier wiring** — the v2.1.1 trap verbatim.
   Upstream wired its own 5 routes; the fork-only route got 0 of 4. It also
   hardcoded `poolStrategy: null` while prod has **3 real `responses` surfaces**,
   so every pool strategy / tier override / sticky setting was silently ignored.
   Fixed by switching to `resolveRoutesForSurface` + `resolveRouteStrategyPlan`,
   keeping the capability gate after resolution.

2. **6 stale `'strict'` strategy IDs** in the planner test. 5 of 6 passed anyway
   against a nonexistent ID (silent fallback to `hash_affinity`); only the
   weight-order assertion went red.

3. **ETL manifest missing `route_pool_sticky_bindings`** — a D1→Postgres cutover
   would have skipped the table. Caught by the fork's own drift guard. Placed
   after `model_routes` (FKs to both it and `route_pools`); conflict key is the
   composite PK.

4. **Stale Gemini expectation** in `openai-surface-merge.test.ts`
   (`generateContent` → `models.generate` surface operation; wire action unchanged).

## Upstream bugs fixed here

- `ProxyResult.stickyTrace` typed as a snapshot while `ProxyFailoverResult`
  produces a thunk and all 5 routes `await` it. **Upstream's own proxy typecheck
  fails** (TS2322 + 5 × TS2349) — verified by running their unmodified
  `proxy.ts` in this workspace. Fixed to the runtime contract.
- Two new upstream test files fail typecheck (TS2352, TS2493); upstream does not
  typecheck test files, we do.
- `runtime-data.md` claimed `0019_route_strategy_canonical_ids` writes
  `hash_affinity`/`weight_priority`; that SQL writes `cache_affinity`/`fixed_order`.

## Semantics reconciled, not restored

`listConfiguredCapabilities`: pushed the fork's "`responses` never derived from
`base`" rule **down into the shared core helper** instead of keeping it inline at
one call site, reusing `providerDeclaresResponsesEndpoint` so the two can never
diverge (my first attempt used `Boolean()` vs the helper's `.trim()` — a real
whitespace inconsistency). Clears the deferred limitation in
`provider-import-preset.ts`. Rewrote the fork guard test that had pinned the old
inconsistent behavior.

Evidence this matches fork intent: `resolveUpstreamEndpoint`'s own comment notes
10 of 42 built-in presets set `base`, and Azure / Gemini-compat / SiliconFlow have
no `/responses` route — deriving it means the gateway's "unsupported" check never
fires and users get bare upstream 404s.

`preferWithinTier`: wrapped outside upstream's per-tier strategy lookup. Inverting
that order would let the strategy re-sort and silently drop the preference. It has
**no production call site** — our own translation removal (`9d3d9d6`) made
`/v1/responses` filter to native providers rather than prefer them.

## New test

`packages/proxy/src/routes/v1/fork-route-parity.test.ts` — structural invariant
that `/v1/responses` carries the same wiring as upstream-migrated routes, using
those routes as a self-checking baseline so a stale symbol list fails loudly.
Mutation-verified: removing the sticky/tier wiring fails 1 of 4.

## Verification

| Check | Result |
|---|---|
| Conflict markers | 0 |
| Tests | 521/521 (was 439; upstream +78, fork +4) |
| proxy typecheck | clean |
| admin typecheck | clean |
| proxy build + bundle externals | pass |
| admin build | pass |
| Package versions | all 2.3.0 |

## Not done

**Not deployed.** v2.3.0 needs a maintenance window: stop traffic → back up D1 →
apply 0019–0023 → deploy the same version to proxy/admin. Migration 0023 has no
legacy ID aliases, so mixed old/new running is unsafe.

Sticky routing is off by default; evaluate enabling per pool after deploy.
