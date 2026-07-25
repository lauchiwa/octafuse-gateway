# Logging Guidelines — `@octafuse/proxy`

> `console.*` + Hono logger, structured where it matters, always redact secrets.

---

## Overview

- HTTP access logging: Hono `logger()` middleware, mounted first in `app.ts`.
- Cloudflare observability is enabled in `wrangler.base.jsonc` (`observability.enabled: true`, `head_sampling_rate: 1`).
- App-level logs use `console.log` / `console.warn` / `console.error`. There is no separate logging library — keep it that way for Worker compatibility.

---

## Log Levels

| Level | Use for |
|-------|---------|
| `console.log` | Normal request lifecycle milestones (e.g. `[Gateway Auth] key valid keyId=… userId=…`) |
| `console.warn` | Recoverable / client-fault conditions (401 missing key, invalid key) |
| `console.error` | Unexpected server faults; include a `requestId` for correlation |

---

## Structured Logging

- Prefix subsystem logs with a bracket tag: `[Gateway Auth]`, etc.
- For error paths, log an object with a `requestId` (`crypto.randomUUID()`) and structured error details — mirror `lib/api-error.ts` in admin (`{ requestId, route, error: { name, message, stack } }`).

---

## What to Log

- Auth outcome with `keyId` / `userId` (never the key itself).
- Routing decisions and failover transitions (which route/provider-key was tried).
- Circuit-breaker trips and rate-limit rejections.

---

## What NOT to Log

- **Never** log the full API key. Use `maskKey()` (`${key.slice(0,8)}...${key.slice(-4)}`).
- **Never** log upstream provider API keys, request bodies with prompt content, or connection strings. Redact DB URLs with the `redactDatabaseConnectionUrl` pattern (`password = '***'`) as in `runtime/node.ts`.
- Request logs persisted to the DB already redact messages/multimodal data via `openAiBodyRedactedForLog` and `finalizeRequestLogJson` — reuse those, don't hand-roll redaction.
