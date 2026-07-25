# Admin Backend Development Guidelines

> The **Admin BFF** layer: the Hono sub-app + Next.js API routes that sit between the Admin UI and `@octafuse/core`.

---

## Overview

`@octafuse/admin` is a **Next.js 16 + OpenNext on Cloudflare** app. Its "backend" is a Backend-for-Frontend (BFF):

- **Next.js route handlers** under `app/api/**` (auth, locale, and a catch-all that forwards to Hono).
- A **Hono sub-app** (`lib/admin-app.ts`) mounting `/admin/*` handlers. It is exposed to the browser as `/api/admin/*`.
- **Admin services** (`lib/services/admin/*`) that call `@octafuse/core` repositories.

The Admin BFF **owns no SQL of its own** — all persistence goes through `@octafuse/core` repositories resolved from the D1 binding (`DB`) or a Node Postgres/MySQL connection. See [architecture.md](../../architecture.md) and [`packages/admin/AGENTS.md`](../../../../packages/admin/AGENTS.md).

---

## Guidelines Index

| Guide | Description |
|-------|-------------|
| [Directory Structure](./directory-structure.md) | Route handlers, Hono app, services, lib layout |
| [Database Guidelines](./database-guidelines.md) | Storage-context resolution, no raw SQL in admin |
| [Error Handling](./error-handling.md) | `{ success, data?, message? }` contract, `handleGatewayApiError` |
| [Logging Guidelines](./logging-guidelines.md) | `console.*` structured logging, requestId correlation |
| [Quality Guidelines](./quality-guidelines.md) | ESLint (next), tabs, tests, forbidden patterns |

---

## Pre-Development Checklist

- [ ] Does a `@octafuse/core` service/repository already cover this data access? Do not write SQL in admin.
- [ ] New `/admin/*` route → mount it in `lib/admin-app.ts` and expose via the `/api/admin/[...path]` catch-all.
- [ ] Auth: does this route need cookie session or `MASTER_KEY` bearer? Both are handled at `app/api/admin/[...path]/route.ts`.
- [ ] Response shape follows `{ success, data?, message? }`.
- [ ] Any user-visible string is passed through `next-intl` — see [admin frontend index](../frontend/index.md).

## Quality Check

- [ ] `npm run lint -w @octafuse/admin` passes.
- [ ] `npm run typecheck -w @octafuse/admin` passes.
- [ ] `npm run test:unit -w @octafuse/admin` passes (when logic is testable).
- [ ] No secrets or raw upstream keys logged or returned.

---

**Language**: All documentation should be written in **English**.
