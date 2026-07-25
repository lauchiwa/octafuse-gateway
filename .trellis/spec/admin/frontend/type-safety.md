# Type Safety — `@octafuse/admin` Frontend

> Type patterns for the Admin UI.

---

## Overview

- **TypeScript 5.7**, `strict: true` (inherited from `tsconfig.base.json`).
- **No runtime validation library** (no Zod/Yup). API responses are type-asserted through `readApiJson<T>` / `readJson<T>`. Trust boundary: `/api/admin/*` is the app's own BFF, so responses are treated as trusted-shaped.
- Type-check with `npm run typecheck` (`tsc --noEmit`). Lint with `npm run lint` (`eslint-config-next`).

---

## Type Organization

- **Domain UI types** live in `app/gateway/<domain>/types.ts` (e.g. `ModelListItem`, `ModelFormData`, filter enums, default form consts).
- **Shared response envelope**: `ApiResponse<T>` = `{ success, data?, message? }` (`lib/types`). Every `<domain>-api.ts` call resolves to `ApiResponse<T>` via `readApiJson<T>`.
- **Cross-package types**: import from `@octafuse/core` subpath exports (e.g. `@octafuse/core/db/model-modalities`) rather than redefining. The UI shares core's domain model helpers (`isImageGenerationModel`, `parseModelModalitiesJson`).
- Prefer `type` aliases for props and DTOs; `interface` is used mainly for extensible/OO shapes in core.

---

## Validation

- Response shape is asserted, not validated: `return (await response.json()) as ApiResponse<T>`. Because the producer is our own Hono BFF, we rely on shared types across the boundary instead of parsing.
- Form input is validated inline with typed helpers that return a discriminated result, e.g. `parseMetadataForSave` and pricing serializers return `{ ok: true; json } | { ok: false; error }`. Follow this `{ ok, ... }` result pattern for new client-side validators rather than throwing.

```ts
const metaParsed = parseMetadataForSave(formData.metadata);
if (!metaParsed.ok) {
	return { success: false, message: metaParsed.error };
}
```

---

## Common Patterns

- Discriminated unions for action results: `{ success: true } | { success: false; message: string }`.
- `encodeURIComponent` for any user/id value interpolated into a URL.
- Reuse core helpers for domain logic (modalities, pricing, currency) instead of duplicating type-narrowing in the UI.

---

## Forbidden Patterns

- `any` — use `unknown` + narrowing, or the proper domain type. `strict` is on; do not disable it.
- Ad-hoc `as` casts on raw payload fields scattered across components — centralize the assertion in `<domain>-api.ts` via `readApiJson<T>`.
- Redefining a type that already exists in `@octafuse/core` — import the subpath export.
- Suppressing type errors with `// @ts-ignore` (prefer `@ts-expect-error` with a reason only when unavoidable).
