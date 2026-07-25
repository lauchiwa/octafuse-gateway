# Quality Guidelines — `@octafuse/admin` Frontend

> Code quality standards for the Admin UI.

---

## Overview

- **Lint**: `npm run lint` (`eslint .` with `eslint-config-next`; ignores `.open-next/**`, `.wrangler/**`, `cloudflare-env.d.ts`, `scripts/**`).
- **Type-check**: `npm run typecheck` (`tsc -p tsconfig.json --noEmit`).
- **Unit tests**: `npm run test:unit` (Node's built-in `tsx --test` over `lib/services/admin/*.test.ts`, `lib/*.test.ts`, `app/gateway/simulator/*.test.ts`).
- **Indentation**: tabs (`.editorconfig`).

Run lint + typecheck before considering UI work done (the check phase enforces this).

---

## Forbidden Patterns

- **Hardcoded user-visible English** in JSX or `lib/*` UI helpers — use `next-intl` (`t()` / labels object). See [Component Guidelines](./component-guidelines.md#internationalization).
- **Adding an i18n string to only one `messages/*.json`** — must update all of `en/zh/ja/ko` with identical key structure.
- **`fetch('/api/admin/...')` directly in components** — go through `<domain>-api.ts` + `readApiJson`.
- **`any`** and scattered `as` casts on payloads — see [Type Safety](./type-safety.md).
- **New global-state library** — extend the existing Context pattern instead.

---

## Required Patterns

- Per-domain split: `page.tsx` + `use-<domain>-page-state.ts` + `<domain>-api.ts` + `<domain>-utils.ts` + `types.ts` (+ `components/`).
- Pure, testable helpers in `<domain>-utils.ts`; add a `*.test.ts` when logic is non-trivial (see `simulator-utils.test.ts`).
- Server Components by default; `'use client'` only where interactivity is needed.
- Unwrap API responses via `readApiJson<T>`; throw `Error(data.message)` on failure.

---

## Testing Requirements

- Pure utilities and serializers should have `tsx --test` unit tests (see `lib/pricing-ui-image.test.ts`, `lib/image-generations.test.ts`, `app/gateway/simulator/simulator-utils.test.ts`).
- No component/E2E test framework is configured; focus tests on pure logic extracted into `*-utils.ts` / `lib/*.ts`.
- New non-trivial parsing/formatting/grouping logic → add it to a `*-utils.ts` and cover it.

---

## Code Review Checklist

- [ ] Lint (`npm run lint`) and typecheck (`npm run typecheck`) pass.
- [ ] All new user-visible strings exist in `en/zh/ja/ko` with matching keys.
- [ ] Network calls go through `<domain>-api.ts`, not inline `fetch`.
- [ ] Domain types imported from `@octafuse/core` where they already exist.
- [ ] Server/client boundary is correct (`'use client'` only where needed).
- [ ] Non-trivial pure logic lives in `*-utils.ts` and is tested.
