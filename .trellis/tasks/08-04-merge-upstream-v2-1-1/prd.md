# Merge upstream v2.1.1

## Goal

Upgrade the fork from the upstream v2.0.0 baseline to the official v2.1.1 release while preserving all local security, routing, deployment, and provider-header behavior.

## Background

- Current common base: `1551b3e` (`v2.0.0`).
- Target release: `v2.1.1` at `9c540b4` (2026-08-03).
- Upstream delta: 23 release commits between the common base and `v2.1.1`.
- The six commits on `upstream/main` after `v2.1.1` are unreleased and excluded.
- A dry merge reports 19 content conflicts, concentrated in package manifests, changelogs, Playground/Simulator code, and documentation.
- No new SQL migration exists in this release delta.
- `packages/admin/lib/services/admin/providers-service.ts` auto-merges and retains both the local `custom_headers` PATCH fix and upstream's provider-delete route-reference guard.

## Requirements

- R1: Adopt every committed change contained in the official `v2.1.1` tag, and no unreleased `upstream/main` changes.
- R2: Preserve local provider custom headers end to end, including PATCH persistence, protocol-specific egress injection, and mutation-verified regression tests.
- R3: Preserve local gateway API-key hashing and admin-session HMAC verification.
- R4: Preserve local route behavior and production-oriented deployment changes, including Custom Domain plus `workers.dev` fallback and disabled Preview URLs.
- R5: Preserve existing migration numbering and deployed D1 compatibility; do not create or reapply migrations when upstream has none.
- R6: Adopt upstream v2.1.1 error-code contracts, user+model circuit-breaker changes, failover cooldown changes, AI Detection/tools pricing, and provider deletion protection.
- R7: Resolve conflicts semantically. For upstream structural rewrites, use upstream as the baseline and graft the local behavior back onto its extension points.
- R8: Keep the branch and production database recoverable throughout the upgrade.

## Acceptance Criteria

- [ ] Git history contains the official `v2.1.1` tag ancestry and all intentional local commits.
- [ ] No commit after `v2.1.1` from `upstream/main` is included.
- [ ] All 19 merge conflicts are resolved with zero conflict markers or unmerged paths.
- [ ] Package versions and lockfile consistently resolve to 2.1.1 where upstream owns package versioning.
- [ ] Full lint, type-check, build, package tests, and deployment tests pass.
- [ ] Local custom-header PATCH regression tests pass and still fail under deliberate source mutation.
- [ ] Gateway API-key hashing, admin-session HMAC, route preference semantics, provider custom headers, Custom Domains, `workers.dev`, and `preview_urls: false` are present and wired.
- [ ] Upstream error codes, circuit-breaker behavior, tool engines, AI Detection, tools pricing, provider deletion guard, and model preset updates are present and wired.
- [ ] No new D1 migration is required; production migration state remains at `0018`.
- [ ] A rollback point exists before any production deployment.
- [ ] The final merge is committed and pushed to the configured remotes.

## Out of Scope

- The six unreleased commits after `v2.1.1` on `upstream/main`.
- New features beyond upstream v2.1.1 and existing fork behavior.
- Provider-key reconfiguration, which the user has already completed.
- End-to-end audio transcription testing, deferred by the user.
- Production deployment; this task ends after merge, verification, and push. Production rollout will be a separate reviewed step.
