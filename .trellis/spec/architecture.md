# Octafuse Gateway — Architecture Overview

> Monorepo-wide reference. Read this before touching any package. Layer- and
> package-scoped rules live under `.trellis/spec/<package>/<layer>/`.

---

## What this project is

Octafuse Gateway is a self-hostable LLM API gateway: it accepts OpenAI /
Anthropic / Gemini-shaped requests, authenticates them against per-user API
keys with budgets, routes each request to a configured upstream provider with
failover, and records usage / billing. It ships an admin console for managing
keys, providers, models, routes, config, request logs, and analytics.

---

## Monorepo layout

npm **workspaces** (`package.json` `workspaces: [".", "packages/core", "packages/proxy", "packages/admin"]`).

| Package | Name | Role |
|---------|------|------|
| `packages/core` | `@octafuse/core` | Shared library: storage/repositories (D1/Postgres/MySQL), migrations, domain services, pricing/billing, lib utils. Consumed by `proxy` and `admin`. |
| `packages/proxy` | `@octafuse/proxy` | The gateway data plane: Hono app exposing `/v1/*` (chat, messages, gemini, images, models, me), `/catalog`, `/health`, `/v1/tools/*`. Runs on **Cloudflare Workers** and **Node**. |
| `packages/admin` | `@octafuse/admin` | Admin console: Next.js 16 + OpenNext on Cloudflare (or Node standalone in Docker). BFF at `/api/admin/*` wrapping an internal Hono app at `/admin/*`. |

`proxy` and `admin` depend on `core` via workspace protocol (`"@octafuse/core": "*"`).
`core` imports use its `exports` subpath map (e.g. `@octafuse/core/db/model-modalities`, `@octafuse/core/lib/money-precision`) — do not deep-import past the declared subpaths.

---

## Runtime × database matrix

The gateway runs on two runtimes against three databases. `core` abstracts this
behind a **repository pattern** so route/service code never branches on driver.

| Runtime | Database | Storage entry |
|---------|----------|---------------|
| Cloudflare Workers | D1 (SQLite) | `createD1StorageContext(env.DB)` |
| Node (self-hosted) | Postgres | `createPostgresStorageContext(connectionString)` |
| Node (self-hosted) | MySQL | `createMySqlStorageContext(connectionString)` |

- `DatabaseDriver = 'd1' | 'postgres' | 'mysql'` (`packages/core/src/storage/database-client.ts`).
- Postgres/MySQL repositories are lazily `import()`-ed inside their storage-context factory so the Workers bundle stays D1-only.
- Node runtime resolves its driver from env via `resolveNodeDatabaseConfig(process.env)` (`DATABASE_URL` + optional `DATABASE_DRIVER`; omitted → `postgres`; mismatch → error).

---

## Tech stack & pinned versions

| Concern | Choice | Version (as of 1.10.2) |
|---------|--------|------------------------|
| Language | TypeScript, **ESM** (`"type": "module"`) | `^5.7.2` |
| TS target / module | `ES2022` / `ESNext`, `moduleResolution: bundler`, `strict: true` | `tsconfig.base.json` |
| HTTP framework | Hono | `^4.12.9` |
| Node HTTP server | `@hono/node-server` | `^1.19.13` |
| ORM | drizzle-orm | `^0.45.2` |
| Postgres driver | `postgres` | `^3.4.9` |
| MySQL driver | `mysql2` | `^3.22.0` |
| Admin UI | Next.js 16 (App Router) + React 19 | `next ^16.1.6`, `react ^19.2.4` |
| Admin on CF | `@opennextjs/cloudflare` | `1.19.4` (pinned exact) |
| i18n | next-intl (without-i18n-routing) | `^4.13.1` |
| Styling | Tailwind CSS | `^3.4.1` |
| Bundler | esbuild (proxy/core node bundles) | `^0.27.3` |
| CF tooling | wrangler | `^4.107.0` |
| Test runner | `tsx --test` (node built-in `node:test`) | tsx `^4.21.0` |
| Versioning | Changesets | `@changesets/cli ^2.29.8` |
| Node engine | `.nvmrc` → **22** | Docker base `node:22-alpine3.22` |

When adding a dependency, pin to the range style already in the manifests (caret
`^` for most, exact for `@opennextjs/cloudflare`). Do not introduce a second
tool that overlaps an existing one (e.g. another ORM, another test runner).

---

## Code style

Enforced by `.editorconfig` (repo root):

