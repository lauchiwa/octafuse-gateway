# Merge upstream v2.0.0 — Implementation Plan

## Pre-requisites

- [ ] Clean working directory on `main`
- [ ] All task archives done
- [ ] `upstream/main` fetched

## Step 1: Create squash commits (on current main)

1. `git checkout -b merge-prep main`
2. Create 4 squashed commits (see design.md for mapping)
3. Verify each commit builds independently

```bash
# S1: custom upstream headers
git diff b28bf22..github/main -- packages/core/src/provider-custom-headers* \
  packages/core/src/merge-upstream-headers* packages/core/src/provider-custom-headers-types* \
  packages/core/migrations-*/0014_provider_custom_headers.sql \
  packages/core/src/storage/ packages/core/src/db/*/providers.impl.ts \
  packages/core/src/types.ts packages/core/src/index.ts \
  packages/proxy/src/services/egress/merge-upstream-headers.ts \
  packages/proxy/src/services/egress/*-driver.ts \
  packages/admin/app/gateway/providers/ \
  packages/admin/lib/services/admin/playground-custom-headers.test.ts \
  packages/admin/lib/services/admin/providers-service.ts \
  packages/admin/lib/types.ts \
  packages/admin/messages/ \
  packages/admin/scripts/link-standalone-next.mjs

# S2: admin auth bypass fix
git diff b28bf22..github/main -- packages/admin/lib/auth* \
  packages/admin/app/api/auth/ \
  packages/admin/app/api/admin/

# S3: hash gateway keys
git diff b28bf22..github/main -- packages/core/migrations-*/0015_hash_api_keys.sql \
  packages/core/src/db/api-keys-types.ts packages/core/src/db/*/api-keys.impl.ts \
  packages/core/src/services/api-key-hash* packages/core/src/services/key-service.ts \
  packages/core/src/services/user-service.ts \
  packages/proxy/src/services/api-key-auth.ts \
  packages/admin/app/gateway/keys/ packages/admin/app/gateway/users/ \
  packages/admin/lib/services/admin/keys-service.ts \
  packages/admin/lib/services/admin/users-service.ts

# S4: audit + deploy + toolchain
git diff b28bf22..github/main -- scripts/deploy/ \
  Dockerfile.admin docs/developers/upstream-sync.md \
  .trellis/ .agents/ .claude/ .codex/ AGENTS.md \
  package-lock.json packages/admin/package.json packages/core/package.json
```

4. `git checkout main && git reset --soft HEAD~23` to collect diff → create 4 commits
   Alternative: `git merge-base --squash` approach.

## Step 2: Rename upstream migrations

```bash
# Rename 0014 → 0016, 0015 → 0017, 0016 → 0018 for all three DB drivers
for dir in migrations-d1 migrations-mysql migrations-postgres; do
  git mv packages/core/$dir/0014_request_log_audio_billing.sql packages/core/$dir/0016_request_log_audio_billing.sql
  git mv packages/core/$dir/0015_single_provider_key.sql packages/core/$dir/0017_single_provider_key.sql
  git mv packages/core/$dir/0016_route_surfaces_pools.sql packages/core/$dir/0018_route_surfaces_pools.sql
done
git commit -m "chore: renumber upstream migrations 0014-0016 to 0016-0018 to avoid collision"
```

## Step 3: Rebase

```bash
# Create new branch from upstream/main with renamed migrations
git checkout -b merge-upstream-v2 upstream/main
# Apply the migration rename commit first
git cherry-pick <rename-commit>
```

## Step 4: Apply S1 — Custom upstream headers

```bash
git cherry-pick <S1-commit>
```

**Expected conflicts**: `providers.impl.ts` (x3), `gateway-repository-interfaces.ts`, `schema.*.ts`, `repository-dtos.ts`, `types.ts`, `index.ts`, driver files, package.json, admin provider files

**Resolution**: Keep upstream version for structural changes, add custom_headers columns/fields back.

## Step 5: Apply S2 — Admin auth bypass fix

```bash
git cherry-pick <S2-commit>
```

**Expected conflicts**: `auth.ts`, `auth.test.ts`, API routes (minimal—auth wasn't changed upstream)

## Step 6: Apply S3 — Gateway key hash

```bash
git cherry-pick <S3-commit>
```

**Expected conflicts**: `api-keys.impl.ts` (x3), `schema.d1|mysql|pg.ts`, `types.ts`, `index.ts`, `api-key-auth.ts`

**Note**: upstream didn't touch `api_keys` table, so conflicts should be minimal.

## Step 7: Apply S4 — Deploy scripts, audit, toolchain

```bash
git cherry-pick <S4-commit>
```

**Expected conflicts**: `cf-deploy-lib.mjs`, `wrangler-d1-cli.mjs`, `package.json` files, `docs/developers/README.md`

## Step 8: Post-merge cleanup

```bash
# Remove dropped files (provider-key-crypto)
git rm packages/core/src/services/provider-key-crypto.ts
git rm packages/core/src/services/provider-key-crypto.test.ts

# Remove files that upstream deleted (check if they exist)
# These should already be gone from upstream/main
test -f packages/core/src/db/d1/provider-api-keys.impl.ts && git rm packages/core/src/db/d1/provider-api-keys.impl.ts
test -f packages/core/src/db/mysql/provider-api-keys.impl.ts && git rm packages/core/src/db/mysql/provider-api-keys.impl.ts
test -f packages/core/src/db/postgres/provider-api-keys.impl.ts && git rm packages/core/src/db/postgres/provider-api-keys.impl.ts

# Verify index.ts exports
```

## Step 9: Build & Verify

```bash
# Install deps
cd packages/core && npm install && cd -
cd packages/proxy && npm install && cd -
cd packages/admin && npm install && cd -

# Build
npm run build

# Lint & type-check
npm run check

# Tests
cd packages/core && npm test
cd packages/proxy && npm test
cd packages/admin && npm test
```

## Step 10: Final validation

- [ ] `git diff upstream/main --name-only` shows only our local changes (no upstream commits missing)
- [ ] All our commit SHAs are in the new branch history
- [ ] No orphaned imports to deleted files
- [ ] `git log --oneline main..HEAD` tells a clear story

## Validation commands

```bash
# Quick sanity after conflict resolution
git diff --check  # no conflict markers
git grep -l '<<<<<<< HEAD\|=======\|>>>>>>>'  # no leftovers

# Build
npx turbo run build 2>&1 | tail -20

# Test per package
npm -w packages/core test 2>&1 | tail -20
npm -w packages/proxy test 2>&1 | tail -20
npm -w packages/admin test 2>&1 | tail -20

# Package version check
grep '"version"' packages/core/package.json
grep '"version"' packages/proxy/package.json
grep '"version"' packages/admin/package.json
```

## Rollback points

| Point | Command | Risk |
|-------|---------|------|
| Before rebase | `git checkout main` | None |
| After S1 cherry-pick | `git rebase --abort` | Low |
| After S2 cherry-pick | `git rebase --abort` | Low |
| After S3 cherry-pick | `git rebase --abort` | Medium |
| After S4 cherry-pick | `git rebase --abort` | Medium |
| After final commit | `git reset --hard upstream/main` | High |