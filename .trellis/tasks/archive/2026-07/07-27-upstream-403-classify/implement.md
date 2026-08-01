# Implement — distinguish request-identity 403 from credential 403

## What shipped

1. [x] `packages/proxy/src/services/upstream-failure-classifier.ts`
   - `classifyUpstreamHttpFailure(status, bodyText?)` — new optional second param; the
     status-only path is byte-for-byte the old behaviour.
   - `looksLikeClientIdentityRejection(bodyText)` — exported predicate, case-insensitive,
     first 4096 chars only, conservative allow-list of signatures.
   - `UpstreamFailureClassification.clientIdentityRejected?: boolean`.
   - The new branch is guarded on `status === 403` only, per PRD R6.
2. [x] `packages/proxy/src/services/failover-dispatch.ts`
   - Reads `await response.clone().text()` for **403 only**, wrapped in try/catch that
     degrades to `null`.
   - Passes it to the classifier; `shouldFailImmediatelyForImageAbort` still short-circuits
     ahead of it.
   - `logKeySwitchAlert` gained an early `clientIdentityRejected` branch that says the key
     was left healthy instead of reporting a "provider key auth issue".
3. [x] `packages/proxy/src/services/upstream-failure-classifier.test.ts` — **rewritten**.
   It was 42 lines importing from `vitest`, a package not installed anywhere in this repo,
   so it could never run. Now `node:test` + `node:assert/strict`, 17 cases.
4. [x] Registered that file in proxy `test:unit` (it was not in the list, which is why
   nobody noticed it was dead — PRD acceptance criterion 1).

No migration, no schema change, no config. Rollback is a plain code revert.

## Verification (all run)

| Check | Result |
|---|---|
| core `test:unit` | 164 pass / 0 fail |
| proxy `typecheck` | clean |
| proxy `test:unit` | 78 pass / 0 fail (was 62 with 1 failure — the dead vitest file) |
| admin `typecheck` | clean |
| admin `test:unit` | 96 pass / 0 fail |
| admin `lint` | 0 errors, 7 pre-existing warnings (unchanged) |

### Mutation check on the 403-only guard

Dropping `status === 403 &&` from the condition makes exactly one test fail
("keeps 401 on the auth path even when the body matches a client-restriction signature").
So R6 is genuinely pinned, not just asserted in prose. Restored after checking.

### R4 checked directly, not just by reading

Ran a standalone script against the real `Response` API: `clone().text()` for the sniff,
then `text()` on the original for the log path. Both returned the full body and they were
equal. `bodyUsed` on the original stayed `false` until the second read. So
`materializeNonOkResponse` still works after classification.

### R2 checked by reading the branch

The `fail_immediately` path in `failover-dispatch.ts` returns the untouched upstream
`response` object. The caller therefore receives the upstream's own 403 status and body,
not a synthesized local error. `markProviderKeyFailure` is only reached when
`classification.failureKind` is set, which this classification deliberately omits.

## NOT verified

- **No live re-run against the relay that produced the original 403.** The regression this
  fixes was observed end-to-end on 2026-07-27, but the fix itself has only been proven at
  the unit level plus the two targeted checks above. The acceptance criterion "after a
  client-restricted 403, a subsequent request still reaches the upstream" is verified by
  construction (no `failureKind` → no `markProviderKeyFailure` call), not by a live run.
- Signature coverage is limited to bodies actually observed from this one new-api relay
  and Cloudflare. Other relay families may phrase client restrictions differently and will
  fall through to the old `auth` behaviour — by design (R5), but it does mean the same
  masking bug can recur with a different upstream's wording.

## Follow-up worth considering

If another relay family turns up with a different phrasing, add the signature rather than
loosening the matcher. Broad matching here would silently disable failover on real
credential rotation, which is the failure mode this design deliberately avoids.

---

# Merged to main 2026-07-28 (merge commit on `main`, branch tip `215b5e5`)

Merged after Responses phase 2, so this landed on a `main` that already had the phase 2
translators. One conflict: `packages/proxy/package.json`'s `test:unit` file list — phase 2 had
appended 4 files, this branch 1. Resolved as a union of both (15 files, no duplicates, all
present on disk); no other file this branch touches was modified on `main` since the merge base.

Re-verified on the merge result, not just on the branch:

| Check | Result |
|---|---|
| core `test:unit` | 164 pass / 0 fail |
| proxy `test:unit` | 190 pass / 0 fail (173 phase-2 baseline + 17 classifier) |
| admin `test:unit` | 96 pass / 0 fail |
| proxy + admin `typecheck` | clean |
| `verify:package-versions` | OK, all 1.10.2 |

The branch's own record said "proxy 78" — that was its pre-phase-2 baseline, not a discrepancy.

A changeset was missing (`.changeset/upstream-403-classify.md`) and was added at merge time;
without it the fix would ship unversioned on the next release.

## Still not verified (unchanged by the merge)

No live re-run against the relay that produced the original 403. Worth pairing with the
outstanding Responses acceptance run in `07-26-responses-api`: `muyuan.do` returning
`403 channel:client_restricted` is what blocked that run, and this fix is what makes the real
upstream status visible instead of a local 429.
