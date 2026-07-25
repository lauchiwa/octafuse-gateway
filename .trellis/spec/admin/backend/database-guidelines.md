# Database Guidelines — Admin Backend

> How the Admin BFF reaches the database. Short version: **it doesn't, directly.**

---

## Overview

The Admin app has **no SQL and no ORM of its own**. All persistence is delegated to `@octafuse/core` repositories, resolved through a storage context:

```ts
// lib/admin-app.ts
app.use('*', async (c, next) => {
	const { repositories } = await resolveAdminStorageContext(c.env);
	c.set('repositories', repositories);
	await next();
});
```

`resolveAdminStorageContext` picks the driver the same way the Proxy Node runtime does:

- **Cloudflare Workers**: D1 binding `DB` → `createD1StorageContext`.
- **Node / self-hosted**: `DATABASE_URL` + `DATABASE_DRIVER` (`postgres` default, or `mysql`) → `createPostgres/MySqlStorageContext`.

See [core database guidelines](../../core/backend/database-guidelines.md) for the repository/driver model.

---

## Query Patterns

- Call `c.get('repositories')` in a Hono handler, then a repository method — never build SQL here.
- If a query does not exist yet, add it to the appropriate `@octafuse/core` repository interface and implement it for **all three drivers** (d1/postgres/mysql). Do not special-case a driver in admin.
- Cross-cutting read logic (sorting, filtering, currency, timezone) is shared via `@octafuse/core` subpath exports (e.g. `@octafuse/core/db/users-list-sort`, `@octafuse/core/lib/business-timezone`). Reuse these instead of re-deriving in the BFF.

---

## Migrations

Migrations live in `@octafuse/core`, not here. Schema changes for self-hosted deployments run via the `Dockerfile.migrate` image (`docker compose --profile migrate run --rm migrate`). See [core database guidelines](../../core/backend/database-guidelines.md#migrations).

---

## Naming Conventions

Not applicable — Admin does not define tables or columns. Follow core's conventions when adding repository methods there.

---

## Common Mistakes

- **Writing raw SQL in a route/service.** All persistence goes through `@octafuse/core`.
- **Assuming D1.** Admin runs on both Workers (D1) and Node (Postgres/MySQL). Only use `repositories`; never reach for a driver-specific client.
- **Forgetting `cf-typegen`.** After a fresh clone, run `npm run cf-typegen` so `cloudflare-env.d.ts` (gitignored) exists for the `DB` binding types.
