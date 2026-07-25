# Logging Guidelines — Admin Backend (BFF)

> Structured `console.*` logging that works on both Cloudflare Workers and Node.

---

## Overview

There is no logging library. The BFF uses the platform `console` (captured by Cloudflare observability on Workers, stdout on Node) plus Hono's `logger()` middleware for request lines.

```ts
// lib/admin-app.ts
app.use('*', logger());
```

---

## Log Levels

- `console.error` — unexpected failures (via `handleGatewayApiError`), always with a `requestId`.
- `console.warn` — recoverable/auth anomalies (e.g. rejected login).
- `console.log` — coarse operational milestones only; avoid per-request chatter beyond Hono's `logger()`.

---

## Structured Logging

- Pass a **string label + object**, not string concatenation: `console.error('Gateway API error', { requestId, route, error })`.
- Include a correlation id (`requestId` from `crypto.randomUUID()`) on any error path so the client-returned `error.requestId` can be found in logs.
- Use a stable `route` label (`gateway.<resource>.<METHOD>`) so logs are greppable.

---

## What to Log

- Boundary errors with `requestId`, `route`, normalized error details.
- Auth failures (without the credential value).
- Storage/driver resolution problems.

---

## What NOT to Log

- **`MASTER_KEY`, `ADMIN_PASSWORD`, session tokens, upstream provider API keys** — never.
- Full request/response bodies (may contain user prompts / PII).
- Raw connection strings — redact credentials (see `redactDatabaseConnectionUrl` in the Proxy Node runtime for the pattern).

See repo-wide [`docs/CONVENTIONS.md`](../../../../docs/CONVENTIONS.md) §2 for the sensitive-value rules that also apply to log output.
