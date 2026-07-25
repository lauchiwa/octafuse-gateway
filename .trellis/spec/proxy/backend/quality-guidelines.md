# Quality Guidelines — `@octafuse/proxy`

> Runtime-neutral code, thin routes, driver-agnostic persistence, non-blocking billing.

---

## Forbidden Patterns

- **Direct upstream `fetch` outside `services/egress/`.** All provider calls go through a driver.
- **Direct DB client usage** (`postgres`, `mysql2`, `drizzle`) in routes/services. Go through `@octafuse/core` repositories via `c.get('repositories')`.
- **`process.env` / `node:*` / Worker globals outside `runtime/` and `lib/proxy-env.ts`.** The same `src/` must run on both Cloudflare Workers and Node — use `readProxyEnv(bindings, key)` for config.
- **Awaiting billing before responding.** Use `scheduleBackgroundWork`.
- **Logging secrets** (see logging-guidelines).

---

## Required Patterns

- **Runtime neutrality**: business code imports nothing runtime-specific. Two entry points (`src/index.ts` for Workers/D1, `src/runtime/node.ts` for Node/PG/MySQL) both build the same app via `createProxyApp`.
- **Config access** exclusively through `readProxyEnv(bindings, key)` — it checks the Worker binding first, then `process.env`.
- **Env via TypeScript indent = tabs** (`.editorconfig`), `insert_final_newline`, LF endings.
- **Colocated tests**: add a `<name>.test.ts` for new billing/timing/parsing logic and wire it into the `test:unit` script in `package.json`.

---

## Testing Requirements

- Run `npm run test:unit -w @octafuse/proxy` (node test runner via `tsx --test`).
- Type-check with `npm run typecheck -w @octafuse/proxy` (`tsc --noEmit`).
- New pure functions (usage math, timing deltas, parsers, url-guard) must have unit tests — see existing `image-usage-charge.test.ts`, `request-timing.test.ts`, `egress/timing-delta.test.ts`.

---

## Code Review Checklist

- [ ] Does new upstream I/O live in an egress driver?
- [ ] Is persistence driver-agnostic (core repositories only)?
- [ ] Is config read via `readProxyEnv`, not `process.env` directly?
- [ ] Is billing scheduled as background work, not awaited?
- [ ] Are keys/secrets/prompt content kept out of logs?
- [ ] Does it run unchanged on both Workers and Node?