- **Indentation: tabs** for all code (`.ts`, `.tsx`, `.mjs`, `.json`, Dockerfiles, shell). Do not convert to spaces.
- YAML: 2-space indent. Markdown: space indent.
- `charset = utf-8`, `end_of_line = lf`, `insert_final_newline = true`, `trim_trailing_whitespace = true`.
- File-level **JSDoc block comment** describing the module's purpose is the norm; inline comments are frequently written in **中文** (Chinese) alongside English identifiers. Match the surrounding file's comment language.
- `admin` (Next.js) uses ESLint (`eslint-config-next`); `core`/`proxy` rely on `tsc --noEmit` typecheck, not ESLint.

---

## HTTP conventions

- **Response shape**: admin and gateway-admin JSON APIs return `{ success, data?, message?, ... }`. The `/v1/*` proxy routes follow the upstream provider's native shape (OpenAI/Anthropic/Gemini), not this envelope.
- **CORS**: both the proxy Hono app and the admin Hono app use `cors({ origin: '*', allowMethods: [...], allowHeaders: ['Content-Type', 'Authorization'] })`.
- **Logging middleware**: both apps mount `hono/logger` on `*`.
- **Storage injection**: a `*` middleware resolves the `StorageContext` and sets `c.set('repositories', ...)` before route handlers run.

---

## Auth model

- **Gateway (`/v1/*`)**: per-user API key (`sk-…`). Extracted by `packages/proxy/src/middleware/auth.ts` from `Authorization: Bearer`, Anthropic `x-api-key` (`/v1/messages`), or Gemini `?key=` / `x-goog-api-key` (`/v1beta`). Budget enforced in the middleware for most routes; chat/images defer the budget check until the model is resolved.
- **Admin (`/api/admin/*`)**: cookie session (`admin_session`) or `Authorization: Bearer <MASTER_KEY>` (must match D1/DB `system_config.MASTER_KEY`). Console login uses `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
- `MASTER_KEY` dev seed is `sk-dev-admin-key` (migrations `0002_seed.sql`) — **must be rotated in production**. Never commit real secrets; see `docs/CONVENTIONS.md §2`.

---

## Nginx / reverse-proxy convention

There is **no committed Nginx config** in the repo; TLS termination is the
operator's responsibility. The documented, canonical pattern
(`docs/operators/deployment/docker.md §7`) is:

- Production **strongly** recommends placing Admin (and any public Proxy) behind a TLS reverse proxy (Nginx / Caddy / Traefik). Do not expose the admin port in plaintext on an untrusted network.
- The `admin_session` cookie gets `Secure` **inferred from the request protocol** (HTTPS yes, plain HTTP no), so quickstart works out of the box while HTTPS deployments are hardened automatically. `ADMIN_COOKIE_SECURE=1`/`0` forces it either way.
- Reference Nginx template (substitute upstream host + cert paths):

```nginx
server {
  listen 443 ssl;
  server_name gateway-admin.example.com;

  ssl_certificate     /etc/nginx/certs/fullchain.pem;
  ssl_certificate_key /etc/nginx/certs/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8789;   # admin;  proxy is 8787
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

- Default local ports: **Proxy `8787`**, **Admin `8789`**. Docker healthchecks hit `/health` (proxy) and `/` (admin).
- Docs/examples must use placeholders (`gateway-admin.example.com`, cert paths) — never real hosts, keys, or webhook URLs. See `docs/CONVENTIONS.md §2.1`.

---

## Deployment surfaces

- **Cloudflare**: `wrangler.jsonc` per Worker is **generated** by `npm run gen:wrangler` (`scripts/deploy/gen-wrangler.mjs`) from `wrangler.base.jsonc` — never hand-edit the generated `wrangler.jsonc`. Admin uses OpenNext (`opennextjs-cloudflare`).
- **Docker (self-hosted)**: `Dockerfile.proxy` (core+proxy, Node+Postgres/MySQL, port 8787), `Dockerfile.admin` (Next standalone, port 8789), `Dockerfile.migrate` (schema migration one-shot). Compose examples under `docker/compose/`.
- **Migrations**: three parallel dirs in `core` (`migrations-d1`, `migrations-postgres`, `migrations-mysql`) kept in lockstep by number. D1 via wrangler; Postgres/MySQL via the `octafuse-migrate` CLI (`packages/core/src/migrate/cli.ts`).

---

## Docs layering (from `docs/CONVENTIONS.md`)

- **L1** (must stay in-repo, evolves with code): API contracts, architecture, billing/audit semantics, migrations, `examples/`.
- **L2** (generic ops/deploy): Cloudflare/Docker/local-dev guides, compose + Nginx templates, release/changeset flow.
- **L3** (brand/customer/region-specific): not in this repo — lives in `octafuse-website`.
- **Secrets**: never commit real `MASTER_KEY`, `ADMIN_PASSWORD`, provider keys, full webhook URLs, or real connection strings. Use the placeholder table in `docs/CONVENTIONS.md §2.1`.
