# Directory Structure — `@octafuse/proxy`

> How the runtime gateway Worker is organized.

---

## Directory Layout

```
packages/proxy/
├── wrangler.base.jsonc          # Template; `npm run gen:wrangler` emits wrangler.jsonc (do NOT hand-edit the generated file)
├── src/
│   ├── index.ts                 # Cloudflare Worker entry (D1 binding `DB`)
│   ├── app.ts                   # createProxyApp(resolveStorage, options) — Hono wiring, CORS, logger, storage middleware
│   ├── app-version.ts           # Injected build version
│   ├── runtime/
│   │   ├── node.ts              # Node entry (@hono/node-server, Postgres/MySQL)
│   │   ├── workers.ts           # Worker-specific runtime helpers
│   │   └── schedule-background-work.ts   # Runtime-neutral "run after response" (waitUntil on Workers)
│   ├── middleware/
│   │   └── auth.ts              # requireApiKey — extracts sk per SDK convention, budget gate
│   ├── routes/
│   │   ├── health.ts
│   │   ├── catalog.ts
│   │   └── v1/
│   │       ├── chat.ts          # POST /v1/chat/completions (OpenAI)
│   │       ├── messages.ts      # /v1/messages (Anthropic)
│   │       ├── gemini.ts        # /v1beta/* (Gemini)
│   │       ├── images.ts        # /v1/images/*
│   │       ├── models.ts        # GET /v1/models
│   │       ├── me.ts            # GET /v1/me
│   │       └── tools/           # web-search / web-fetch / web-deep-search route handlers
│   ├── services/
│   │   ├── proxy.ts             # Core proxy/stream orchestration
│   │   ├── model-router.ts      # Active route rows → RouteResult
│   │   ├── route-selection.ts   # selectActiveRouteRows (schedule/priority filtering)
│   │   ├── resolve-model-route-group.ts
│   │   ├── failover-dispatch.ts # Sticky binding + failover across provider keys
│   │   ├── route-default-params.ts
│   │   ├── usage-tracker.ts     # recordUsage (billing)
│   │   ├── request-timing.ts    # RequestTimingCollector (TTFT, per-attempt timing)
│   │   ├── request-log-*.ts     # Request-log shaping / redaction / status
│   │   ├── provider-key-circuit-breaker.ts
│   │   ├── provider-key-rate-limiter.ts
│   │   ├── provider-key-scheduler.ts
│   │   ├── sticky-key-binding.ts
│   │   ├── sensitive-content-*.ts
│   │   ├── upstream-failure-classifier.ts
│   │   ├── egress/              # One driver per upstream protocol
│   │   │   ├── openai-driver.ts
│   │   │   ├── anthropic-driver.ts
│   │   │   ├── gemini-driver.ts
│   │   │   ├── openai-images-driver.ts
│   │   │   └── upstream-request-id.ts
│   │   ├── web-search/          # Provider-specific search backends (tavily, bocha, tencent-wsa, …) + dispatch.ts
│   │   ├── web-fetch/           # url-guard.ts + backends + dispatch.ts
│   │   └── web-deep-search/     # firecrawl / jina + dispatch.ts
│   └── lib/
│       ├── proxy-env.ts         # readProxyEnv(bindings, key) — the ONLY env accessor
│       └── model-list-parse.ts
```

---

## Module Organization

- **Routes** (`routes/`) are thin: authenticate → resolve routing → call a service → shape the log. Business logic lives in `services/`.
- **Services** hold orchestration and policy (routing, failover, billing, circuit breaking). One concern per file; a family of related files shares a prefix (`request-log-*`, `provider-key-*`, `sensitive-content-*`).
- **Egress drivers** (`services/egress/`) are the only place that issues `fetch` to an upstream provider. One driver per protocol. Each parses upstream `usage`, records timing via `RequestTimingCollector`, and normalizes the upstream request id.
- **Tool backends** (`web-search/`, `web-fetch/`, `web-deep-search/`) use a `dispatch.ts` + one file per provider + shared `types.ts` pattern.
- **Runtime adapters** (`runtime/`) are the ONLY place allowed to touch `process`, `node:*`, or Worker-specific globals.

---

## Naming Conventions

- Files: kebab-case (`failover-dispatch.ts`, `request-timing.ts`).
- Colocated unit tests: `<name>.test.ts` next to the source (run with `tsx --test`).
- Route modules export a Hono sub-app named `<domain>Routes` (e.g. `chatRoutes`, `webSearchRoutes`), mounted in `app.ts`.
- Prefix-grouped families over deep nesting for related-but-distinct concerns.

---

## Adding a new upstream protocol / route

1. Add the route handler under `routes/v1/` and mount it in `src/app.ts` (`app.route(...)`).
2. Add an egress driver under `services/egress/` — do not `fetch` upstream from the route.
3. Reuse `model-router` / `failover-dispatch` for routing and key selection.
4. Record usage via `usage-tracker` inside `scheduleBackgroundWork`; never block the response on billing.
5. If the auth header differs by SDK, extend `extractApiKey()` in `middleware/auth.ts`.
