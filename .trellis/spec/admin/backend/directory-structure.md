# Directory Structure — Admin Backend (BFF)

> How the Admin BFF (Next route handlers + Hono + services) is organized.

---

## Overview

The Admin app splits into a **Next.js App Router** frontend (`app/**` pages, see [admin frontend](../frontend/directory-structure.md)) and a **BFF backend**. This file covers the backend half:

- `app/api/**` — Next.js route handlers (the only public HTTP surface).
- `lib/admin-app.ts` — the Hono sub-app; internal routes are `/admin/*`.
- `lib/routes/admin/*` — Hono handlers, one file per resource.
- `lib/services/admin/*` — service functions that call `@octafuse/core`.
- `lib/*` — shared helpers (auth, storage-context, api-json, formatting).

---

## Directory Layout

```
packages/admin/
├── app/
│   └── api/
│       ├── admin/[...path]/route.ts   # auth (cookie or Bearer MASTER_KEY) → rewrite → Hono
│       ├── auth/{login,logout,check}/route.ts
│       └── locale/route.ts            # POST sets NEXT_LOCALE cookie
├── lib/
│   ├── admin-app.ts                   # Hono: mounts /admin/keys, /admin/providers, …
│   ├── admin-env.ts                   # AdminEnv (Hono Bindings/Variables typing)
│   ├── auth.ts                        # session cookie + MASTER_KEY verification
│   ├── storage-context.ts             # resolveAdminStorageContext(env) → repositories
│   ├── api-error.ts                   # handleGatewayApiError
│   ├── api-json.ts                    # readApiJson / readJson (client-side response typing)
│   ├── routes/admin/*.ts              # Hono handlers per resource
│   └── services/admin/*.ts            # services calling @octafuse/core
├── messages/{en,zh,ja,ko}.json        # i18n copy
└── eslint.config.mjs
```

---

## Module Organization

- **One resource → one route file** in `lib/routes/admin/` (`keys.ts`, `providers.ts`, `models.ts`, `model-routes.ts`, `config.ts`, `request-logs.ts`, `analytics.ts`, `stats.ts`, `budget-audit-logs.ts`, `business-timezone.ts`, `playground.ts`).
- Register every route in `createAdminApp()` (`lib/admin-app.ts`) with `app.route('/admin/<resource>', …)`.
- Business/data logic that touches persistence goes in `lib/services/admin/*`, which calls `@octafuse/core` — **not** inline in route handlers.
- The Hono app is **cached** as a singleton (`getAdminApp()`); do not recreate per request.

---

## Naming Conventions

- Tabs for indentation (`.editorconfig`); LF line endings; final newline.
- Files kebab-case (`business-timezone.ts`, `model-routes.ts`).
- Path alias `@/` → `packages/admin` root (e.g. `@/lib/admin-env`).
- Hono handlers export a named `Hono` instance (`export const adminKeysRoutes = new Hono<AdminEnv>()…`).
- Internal Hono routes are `/admin/*`; the browser-facing surface is always `/api/admin/*`. The `@octafuse/proxy` Worker does **not** expose admin routes.

---

## Examples

- Route wiring: `packages/admin/lib/admin-app.ts`
- Auth + URL rewrite to Hono: `packages/admin/app/api/admin/[...path]/route.ts`
- Storage resolution: `packages/admin/lib/storage-context.ts`
- Client response typing: `packages/admin/lib/api-json.ts`
