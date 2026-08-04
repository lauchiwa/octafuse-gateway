# Merge upstream v2.1.1 - Technical Design

## Merge Boundary

- Base branch: current local `main` at `58f5fd6`.
- Upstream target: annotated tag `v2.1.1` at `9c540b4`.
- Strategy: create `merge-upstream-v2-1-1` from local `main`, then perform a non-fast-forward merge of the tag.
- Exclusion boundary: verify `v2.1.1..HEAD` does not contain any of the six unreleased `upstream/main` commits.
- Integration result: one explicit merge commit preserving both upstream and local histories.

## Preservation Boundaries

### Local behavior that must survive

1. Provider `custom_headers` schema, repository mappings, Admin mutation conversion, Playground injection, and OpenAI/Anthropic egress merge behavior.
2. Gateway `sk-` API-key SHA-256 hashing and prefix storage.
3. Admin-session HMAC signature verification.
4. Existing migration sequence through `0018`, including production-compatible D1 state.
5. Route and Responses behavior added after the previous upstream merge.
6. Cloudflare deployment automation, Custom Domain configuration, `workers_dev: true`, and `preview_urls: false`.
7. Trellis project metadata and upstream-merge operating guidance.

### Upstream behavior that must be adopted

1. `@octafuse/tool-engines`, AI Detection, tools pricing, and shared engine clients.
2. Stable gateway error codes and `X-OctaFuse-Error-Code` responses.
3. Consolidated user+model circuit breaking and adjusted failover cooldown semantics.
4. Provider deletion protection while model routes reference it.
5. Qwen model preset updates and all v2.1.1 documentation/contracts.

## Conflict Resolution Strategy

### Structural application conflicts

For Playground/Simulator files rewritten by upstream:

1. Read the upstream v2.1.1 file as the new baseline.
2. Identify the local semantic delta from `1551b3e..main`.
3. Reapply only the still-required local delta to the upstream structure.
4. Verify cross-file types and data flow, not just local compilation.

Expected semantic deltas include custom upstream headers, protocol/surface preview behavior, and local route simulation additions.

### Package manifests and lockfile

- Keep upstream package versions (`2.1.1`) and tool-engine workspace additions.
- Preserve local scripts/dependencies/configuration that remain necessary.
- Regenerate `package-lock.json` with the repository's npm version after manifest resolution instead of hand-splicing lockfile conflict blocks.

### Changelogs and documentation

- Preserve both histories in chronological order.
- Keep local deployment and migration instructions when they describe the deployed fork.
- Adopt upstream v2.1.0/v2.1.1 API and runtime documentation.
- Ensure no executable path or migration filename regresses to upstream numbering.

### Provider service

The dry merge shows no textual conflict. Post-merge review must verify both branches of intent:

- `customHeaders` is checked on `body`, converted to `custom_headers`, and added before the empty-patch early return.
- delete checks `listModelRoutesWithJoins({ providerId })` and raises conflict before deleting.

## Data Compatibility

- Upstream v2.1.1 adds no SQL migration; production remains at migration `0018`.
- Existing provider keys and custom headers must not be transformed or rewritten.
- No D1 commands are needed for this code merge.
- Production deployment is explicitly deferred.

## Verification Model

1. Git integrity: target ancestry, unreleased-commit exclusion, no unmerged paths.
2. Static integrity: JSON parsing, conflict-marker scan, lint/type-check.
3. Package integrity: lockfile consistency and package-version checks.
4. Behavior tests: full core/proxy/admin suites plus deployment tests.
5. Fork invariants: targeted tests for custom headers, API-key hash, admin auth, route planning, and deployment config generation.
6. Upstream invariants: targeted tests for circuit breakers, error codes, provider deletion protection, tool pricing, and AI Detection.
7. Mutation proof: deliberately break the custom-header PATCH binding, run its regression test expecting failure, then restore and rerun green.

## Rollback

- Before merge: local `main` remains unchanged; work occurs on `merge-upstream-v2-1-1`.
- During conflicts: `git merge --abort` returns the branch to the pre-merge state.
- After commit but before integration: delete the merge branch or reset only that branch to its pre-merge commit.
- No production rollback is required because deployment is out of scope.
