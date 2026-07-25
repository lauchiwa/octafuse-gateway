# Error Handling — `@octafuse/core`

> `core` is a library, not an HTTP surface. It throws/returns typed results; the runtimes (`proxy`, `admin`) decide the wire response.

---

## Overview

- `core` functions **throw** on invariant violations (bad driver config, unreachable DB) and **return typed result objects** for expected failure modes (validation, "not found", budget outcomes).
- Config resolution fails loud: `resolveNodeDatabaseConfig(process.env)` throws when `DATABASE_URL` is missing or `DATABASE_DRIVER` is inconsistent — this surfaces at process start / first request, not deep in a query.
- No `console.*`-based error swallowing in library code; let callers log with their request context.

---

## Error / Result Patterns

- **Discriminated result objects** for expected failures:
  ```ts
  // e.g. serializers, parsers in lib/*
  { ok: true; json: string } | { ok: false; error: string }
  ```
  Callers branch on `.ok` — see admin's `serializeDraftRowsToProfileJson` usage in `model-api.ts`.
- **`null` for "not found"** on repository reads (`fetchModelDetail` → throws only on transport error; a missing row is `null`).
- **Throw `Error` with a specific message** for programmer/config errors (invalid driver, malformed connection string).

---

## API Error Responses

Not `core`'s job. `core` never builds `Response` objects. The runtimes own that:
- Proxy/admin BFF: `handleGatewayApiError()` (admin `lib/api-error.ts`) → `{ success: false, message, error: { requestId } }` with status 500.
- Hono route handlers: `c.json({ error: '...' }, <status>)`.

---

## Common Mistakes

- **Returning a half-baked `Response` from core.** Keep core transport-agnostic.
- **Silently defaulting an invalid driver.** `DATABASE_DRIVER` inconsistency must throw, per the Node runtime contract.
- **Logging secrets in error paths.** Connection strings are redacted before logging (`redactDatabaseConnectionUrl` in proxy `runtime/node.ts`); mirror that if you add core-side diagnostics.
