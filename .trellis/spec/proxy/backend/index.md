# `@octafuse/proxy` — Backend Guidelines

> The edge/runtime gateway Worker. Terminates client requests on OpenAI / Anthropic / Gemini protocols, resolves model routing, dispatches to upstream providers with failover, and records usage/billing asynchronously.

See [`../../architecture.md`](../../architecture.md) for the monorepo overview.

---

## What lives here

`packages/proxy` is a **Hono app** (`src/app.ts`) served two ways from the same code:

- **Cloudflare Worker** — `src/index.ts` (D1 binding `DB`).
- **Node server** — `src/runtime/node.ts` (`@hono/node-server`, Postgres/MySQL via `DATABASE_URL`).

All persistence goes through `@octafuse/core` repositories. The proxy never talks to a database driver directly — it resolves a `StorageContext` and reads `c.get('repositories')`.

---

## Pre-Development Checklist

Before writing code in this package:

1. Read [`directory-structure.md`](./directory-structure.md) — where routes, services, egress drivers, and runtime adapters live.
2. Read [`error-handling.md`](./error-handling.md) — how upstream failures are classified and how failover/circuit breaking works.
3. Read [`database-guidelines.md`](./database-guidelines.md) — repositories are the only DB access; usage recording is async/background.
4. Read [`logging-guidelines.md`](./logging-guidelines.md) — `console.*` + `hono/logger`, key masking rules.
5. Read [`quality-guidelines.md`](./quality-guidelines.md) — runtime-neutral code, streaming/billing correctness, test conventions.
6. Confirm your change works on **both** runtimes (Worker + Node). Never import `node:*` or use `process.env` outside `src/runtime/` — use `readProxyEnv()`.

---

## Guidelines Index

| Guide | Description |
|-------|-------------|
| [Directory Structure](./directory-structure.md) | routes / services / egress / runtime layout |
| [Database Guidelines](./database-guidelines.md) | repository access, async usage recording |
| [Error Handling](./error-handling.md) | upstream failure classification, failover, circuit breakers |
| [Logging Guidelines](./logging-guidelines.md) | structured `console.*`, key masking |
| [Quality Guidelines](./quality-guidelines.md) | runtime neutrality, streaming correctness, tests |

---

## Quality Check (run before marking work done)

- `npm run typecheck -w @octafuse/proxy` passes.
- `npm run test:unit -w @octafuse/proxy` passes.
- No `node:*` import or `process.env` access outside `src/runtime/`.
- Any new upstream call routes through an egress driver and updates `RequestTimingCollector`.
- Usage/billing side effects run via `scheduleBackgroundWork`, never blocking the client response.

---

**Language**: Documentation in English; inline code comments follow the existing bilingual (中文/English) style of neighbouring files.
