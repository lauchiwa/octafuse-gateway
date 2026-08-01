# Directory Structure — `@octafuse/admin` Frontend

> How the Next.js App Router UI is organized.

---

## Overview

`@octafuse/admin` is a Next.js 16 App Router application. The frontend (UI) and backend (Hono BFF) live side by side in one package:

- **UI** — `app/**` (pages, layouts) and `components/**` (shared components). Talks to the server only via `fetch('/api/admin/...')`.
- **Backend BFF** — `app/api/**/route.ts` (route handlers), `lib/admin-app.ts` (Hono), `lib/routes/admin/*`, `lib/services/admin/*`. Documented in the [backend spec](../backend/index.md).
- **Shared client helpers** — `lib/*` (non-`routes`/`services`): formatting, i18n, currency, datetime, `api-json.ts`, etc. These are importable by both UI and, where framework-agnostic, tests.

---

## Directory Layout

```
packages/admin/
├── app/
│   ├── layout.tsx                 # Root layout (providers, locale, metadata)
│   ├── page.tsx                   # Redirect / entry
│   ├── globals.css                # Tailwind entry + globals
│   ├── dashboard/page.tsx
│   ├── api/                       # Backend BFF (route handlers) — see backend spec
│   │   ├── admin/[...path]/route.ts   # Auth + rewrite → Hono
│   │   ├── auth/{login,logout,check}/route.ts
│   │   └── locale/route.ts
│   └── gateway/                   # Feature pages (gateway operations)
│       ├── <domain>/              # e.g. models, providers, routes, keys, users
│       │   ├── page.tsx           # Page shell (mostly client component)
│       │   ├── components/*.tsx   # Domain-scoped presentational components
│       │   ├── <domain>-api.ts    # fetch('/api/admin/...') wrappers
│       │   ├── <domain>-utils.ts  # Pure helpers (grouping, parsing, formatting)
│       │   ├── use-<domain>-page-state.ts   # Page state hook (data + UI state)
│       │   └── types.ts           # Domain UI types
│       ├── analytics/{models,providers,reliability,users}/page.tsx
│       └── components/            # Cross-gateway shared components (filter-nav, ...)
├── components/                    # App-wide shared components
│   ├── layout/                    # Sidebar, AuthWrapper, LocaleSwitcher, ...
│   └── *.tsx                      # Charts, pickers, badges, editors
├── lib/                           # Shared client + BFF helpers
│   ├── api-json.ts                # readApiJson<T>, readJson<T>
│   ├── api-error.ts               # handleGatewayApiError (BFF 500 wrapper)
│   ├── auth.ts, admin-env.ts      # Auth + env resolution (BFF)
│   ├── i18n.ts, locale.ts         # next-intl config + locale cookie
│   ├── routes/admin/*             # Hono handlers (BFF) — see backend spec
│   ├── services/admin/*           # Admin services (use @octafuse/core) — BFF
│   └── *.ts                       # datetime, currency, formatting, brand, ...
├── messages/{en,zh,ja,ko}.json    # i18n copy (en.json is structural baseline)
├── eslint.config.mjs              # eslint-config-next + ignores
├── next.config.mjs                # standalone output, turbopack root
└── package.json
```

---

## Module Organization

**Per-domain feature module** (the dominant pattern under `app/gateway/<domain>/`):

| File | Responsibility |
|------|----------------|
| `page.tsx` | Page shell. Usually `'use client'`; wires the page-state hook to components. |
| `use-<domain>-page-state.ts` | The brain: owns data + UI state, effects, URL sync, calls into `<domain>-api.ts`. |
| `<domain>-api.ts` | Network layer: `fetch('/api/admin/...')` + `readApiJson`, throws `Error(data.message)` on failure. |
| `<domain>-utils.ts` | Pure functions (grouping, parsing, filter param parsing). Unit-tested where present. |
| `types.ts` | UI-facing types (`ModelListItem`, form data, filter enums, default consts). |
| `components/*.tsx` | Presentational + modal components for this domain. |

Reference implementations: `app/gateway/models/` and `app/gateway/routes/` are the most complete examples of this split.

**Shared components** go in `components/` (app-wide) or `app/gateway/components/` (gateway-wide). Domain-only components stay in `app/gateway/<domain>/components/`.

---

## Naming Conventions

- **Files**: kebab-case for modules and components (`model-card.tsx`, `use-models-page-state.ts`, `model-api.ts`). Some app-wide components use PascalCase (`Sidebar.tsx`, `AuthWrapper.tsx`, `GatewayTimeRangePicker.tsx`) — match the neighboring files in the target directory.
- **Hooks**: `use-<domain>-page-state.ts`, exporting `use<Domain>PageState()`.
- **API wrappers**: `<domain>-api.ts`, exporting verbs like `fetchModelsList`, `saveModel`, `deleteModel`.
- **Utils**: `<domain>-utils.ts` for pure helpers.
- **Indentation**: **tabs** (`.editorconfig`). `.md`/`.yml` use spaces.
- **Path alias**: `@/` maps to the `packages/admin` root (e.g. `@/lib/api-json`, `@/components/...`). Cross-package imports use `@octafuse/core/...` subpath exports.

---

## Examples

- `app/gateway/models/` — full page-state + api + utils + types + components split.
- `app/gateway/routes/` — the most component-rich domain (route editing, pricing panels).
- `lib/api-json.ts` — the canonical `fetch` → typed response helper every `*-api.ts` uses.
