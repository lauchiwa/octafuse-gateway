# Quality Guidelines — Admin Backend (BFF)

> Standards for the Hono BFF + Next route handlers.

---

## Overview

- **Lint**: `eslint` with `eslint-config-next` (`packages/admin/eslint.config.mjs`); ignores `.open-next/**`, `.wrangler/**`, `cloudflare-env.d.ts`, `scripts/**`.
- **Type-check**: `npm run typecheck -w @octafuse/admin` (`tsc --noEmit`), `strict` on via `tsconfig.base.json`.
- **Tests**: `node --test` via `tsx` — `npm run test:unit -w @octafuse/admin`.
- **Format**: tabs, LF, final newline (`.editorconfig`).

---

## Forbidden Patterns

- **Raw SQL / driver-specific clients in the BFF.** Go through `@octafuse/core` repositories. See [database guidelines](./database-guidelines.md).
- **Leaking secrets** in responses or logs (`MASTER_KEY`, `ADMIN_PASSWORD`, upstream keys).
- **Returning non-enveloped responses.** Every admin endpoint returns `{ success, data?, message? }`.
- **Bypassing auth.** New `/api/admin/*` surface must flow through the `[...path]` catch-all (cookie or `MASTER_KEY` bearer).
- **Hardcoded user-visible English in UI code** — pass through `next-intl` (backend service/error `message` strings are the documented exception).

---

## Required Patterns

- Register new Hono routes in `createAdminApp()` and keep the singleton (`getAdminApp()`).
- Resolve storage once per request via the `resolveAdminStorageContext` middleware; read `c.get('repositories')`.
- Route unexpected errors through `handleGatewayApiError` with a stable `route` label.
- Client-side response reads go through `readApiJson<T>` so 401 session-expiry is handled centrally.

---

## Testing Requirements

- Unit-test pure helpers/services (`lib/services/admin/*.test.ts`, `lib/**/*.test.ts`) with `node --test`.
- UI-coupled or D1-coupled flows are exercised via `npm run preview` (D1) or `npm run dev:node` (Postgres) — see [`packages/admin/AGENTS.md`](../../../../packages/admin/AGENTS.md).

---

## Code Review Checklist

- [ ] No raw SQL; persistence goes through `@octafuse/core`.
- [ ] Response is the `{ success, … }` envelope.
- [ ] Errors: expected → `{ success:false, message }` + 4xx; unexpected → `handleGatewayApiError`.
- [ ] No secret values logged or returned.
- [ ] New route mounted in `admin-app.ts` and reachable via `/api/admin/*` with auth.
- [ ] Lint + typecheck + unit tests pass.
