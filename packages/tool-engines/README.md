# `@octafuse/tool-engines`

Shared **Tool engine clients** used by both:

- **Proxy** (`POST /v1/tools/*`) — with billing / request logs
- **Admin Playground Tools** — direct upstream probe, no billing / no logs

## Contract (source-only)

This package is **source-only**. It exports TypeScript entry points and has **no build / dist**.

| Consumer | How it works |
|----------|----------------|
| `@octafuse/proxy` Node bundle | `packages/proxy/scripts/build.mjs` inlines `@octafuse/*` into `dist/runtime/node.js` |
| `@octafuse/proxy` Wrangler | bundler resolves package exports → `.ts` |
| `@octafuse/admin` (Next / OpenNext) | `transpilePackages: ['@octafuse/tool-engines']` |

**Do not** `node`-require this package at runtime without a bundler. Subpath exports point at `.ts` files.

## Public exports

- `@octafuse/tool-engines/web-search`
- `@octafuse/tool-engines/web-fetch`
- `@octafuse/tool-engines/web-deep-search`
- `@octafuse/tool-engines/ai-detection`

Catalog schema / pricing live in `@octafuse/core` (`lib/*-system-config`, `lib/tool-pricing`). This package only talks to upstream engine APIs.
