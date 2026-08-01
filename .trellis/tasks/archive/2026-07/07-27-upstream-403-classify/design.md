# Design — distinguish request-identity 403 from credential 403

Decision (owner, 2026-07-27): **option A** — when a 403 body carries a known
client-restriction signature, classify it `fail_immediately`, leave the provider key
healthy, and hand the upstream's original error back to the caller.

## Where the fix goes

`classifyUpstreamHttpFailure` gains an **optional** second parameter:

```ts
classifyUpstreamHttpFailure(status: number, bodyText?: string | null)
```

Optional, not required, because the function is pure and is the single classification
point for all four protocols. Callers without a body (and the fetch-failure path) keep
working unchanged, so the blast radius is one call site in `failover-dispatch.ts`.

The detector is a separate exported predicate, `looksLikeClientIdentityRejection`, so it
can be unit-tested on its own and reused if another layer ever needs the same question
answered.

## 403 only, not 401

The PRD's R6 is the load-bearing constraint here. `401` means *authentication failed* —
that is a statement about the credential, so it always belongs on the `auth` path.
`403` is the ambiguous one: *authenticated, but refused*, which may be about the
credential's permissions **or** about who is calling. Only 403 gets its body sniffed.

This is also why the dispatch side only clones on 403 — one fewer body read on the
401 path, and the asymmetry is deliberate rather than incidental.

## Detection signatures

Conservative allow-list, matched case-insensitively against the first 4096 chars:

| Signature | Source |
|---|---|
| `client_restricted` | new-api / one-api `channel:client_restricted` error code |
| `does not allow the current client` | the same family's human-readable message |
| `<!doctype html` **and** `cloudflare` | Cloudflare WAF challenge page |
| `attention required` **and** `cloudflare` | Cloudflare block page title |
| `you have been blocked` | Cloudflare block page body |

The two Cloudflare HTML rules require *both* markers. A body that merely mentions
Cloudflare (plenty of upstreams sit behind it and say so in headers or JSON) must not be
read as a WAF block.

**Bounded read.** Slicing to 4096 chars before lowercasing keeps this off the failover
hot path's tail latency for large HTML error pages. The trade-off is explicit: a
signature buried past 4KB is missed, and missing it is the safe direction.

**Fail-safe direction.** No body, unreadable body, or unrecognised body → today's
`auth` behaviour. Under-detecting costs one wrongly-opened circuit; over-detecting would
break failover on genuine credential rotation, which is worse.

## Body read without breaking the log path

R4: the route layer later calls `materializeNonOkResponse` on the same response to build
the request log. So the classifier's read must not consume it:

```ts
if (response.status === 403) {
  try { forbiddenBodyText = await response.clone().text(); } catch { forbiddenBodyText = null; }
}
```

`clone()` before `text()`, and the `catch` is what makes R5's fallback real rather than
theoretical — a clone can fail if the body was already disturbed, and that must degrade
to the old behaviour instead of throwing on the failover path.

## Alerting

`logKeySwitchAlert` gets an early branch on `clientIdentityRejected`. Without it the
existing message ("provider key auth issue") would either stay silent or actively
mislead the next person debugging. The new line states plainly that the *client identity*
was rejected and that the key was left healthy. Per the proxy logging guidelines:
`console.warn`, `[Gateway Proxy]` prefix, ids only — no key material.

## Why this ends the observed failure

The chain was: 403 → `failureKind: 'auth'` → circuit opens on the provider's only key →
every later request becomes a local `429 … retry after 600 seconds`. Returning
`fail_immediately` with no `failureKind` cuts it at the second link: `failover-dispatch`
only calls `markProviderKeyFailure` when `classification.failureKind` is set, and the
`fail_immediately` branch returns the untouched upstream `response`, so the caller sees
the real 403 and its message.

## Not addressed

Why this particular relay rejects Codex's request. Ruled out by experiment (egress IP,
`cf-worker` header, UA value alone). This fix makes the rejection *visible* instead of
masked, which is what was actually needed to keep debugging it.
