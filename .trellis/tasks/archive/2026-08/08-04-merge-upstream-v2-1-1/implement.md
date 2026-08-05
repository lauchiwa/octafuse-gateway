# Merge upstream v2.1.1 - Implementation Plan

## 1. Prepare

- [ ] Confirm clean `main`, current remotes, fetched `v2.1.1`, and tag commit `9c540b4`.
- [ ] Load package/backend/frontend specs and upstream merge guide.
- [ ] Record pre-merge test/package-version baseline.
- [ ] Create `merge-upstream-v2-1-1` from local `main`.

## 2. Merge

- [ ] Run `git merge --no-ff v2.1.1`.
- [ ] Record every unmerged path and classify it as additive, structural, or semantic.
- [ ] Resolve changelog/document conflicts by retaining both relevant histories.
- [ ] Resolve package manifests with upstream 2.1.1 versions/tool-engines plus required local configuration.
- [ ] Resolve Playground/Simulator structural conflicts using upstream files as baseline and grafting local behavior.
- [ ] Regenerate `package-lock.json` after manifests are resolved.
- [ ] Confirm `providers-service.ts` retains custom-header PATCH persistence and provider deletion guard.
- [ ] Complete the merge commit only after zero unmerged paths and conflict markers.

## 3. Audit Both Directions

- [ ] Confirm local custom headers remain wired from Admin mutation through DB and egress.
- [ ] Confirm API-key hashing and admin-session HMAC remain wired.
- [ ] Confirm local Responses/route semantics remain represented in the new upstream flow.
- [ ] Confirm Cloudflare Custom Domain + workers.dev fallback + disabled Preview URLs survive.
- [ ] Confirm upstream tool-engines, AI Detection, pricing, error codes, circuit breakers, provider deletion guard, and model presets exist.
- [ ] Confirm migration files remain exactly `0001` through local `0018`, with no new release migration.
- [ ] Confirm the six commits after v2.1.1 are absent.

## 4. Validate

```bash
git diff --check
git grep -nE '^(<<<<<<<|=======|>>>>>>>)'
npm install
npm run check
npm run build
npm test
npm run test:deploy
```

Targeted checks:

```bash
npm -w packages/admin test -- providers-custom-headers-patch.test.ts
npm -w packages/proxy test -- provider-circuit-breaker.test.ts failover-dispatch.test.ts
npm -w packages/core test
```

- [ ] Run all commands and capture pass counts.
- [ ] Perform custom-header PATCH mutation proof: break the body-to-patch binding, expect the targeted suite to fail, restore, and rerun green.
- [ ] Run configured LSP diagnostics on manually resolved TypeScript files where available.
- [ ] Review the merge diff and test evidence with an independent reviewer.

## 5. Finalize

- [ ] Update task notes with conflict decisions and verification evidence.
- [ ] Update the upstream-merge spec only if this merge reveals a new reusable lesson.
- [ ] Verify clean worktree and coherent history.
- [ ] Merge the task branch into `main` if validation is green.
- [ ] Push `main` to `origin` and `github`.
- [ ] Archive the Trellis task and record the session journal.

## Risk Files

- `package.json`
- `package-lock.json`
- `packages/proxy/package.json`
- `packages/admin/app/gateway/simulator/**`
- `packages/admin/lib/playground/preview-upstream-url.ts`
- `packages/admin/lib/routes/admin/playground.ts`
- `packages/admin/lib/services/admin/playground-service.ts`
- `packages/admin/lib/simulator/endpoint.ts`
- `packages/admin/lib/services/admin/providers-service.ts`
- `packages/proxy/src/services/failover-dispatch.ts`
- `docs/operators/migrations/single-provider-key-cutover.md`

## Stop Conditions

- Do not push if any required suite fails.
- Do not deploy production in this task.
- Do not include commits from `v2.1.1..upstream/main`.
- Do not discard a local behavior merely to resolve a structural conflict; prove it is superseded first.
