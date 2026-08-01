# Distinguish request-identity 403 from credential 403

Follow-up to the 2026-07-27 Codex debugging session. Filed as finding I8 during the
phase-1 planning review, then observed for real.

## What happened

`upstream-failure-classifier.ts` maps **any** 401/403 to
`{ action: 'retry_key', alertOnKeySwitch: true, failureKind: 'auth' }`.

`failover-dispatch.ts:395-404` then calls `recordProviderKeyFailure(..., 'auth', ...)`,
which opens a circuit on that provider key.

Observed chain (local worker, real upstream, 2026-07-27):

```
upstream 403  This channel does not allow the current client (detected: codex_exec/…)
  -> classified as failureKind='auth'
  -> circuit opens on pk-relay (the provider's ONLY key)
  -> every later request returns local 429
     "All upstream keys are rate limited or cooling down. Please retry after 600 seconds."
  -> Codex retries 5x, gives up
```

The provider key was **valid** — direct curl with the same key returned 200 both before
(12:05:20) and after. The 403 was about *who was calling*, not *which credential*.

## Why it matters beyond this one relay

1. **A request-identity fault disables a working credential.** On a single-key provider
   that takes the whole provider offline for the cooldown window.
2. **It hides the real error.** Once the circuit is open, every response is a local 429.
   During this session that mask caused several wrong diagnoses before the request log
   revealed the original 403 body.
3. **It fires a false alert.** `alertOnKeySwitch` logs "provider key auth issue" and can
   trigger the error webhook for something that is not a key problem.

## Requirements

- R1: A 403 whose body indicates a **client/request restriction** must NOT open an `auth`
  circuit on the provider key.
- R2: Such a 403 must surface the upstream's original status and message to the caller,
  rather than being replaced by a later local 429.
- R3: A genuine credential 403/401 (invalid/revoked/quota-less key) must keep today's
  behaviour: try the next key, open an `auth` circuit, alert.
- R4: Classification must not consume the response body that the route layer later reads
  via `materializeNonOkResponse` (`routes/v1/{chat,messages,responses}.ts`). Clone or
  read a bounded prefix.
- R5: Detection must be conservative. When the body is unavailable, unreadable, or
  ambiguous, fall back to today's `auth` classification — under-detecting is safe,
  over-detecting would stop failover from working on real credential rotation.
- R6: 401 keeps current behaviour unconditionally. Only 403 is ambiguous; 401 is
  specifically an authentication failure.

## Evidence to base detection on

Real bodies seen from this relay (new-api family):

```json
{"error":{"code":"channel:client_restricted",
          "message":"This channel does not allow the current client (detected: …)",
          "type":"new_api_error"}}
```

and a Cloudflare challenge page (`text/html`, "Sorry, you have been blocked").

Both are request-identity rejections. Neither says anything about the credential.

## Constraints

- `classifyUpstreamHttpFailure(status: number)` is currently pure and synchronous, with a
  registered-but-unwired test file. Changing the signature touches `failover-dispatch.ts`
  and affects **all four protocols**; keep the pure status-only path intact for callers
  that have no body.
- The classifier runs on the failover hot path — no unbounded body reads.
- Do not regress: `provider-key-circuit-breaker` behaviour for 429 / 5xx / 524 / fetch
  failures is unchanged.

## Acceptance Criteria

- [ ] `classifyUpstreamHttpFailure` still works status-only and its existing test file is
      wired into `test:unit` (it is currently NOT registered, so it never runs).
- [ ] A 403 with a `client_restricted`-style JSON body classifies as
      `fail_immediately` with **no** `failureKind` → no circuit, no alert.
- [ ] A 403 with a Cloudflare challenge HTML body classifies the same way.
- [ ] A 403 with an empty / unreadable / unrelated body keeps `failureKind: 'auth'` (R5).
- [ ] A 401 with any body keeps `failureKind: 'auth'` (R6).
- [ ] After a client-restricted 403, a subsequent request to the same provider still
      reaches the upstream (no local 429) — regression test for the observed failure.
- [ ] The caller receives the upstream's 403 status and its message, not a local 429.
- [ ] `materializeNonOkResponse` in all four route files still reads a full body after
      classification (R4) — no "body already consumed" error.
- [ ] proxy typecheck + `test:unit` green; no change to 429/5xx/524/fetch handling.

## Out of scope

- Locating why this relay rejects Codex's request. Ruled out by experiment: egress IP,
  `cf-worker` header, and UA value alone (curl with Codex's UA returns 200). Unresolved
  and not needed for this fix.
- Any change to circuit-breaker windows or thresholds.
