# Quality Guidelines — `@octafuse/core`

> Conventions distilled from the existing codebase. Match these when writing new `core` code.

---

## Formatting & Language

- **Indentation: tabs** (`.editorconfig`, `indent_style = tab`). YAML uses 2-space; Markdown uses spaces.
- `charset=utf-8`, `end_of_line=lf`, final newline required, no trailing whitespace.
- **TypeScript**: `strict: true`, `target ES2022`, `module ESNext`, `moduleResolution: bundler`, `noEmit` for typecheck (`tsconfig.base.json`). Package is ESM (`"type": "module"`).
- **Doc comments in Chinese are the norm** here — file-top `/** ... */` block summaries explain intent, often in 中文. Match the surrounding file's language rather than forcing English.

---

## Required Patterns

- **Repository pattern for all DB access** — three driver impls behind one interface (see [database-guidelines.md](./database-guidelines.md)).
- **Explicit `exports` map**: `core` is consumed via deep subpath exports declared in `package.json` (`@octafuse/core/db/...`, `@octafuse/core/lib/...`, `@octafuse/core/services/...`). New public modules must be added to `exports` — do not rely on reaching into `src/` paths that aren't exported.
- **`.impl.ts` suffix** for driver-specific implementations; `*-types.ts` for shared type modules.
- **Colocated tests**: `*.test.ts` next to source, run with the node test runner via `tsx --test` (see `package.json` `test:unit` — an explicit file list, not a glob).

---

## Forbidden Patterns

- **Node-only imports (`pg`, `mysql2`) on a Workers-reachable path.** Postgres/MySQL contexts lazy-import their factories; the D1/Workers path must stay free of them.
- **String-interpolated SQL with caller input.** Use placeholders / allow-lists.
- **Bypassing `roundGatewayMoney()`** for monetary math.
- **Editing one driver's migration/impl without the other two.**

---

## Testing Requirements

- Unit-test pure logic (pricing, modalities, timezone, budget transitions) — see the curated `test:unit` list in `packages/core/package.json`.
- Concurrency-sensitive DB paths have smoke tests under `scripts/smoke/` (`test-storage-concurrent-charge.ts`, `test-node-core-routes.ts`, `test-postgres-core-routes.ts`).
- Build check: `npm run build -w @octafuse/core` (tsc for migrate + esbuild bundle for the node index).

---

## Code Review Checklist

- [ ] New DB access implemented for **all three** drivers + wired into each factory?
- [ ] Migration added to all three `migrations-*` dirs with the same number?
- [ ] New public module added to `package.json` `exports`?
- [ ] No `pg`/`mysql2` leaking onto the Workers path?
- [ ] Money via `roundGatewayMoney`, secrets redacted, no prompt bodies logged?
- [ ] Tabs, LF, strict TS, colocated test added/updated?
