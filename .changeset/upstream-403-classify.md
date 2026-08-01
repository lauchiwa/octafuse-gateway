---
"@octafuse/proxy": patch
---

Stop circuit-breaking provider keys on a client-identity `403`.

An upstream `403` was always classified as `failureKind='auth'`, which opened a circuit on the
provider key. On a single-key provider that took the whole provider offline for the cooldown
window and turned every subsequent request into a local `429`, masking the real upstream error.

- `classifyUpstreamHttpFailure()` accepts an optional `bodyText`; a `403` whose body matches a
  known client-restriction signature returns `fail_immediately` with `clientIdentityRejected`
  and no `failureKind`, so the upstream status and message reach the caller untouched.
- `401` keeps its unconditional `auth` classification — only `403` is ambiguous.
- `failover-dispatch` reads the body via `response.clone()` on `403` only, leaving the original
  readable for `materializeNonOkResponse`.
- `logKeySwitchAlert` distinguishes client-identity rejection from key failure.
