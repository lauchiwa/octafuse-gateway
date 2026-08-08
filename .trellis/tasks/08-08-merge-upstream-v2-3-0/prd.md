# Merge upstream v2.3.0

## Goal

Merge upstream tag `v2.3.0` into this fork without losing fork-only surfaces, and
without breaking migration identity for the already-deployed production database.

## Scope

- **Merge**: 23 commits, `v2.1.1..v2.3.0`, 161 files (+12056 / −2215)
- **Exclude**: the 2 unreleased docs commits after `v2.3.0` (`43b6490`, `9a931df`)
- Packages touched: core 52, admin 50, root 32, proxy 25, tool-engines 2

## Pre-merge production baseline (captured 2026-08-08)

| Item | Value |
|---|---|
| `system_config.ROUTE_STRATEGY` | `affinity` |
| `route_pools.strategy` | 21 × `NULL`, 1 × `round_robin` |
| Applied D1 migrations | through `0018_route_surfaces_pools.sql` |
| Rollback tag | `pre-v2.3.0-merge` → `921caa5` |
| Prod versions | proxy `d11ffdb4`, admin `ab99e647` |

## Blocking concerns

### 1. Migration number collision

Upstream adds `0017`–`0021`; our fork already applied different `0017`/`0018`:

| Number | Ours (applied in prod) | Upstream new |
|---|---|---|
| 0017 | `single_provider_key` | `gemini_models_generate` |
| 0018 | `route_surfaces_pools` | `route_pool_tier_strategies` |

D1 tracks by **full filename**, so the existing prod DB will not re-run ours.
But a **fresh deployment breaks**: lexicographic order puts
`0017_gemini_models_generate` before `0018_route_surfaces_pools`, while the former
depends on `model_surfaces` / `route_pools` created by the latter.

**Resolution**: renumber incoming upstream `0017`–`0021` → `0019`–`0023` across
all three dialects (d1 / mysql / postgres). Our shipped numbers stay fixed
(`database-guidelines.md`).

### 2. Route strategy IDs renamed twice, no aliases

```
v2.1.1 (ours): affinity / strict / round_robin
v2.2.0:        cache_affinity / fixed_order / weighted_round_robin
v2.3.0:        hash_affinity / weight_priority / weighted_round_robin
```

Upstream states 0021 has no legacy aliases and writing an old ID returns 400.
Our prod values (`affinity`, `round_robin`) are covered by the chain
(0019 `affinity`→`cache_affinity`, 0021 →`hash_affinity`), but this **requires
migrations and deploy to be strictly same-version — no mixed running**.

### 3. Sticky routing restored

Upstream re-added sticky routing (`d9003b8`) removed in v2.0.0: new `route_pools`
sticky columns + `route_pool_sticky_bindings` table (migration 0020), default off.

Interacts with our fork-only tier-local preference (`preferWithinTier`) in
`route-attempt-planner` / `failover-dispatch`.

## Fork-only surfaces at risk

Per `docs/developers/upstream-sync.md` §5 — no upstream refactor migrates these:

| Surface | Shared machinery |
|---|---|
| `/v1/responses` + `openai-responses-*` drivers | circuit breaker, failover dispatch, log status |
| `providers.custom_headers` | all 6 egress drivers, Admin Playground |
| Simulator/Playground surface toggle | `lib/invoke-kind.ts` |
| `preferWithinTier` | `route-attempt-planner`, `failover-dispatch` |

Plus two recent fork-only commits that touch upstream-owned files:

| Commit | Risk |
|---|---|
| `362514c` request-log body hoist | touches all 4 streaming routes — **likely conflict** |
| `1958382` audio custom headers | upstream did not touch audio driver — low risk |

## Acceptance criteria

- [ ] Zero conflict markers repo-wide
- [ ] Migrations renumbered; fresh-DB dependency order verified
- [ ] `ROUTE_STRATEGY` chain verified to map `affinity` → `hash_affinity`
- [ ] All 4 streaming routes agree on circuit-breaker calls (incl. fork-only `/v1/responses`)
- [ ] All 6 egress drivers still merge `providerCustomHeaders`
- [ ] Full test suite ≥ 439 tests passing, both typechecks clean, build + bundle check pass
- [ ] New/updated tests mutation-verified
- [ ] Docs grepped for renumbered migration names and version baselines

## Non-goals

- Deploying. Explicit user confirmation required, separately.
- Enabling sticky routing (default off; evaluate after deploy).
