# Merge upstream v2.1.1 — Outcome

## Result

Merged the official `v2.1.1` tag (`9c540b4`) into the fork. Integrated to `main` and pushed to `github` + `origin` at `492137e`. Production deployment was explicitly out of scope.

Commits:

| SHA | Purpose |
|---|---|
| `c8346b1` | Merge upstream v2.1.1 into fork (23 upstream commits, 19 conflicts resolved) |
| `658b32f` | Pin the merge seam for the OpenAI Responses surface (new test suite) |
| `810878a` | Correct migration names / version baseline in three auto-merged docs |
| `492137e` | Record merge lessons in spec + upstream-sync divergence doc |

Release boundary held: `v2.1.1` is an ancestor of `HEAD`, and all six unreleased `upstream/main` commits (`4ed8e08`, `b2a18b7`, `2666c04`, `76a0073`, `9be525e`, `6060ec8`) are absent.

## Conflict decisions

**Playground / Simulator (structural).** Upstream rewrote these for Agent Tools; the fork carries the OpenAI Responses surface. Took upstream as the baseline and re-expressed the fork's behavior through upstream's shared `lib/invoke-kind.ts` mapping rather than reinstating per-call-site branching. Added `openaiSurface` to `resolveRequestOperation`, `resolveOpenaiUpstreamCapability`, and `resolveProxyPathForModelInvoke` so URL, upstream capability, and route operation derive one semantic from one place.

**Positional parameters.** Both sides appended a trailing optional param to `bodyTemplateForSelection` / `isBodyDirty` (upstream `toolId`, fork `openaiSurface`). Keeping both forced an order; three existing call sites were then passing `openaiSurface` into the `toolId` slot. Both are string-shaped, so it type-checked silently. Fixed all three and added the exported `bodyDirty` surface param.

**Migration numbering.** All changelogs and operator docs keep the fork's `0017`/`0018`. Upstream's `0015`/`0016` names would send an operator at filenames this fork does not ship, and migration identity is the full filename.

**Manifests.** Root `package.json` keeps `test:db` alongside upstream's `verify:proxy-bundle`; proxy `test:unit` is the union of both sides' lists (upstream dropped the fork's Responses/classifier tests). Dropped the stale `./services/provider-key-crypto` export — the file was deleted back in 2.0.0. Regenerated `package-lock.json` from merged manifests instead of splicing conflict blocks.

## Defects found that no conflict marker pointed at

1. **`/v1/responses` left behind by an upstream deletion.** Upstream replaced `sensitive-content-circuit-route` with `user-model-circuit-route` and migrated its own `chat`/`messages`/`gemini` routes. The fork-only route kept the dead import — typecheck caught that. What typecheck could not catch: upstream's migration also added `markUserModelSuccess()` on the success path, which the fork route never had. Fixing only the import would have compiled, passed every test, and left `/v1/responses` with a backoff ladder that never resets after a success. All four routes now agree.

2. **A guard that could not fail.** The Responses surface was centralized behind `resolvesToResponsesSurface(kind, protocol, surface)`. Mutating away its `kind`/`protocol` conditions turned no test red, because both call sites already narrow to `llm` + `openai` before calling it. The conditions were unreachable documentation, not protection. Simplified to a direct surface check and pinned the real call-site protection with tests.

3. **Three conflict-free docs reverted fork facts.** `cloudflare-quickstart.md` (claimed 2.0.0 / 16 migrations), `route-topology.md`, and `packages/core/README.md` auto-merged with no conflict and reintroduced upstream's `0015`/`0016` filenames. Conflict-free is not correct.

## Verification

| Check | Result |
|---|---|
| admin + proxy typecheck | clean |
| admin lint | 0 errors, 7 pre-existing warnings |
| core / proxy / admin builds | pass (admin OpenNext build includes new tools routes) |
| `verify:package-versions` | all packages == 2.1.1 |
| `verify:proxy-bundle` | no `@octafuse/*` externals |
| unit tests | 543 pass (pre-merge baseline 514) |
| i18n parity | en/zh/ja/ko structurally identical, 1396 keys each |
| production D1 | "No migrations to apply" — still at `0018`, v2.1.1 adds none |

**Mutation proofs.** `custom_headers` PATCH regression: `body`→`patch` fails 4/5; moving the branch after the empty-patch early return fails 3/5. New merge-seam suite: checking surface before protocol in `resolveRequestOperation`, hoisting it above the protocol branches in `resolveProxyPathForModelInvoke`, and dropping it from `resolveOpenaiUpstreamCapability` each fail 1/6.

**Both-direction audit** (call sites, not file existence). Fork: custom headers in 7 egress drivers + `RouteResult` + Playground; `hashApiKey` at auth; admin HMAC; `/v1/responses` mounted; `preferWithinTier` passed through. Upstream: tool-engines imported by proxy and admin; tools routes mounted; `X-OctaFuse-Error-Code` emitted; user+model circuit in 6 route files; provider delete guard.

**Ordering semantics.** Upstream's new in-request circuit re-check only `continue`s past cooling providers — it never reorders — so the fork's tier-local preference survives. `route-attempt-planner` + `failover-dispatch` suites: 21 pass.

## Follow-ups

- Production deployment of v2.1.1 is pending and deliberately separate. Worth regression-checking on deploy: CHY → ioll.pp.ua failover, the new `401/403` cooldown (10min → 5min), and error-code responses.
- `npm audit` reports 13 upstream dependency vulnerabilities (2 low, 1 moderate, 10 high). Unrelated to this merge; handle separately.
