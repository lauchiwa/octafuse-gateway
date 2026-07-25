# State Management — `@octafuse/admin`

> How UI, server, and URL state are managed.

---

## Overview

No global store (no Redux/Zustand/Jotai). State is local-first, colocated in the per-page state hook. Cross-cutting concerns use React Context providers. Server state is fetched on demand and held in local state — there is no client cache library.

---

## State Categories

| Category | Mechanism |
|----------|-----------|
| **Local UI state** | `useState` / `useRef` inside `use-<domain>-page-state.ts` (selection, modal open, form drafts). |
| **Server state** | Fetched via `<domain>-api.ts`, stored in `useState`; refetched with a `reload()` callback after mutations. No SWR/React Query cache. |
| **URL state** | `useSearchParams` + `useRouter`/`usePathname` for filters and deep links. Shared helper `useReplaceListPageQuery` / `use-replace-list-query` keeps list-page query params in sync. |
| **App-wide context** | React Context providers for a few concerns: `BusinessTimezoneProvider`, billing currency (`useBillingCurrency`), locale (next-intl provider in `app/layout.tsx`), auth wrapper (`components/layout/AuthWrapper.tsx`). |

---

## When to Use Global State

Prefer local state in the page-state hook. Promote to a Context provider only when the value is:
- Needed across many unrelated pages (e.g. business timezone, billing currency, locale), **and**
- Relatively stable (set once / rarely changes per session).

Do not introduce a new global store library; extend the existing Context pattern.

---

## Server State

- After a mutation (`saveModel`, `deleteModel`, ...), call the page's `reload()` to refetch — the app relies on refetch, not optimistic cache updates.
- Response contract is always `{ success, data?, message? }`; unwrap via `readApiJson<T>` (see [Hook Guidelines](./hook-guidelines.md)).
- Session expiry (401 from `/api/admin`) is handled centrally by `readApiJson` → `notifyAdminSessionExpired()`; `AuthWrapper` reacts to it.

---

## Common Mistakes

- Duplicating server data into multiple `useState`s that drift — keep a single source list and derive views with `<domain>-utils.ts`.
- Storing filter state only in local state when it should be in the URL (breaks deep links / refresh). Use the URL-sync helpers.
- Reaching for a global store for something one page owns.
