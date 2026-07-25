# Database Guidelines — `@octafuse/proxy`

> The proxy has no schema of its own. It reads and writes through `@octafuse/core` repositories.

---

## Overview

The proxy Worker/Node process never touches SQL directly. All persistence goes through the `GatewayRepositories` interface resolved by the storage middleware in `app.ts`:

```ts
app.use('*', async (c, next) => {
  const storage = await resolveStorage(c);
  c.set('repositories', storage.repositories);
  await next();
});
```

Inside a route or service, get repositories from context:

```ts
const repos = c.get('repositories');
```

The concrete driver (D1 / Postgres / MySQL) is decided by the runtime entry (`src/index.ts` for D1, `src/runtime/node.ts` for Postgres/MySQL via `resolveNodeDatabaseConfig`). Route/service code must remain driver-agnostic — see [database-guidelines](../../core/backend/database-guidelines.md) in core.

---

## Query Patterns

- **Never** import `postgres`, `mysql2`, or `drizzle` directly in a route/service. Add a repository method in `@octafuse/core` and call it.
- Read the resolved API key / user via `authenticateApiKey` (see `services/api-key-auth.ts`), not by querying tables ad hoc.
- Billing writes (`recordUsage`) run inside `scheduleBackgroundWork` after the response, using `critical-writes` repository methods in core for atomic budget charges.

---

## Migrations

Owned by core. See [`packages/core`](../../core/backend/database-guidelines.md). The proxy image (`Dockerfile.proxy`) ships `migrations-postgres` / `migrations-mysql` so the `Dockerfile.migrate` sidecar can apply them, but the proxy runtime itself does not run migrations.

---

## Common Mistakes

- **Blocking the response on a billing write.** Usage recording must be scheduled as background work, never awaited before returning the upstream stream.
- **Reaching for a raw client** because "it's just one query." If core has no method, add one — keep the driver matrix (D1/PG/MySQL) coherent.
- **Reading `process.env` for `DATABASE_URL` inside a service.** DB config resolution belongs to the runtime layer only.
