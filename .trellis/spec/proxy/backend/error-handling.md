# Error Handling — `@octafuse/proxy`

> Upstream failures are a routing signal, not just an exception. Classify, failover, then record.

---

## Overview

The proxy sits between end-user SDKs and upstream providers. Its error model has three concerns that must not be conflated:

1. **Client-facing HTTP errors** — auth failures, budget exceeded, bad request. Returned immediately as JSON.
2. **Upstream failures** — classified (`services/upstream-failure-classifier.ts`) to decide retry / failover / circuit-break.
3. **Billing correctness on partial failure** — a stream that dies mid-flight must still be recorded with the right status (`incomplete`).

---

## Client-facing errors

Return via Hono `c.json(body, status)`:

```ts
if (!key) {
  console.warn('[Gateway Auth] 401: missing API key in supported auth locations');
  return c.json({ error: 'Missing or invalid API key' }, 401);
}
// ...
return c.json({ error: 'Budget exceeded' }, 403);
```

- `401` — missing / invalid API key.
- `403` — budget exceeded (after model resolution for chat/images; up front for other routes; see `middleware/auth.ts`).
- Do not leak upstream provider identities or keys in client error bodies.

---

## Upstream failures & failover

- Every non-OK upstream response is passed through `upstream-failure-classifier.ts` to decide whether to failover to the next provider key/route.
- Failover across provider keys is orchestrated by `failover-dispatch.ts`, honoring sticky bindings (`sticky-key-binding.ts`), circuit breakers (`provider-key-circuit-breaker.ts`), and rate limits (`provider-key-rate-limiter.ts`).
- Sensitive-content circuit breaking (`sensitive-content-circuit-route.ts`) can pre-block a route or trip on upstream signals — check both `maybeBlockSensitiveContentCircuit` (before) and `maybeTriggerSensitiveContentCircuitFromUpstream` (after).

---

## Streaming & billing correctness

- Streams parse `usage` per SSE line; the **last** usage snapshot wins (`egress/openai-driver.ts`).
- If a stream never yields usage, `USAGE_SAFETY_TIMEOUT_MS` (5 min) bounds the wait before recording the request as `incomplete`.
- After a client disconnects, the driver keeps draining the upstream up to `POST_DISCONNECT_DRAIN_MS` (90 s) to capture trailing usage.
- Compute final status with `computeRequestLogStatus`; materialize non-OK bodies with `materializeNonOkResponse` for the log.

---

## Common Mistakes

- **Treating any non-200 as fatal.** Many are retryable/failover-able — always classify first.
- **Recording usage before the stream ends.** Usage is only final at stream close (or safety timeout).
- **Forwarding upstream cumulative `usage` verbatim** to the client — some providers send running totals that SDKs re-accumulate. Strip mid-stream usage per `transformStreamUsageForClient` semantics.
