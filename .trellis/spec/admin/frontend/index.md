# `@octafuse/admin` — Frontend Guidelines (Next.js UI)

> The Admin console UI: Next.js 16 App Router + React 19 + Tailwind + next-intl. Rendered by OpenNext on Cloudflare Workers, or Next standalone in Docker.

This is the **only** frontend layer in the monorepo. `@octafuse/core` and `@octafuse/proxy` are backend-only (their `frontend/` specs are marked not-applicable).

---

## Pre-Development Checklist

Before writing or changing UI code under `packages/admin/app/**` or `packages/admin/components/**`:

1. **Read [architecture.md](../../architecture.md)** — understand the Next → `/api/admin/*` → Hono → `@octafuse/core` request path. UI never talks to the DB directly.
2. **Confirm the layer.** UI (`app/gateway/*`, `components/*`) calls `fetch('/api/admin/...')`. It must not import `@octafuse/core` repositories or DB clients. Data access lives in the backend layer (`lib/admin-app.ts` + `lib/routes/admin/*` + `lib/services/admin/*`).
3. **i18n first.** Any user-visible string must go through `next-intl`. Never hardcode English (or any language) in JSX. See [component-guidelines.md](./component-guidelines.md).
4. **Reuse page-state hooks.** List pages follow the `use-<domain>-page-state.ts` + `<domain>-api.ts` + `<domain>-utils.ts` + `types.ts` split. Match it. See [directory-structure.md](./directory-structure.md).

---

## Guidelines Index

| Guide | Description |
|-------|-------------|
| [Directory Structure](./directory-structure.md) | App Router layout, per-domain page module split |
| [Component Guidelines](./component-guidelines.md) | Server vs client components, i18n, Tailwind, response contract |
| [Hook Guidelines](./hook-guidelines.md) | `use-*-page-state` pattern, data fetching via `*-api.ts` |
| [State Management](./state-management.md) | Local state, URL-as-state, server state, no global store |
| [Type Safety](./type-safety.md) | Per-domain `types.ts`, `ApiResponse<T>`, `readApiJson` |
| [Quality Guidelines](./quality-guidelines.md) | ESLint (eslint-config-next), forbidden patterns, tests |

---

## Quality Check

Before considering UI work done:

- [ ] `npm run lint -w @octafuse/admin` passes (eslint-config-next).
- [ ] `npm run typecheck -w @octafuse/admin` passes (`tsc --noEmit`).
- [ ] All new copy added to **every** file under `packages/admin/messages/` (`en`, `zh`, `ja`, `ko`) with identical key structure; `en.json` is the structural baseline.
- [ ] No direct `@octafuse/core` repository / DB import in UI code.
- [ ] Client components that use hooks/state start with `'use client'`.
- [ ] Data-fetch helpers live in `<domain>-api.ts` and go through `readApiJson`.
- [ ] Unit tests updated where `*.test.ts` covers touched utils (`npm run test:unit -w @octafuse/admin`).

---

**Language**: All spec documentation is written in English. In-repo code comments follow the existing bilingual (中文/English) style of neighboring files.
