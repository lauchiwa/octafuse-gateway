# Frontend Development Guidelines — NOT APPLICABLE

> `@octafuse/proxy` is a **backend-only** Hono edge Worker. It ships no UI.

---

## Status: N/A

`@octafuse/proxy` (`packages/proxy`) is the request gateway: a Hono app that
runs on Cloudflare Workers (`src/index.ts`) or Node (`src/runtime/node.ts`).
It exposes `/v1/*` OpenAI/Anthropic/Gemini-compatible HTTP endpoints and has
**no React, no components, no browser code**.

There is nothing to document under this `frontend/` layer. The sibling files
(`component-guidelines.md`, `hook-guidelines.md`, etc.) remain as unused
scaffold and can be ignored.

For real guidelines, see:

- **Proxy backend**: [`../backend/index.md`](../backend/index.md)
- **Admin UI (the only frontend in this repo)**: [`../../admin/frontend/index.md`](../../admin/frontend/index.md)
- **Project architecture**: [`../../architecture.md`](../../architecture.md)
