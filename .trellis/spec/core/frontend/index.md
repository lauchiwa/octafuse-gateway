# Frontend Development Guidelines — NOT APPLICABLE

> `@octafuse/core` is a **backend-only** shared library. It ships no UI.

---

## Status: N/A

`@octafuse/core` (`packages/core`) is a pure TypeScript library consumed by
`@octafuse/proxy` and `@octafuse/admin`. It contains storage/repository code,
billing/pricing logic, migrations, and shared utilities — **no React, no
components, no browser code**.

There is nothing to document under this `frontend/` layer. The sibling files
(`component-guidelines.md`, `hook-guidelines.md`, etc.) remain as unused
scaffold and can be ignored.

For real guidelines, see:

- **Core backend**: [`../backend/index.md`](../backend/index.md)
- **Admin UI (the only frontend in this repo)**: [`../../admin/frontend/index.md`](../../admin/frontend/index.md)
- **Project architecture**: [`../../architecture.md`](../../architecture.md)
