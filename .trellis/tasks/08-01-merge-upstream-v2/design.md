# Merge upstream v2.0.0 — Technical Design

## Architecture & Strategy

### Merge approach
Rebase (squash → replay) local changes on top of `upstream/main`.

```
upstream/main  ──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──● (v2.0.0)
                     \
github/main    ─●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●─
                  (23 commits)
```
becomes:
```
result         ●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──[1]──[2]──[3]──[4]
                ↑ upstream/v2.0.0 commits                                ↑ our 4 squashed commits
```

### Squash mapping

| Squash | Original commits (range) | Logical changes |
|--------|--------------------------|-----------------|
| S1: `feat(providers): custom upstream headers per provider × protocol` | `c2d6592` + `0ad3aef` + propagation | `providers.custom_headers` column, schema, provider impls, egress merge, admin provider modal, playground injection |
| S2: `fix(admin): verify admin_session HMAC signature to close auth bypass` | `dbca9b3` + propagation | HMAC session cookie verification, auth.ts, login/check routes |
| S3: `feat(security)!: hash gateway sk- keys at rest` | `0f57f90` + `344c800` (deploy) | SHA-256 digest on `api_keys.key_hash`, key_prefix, deploy script fix |
| S4: `chore: deploy scripts, audit maintenance, and toolchain` | `344c800` + `00d385e` + Trellis toolchain | cf-deploy-lib fixes, cookie Secure, dep bumps, `.trellis/` setup |

**Dropped commits**: `88ccc82` (provider key encryption — 方案A), all `chore: archive/task` commits (already covered by archived dirs), Merge commits, journal commits.

## Conflict Resolution Plan

### Phase 1: Prepare squash commits on current main (no upstream changes yet)

1. Create a temp branch `merge-prep` from `github/main`
2. `git diff b28bf22..github/main` to extract all local changes
3. Produce 4 squashed commits that replay cleanly onto current `github/main`
4. Verify each commit builds and tests pass

### Phase 2: Rebase onto upstream/main

1. `git checkout -b merge-upstream-v2 upstream/main`
2. For each of the 4 squash commits, `git cherry-pick` or apply as patch
3. Resolve conflicts file by file

### Phase 3: Handle specific conflict areas

#### 3a. Migration files (reconcile numbering)
**File**: `packages/core/migrations-*/0014_request_log_audio_billing.sql`, etc.
**Upstream**: has `0014`, `0015`, `0016` for audio billing, single key, route surfaces.
**Action**: Rename upstream migrations: 0014→0016, 0015→0017, 0016→0018. Apply as part of upstream commits, so no conflict — just rename files.

#### 3b. `packages/core/src/db/d1|mysql|postgres/providers.impl.ts`
**Upstream**: added `api_key`, `status` columns; removed `provider_api_keys` references.
**Local**: added `custom_headers` column.
**Action**: Keep both — accept upstream's `api_key`/`status` additions, reapply `custom_headers`.

#### 3c. `packages/core/src/storage/` (schema, repos, interfaces, DTOs)
**Upstream**: restructured schema, removed `provider_api_keys`-related types.
**Local**: added `custom_headers` fields, `api_key_hash` fields.
**Action**: Accept upstream schema, reapply `custom_headers` and `key_hash` additions.

#### 3d. `packages/core/src/types.ts`
**Upstream**: added `api_key`, `status` on provider row types, added route topology types.
**Local**: added `key_hash`, `key_prefix` on api key types.
**Action**: Accept upstream types, reapply `key_hash`/`key_prefix` on api key types.

#### 3e. `packages/proxy/src/services/egress/*` (all drivers)
**Upstream**: updated all drivers for new provider key model (now reading from `provider.api_key` instead of `provider_api_keys`).
**Local**: added `custom_headers` merge at egress.
**Action**: Accept upstream's driver changes. Reapply `custom_headers` merge logic on top. The custom_headers merge function is in `merge-upstream-headers.ts` — just need to call it in each driver.

#### 3f. `packages/proxy/src/services/failover-dispatch.ts` + `model-router.ts`
**Upstream**: heavy refactor — removed key scheduling, replaced with route-attempt-planner + route strategies.
**Local**: minor changes for custom_headers propagation and logging.
**Action**: Accept upstream's refactor (it's fundamentally different architecture). The custom_headers concern is already handled at the provider/egress level, not dispatch level.

#### 3g. `packages/core/src/db/d1|mysql|postgres/provider-api-keys.impl.ts`
**Upstream**: deleted the file entirely (migration 0015 drops the table).
**Local**: added custom_headers and encryption logic.
**Action**: Delete the file (upstream's approach). Any references to this file must be removed.

#### 3h. `packages/admin/` — providers page
**Upstream**: completely rewrote providers page, provider card, provider modal, provider-api-keys → removed.
**Local**: added custom_headers fields to provider modal, types, services.
**Action**: Accept upstream provider page. Reapply `custom_headers` UI on the new `provider-modal.tsx`. Note: upstream deleted `provider-api-keys-service.ts` and related files.

#### 3i. `packages/admin/lib/auth.ts` + routes
**Local**: HMAC session verification.
**Upstream**: unchanged (same auth flow as base).
**Action**: Should apply cleanly — auth files were only touched locally.

#### 3j. `packages/admin/messages/en|ja|ko|zh.json`
**Both**: added localization strings.
**Action**: Merge — keep both sets of keys. Upstream has ~300 new keys for new features.

#### 3k. `packages/core/src/index.ts`, `packages/core/package.json`, `packages/proxy/package.json`
**Both**: version bumps and exports.
**Action**: Accept upstream versions (they're v2.0.0), reapply our `custom_headers` exports and any package additions.

### Phase 4: Post-merge cleanup

1. Remove `provider-key-crypto.ts`, `provider-key-crypto.test.ts` (dropped per 方案A)
2. Remove `sticky-key-binding.*`, `model-sticky-config.*` (deleted upstream)
3. Remove `provider-key-*` files (deleted upstream)
4. Verify no remaining references to deleted files
5. Update index.ts exports

### Phase 5: Verify

1. `npm run build`
2. `npm run check` (lint + type-check)
3. `npm test — all packages`
4. Manual verify: `git diff main --stat` shows expected diff

## Data Compatibility

- **Existing `provider_api_keys` table** (migration 0015 drops it): On deploy, migration 0017 (our renumbered) will run. Existing deployments must run `export-provider-api-keys.mjs` before upgrading.
- **Existing `sticky_config` column** (removed upstream): Migration 0018 drops it. Route policy replaces sticky config.
- **Custom headers** already in `providers` table: Our `0014_provider_custom_headers` migration ran on existing DBs. Upstream's schema changes don't touch `custom_headers` column, so it stays.

## Rollback

If merge fails:
1. Delete the `merge-upstream-v2` branch
2. Stay on `main` (unchanged)
3. Re-assess strategy — consider cherry-picking specific upstream features instead of full merge