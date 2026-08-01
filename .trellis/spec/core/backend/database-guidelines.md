# Database Guidelines — `@octafuse/core`

> Multi-driver persistence for D1 (Cloudflare), Postgres, and MySQL. `@octafuse/core` owns **all** database access; `proxy` and `admin` never touch SQL directly.

---

## Overview

- **ORM / query layer**: [Drizzle ORM](https://orm.drizzle.team) `^0.45.2` for schema typing + query building. Raw driver clients are also exposed for hand-written SQL where Drizzle is awkward.
- **Three drivers, one interface**: every table has three repository implementations — `src/db/d1/*.impl.ts`, `src/db/postgres/*.impl.ts`, `src/db/mysql/*.impl.ts` — all satisfying the same interface in `src/storage/gateway-repository-interfaces.ts`.
- **Driver union**: `DatabaseDriver = 'd1' | 'postgres' | 'mysql'` (`src/storage/database-client.ts`). Cloudflare Workers only ever bind `d1`; the Node runtime uses `postgres` or `mysql`.
- **Migrations are per-driver and lockstepped**: `migrations-d1/`, `migrations-postgres/`, `migrations-mysql/` each carry the *same numbered set* (`0001_baseline.sql` … `0013_*.sql`). A schema change adds one numbered file to **all three** directories.

---

## Repository Pattern (the core rule)

New DB access always flows through a repository:

1. Define/extend the interface in `src/storage/gateway-repository-interfaces.ts`.
2. Implement it in **all three** driver dirs: `db/d1/<domain>.impl.ts`, `db/postgres/<domain>.impl.ts`, `db/mysql/<domain>.impl.ts`.
3. Wire it into the driver's repository factory (`src/storage/repositories-{d1,postgres,mysql}.ts`).
4. Consumers receive `GatewayRepositories` via `StorageContext` — never a raw client.

```ts
// src/storage/context.ts — the only place a StorageContext is built
export function createD1StorageContext(db: D1Database): StorageContext {
  const client = createD1DatabaseClient(db);
  const repositories = createD1Repositories(client);
  return { client, repositories };
}
// postgres/mysql variants are async and lazy-import their factory to keep
// D1 (Workers) bundles free of the node-only pg/mysql2 code.
```

**Row-mapping convention**: each impl declares a private `*SqlRow` type mirroring the raw column shape, plus a `map*Row()` function that converts snake_case SQL rows into the domain type. See `src/db/d1/api-keys.impl.ts` (`KeySqlRow` → `mapKeyRow`).

---

## Query Patterns

- **Prefer parameterized queries** — never string-interpolate user input. D1 uses `?` placeholders and `.bind()`; postgres.js uses tagged templates; mysql2 uses `?`. Shared placeholder helpers live in `src/db/shared/sql-placeholders.ts`.
- **Money precision**: monetary values pass through `roundGatewayMoney()` (`src/lib/money-precision.ts`) — do not do ad-hoc float rounding.
- **Sort/filter allow-lists**: list endpoints validate sort fields against explicit allow-lists (`src/db/*-list-sort.ts`, `src/db/patch-allowlists.ts`) rather than trusting caller strings.
- **Critical writes** (budget charges, concurrent spend) are isolated in `*/critical-writes.impl.ts` and covered by concurrency smoke tests (`scripts/smoke/test-storage-concurrent-charge.ts`).

---

## Migrations

- Location: `packages/core/migrations-{d1,postgres,mysql}/NNNN_name.sql`.
- Numbering is shared across all three dirs; add the next `NNNN_` to each dir in the same PR.
- Seed data lives in `0002_seed.sql` (all three). The dev-only `MASTER_KEY` seed is `sk-dev-admin-key` — see [docs/CONVENTIONS.md §2.3]; production must rotate it.
- Run migrations:
  - D1 local: `npm run db:migrate` · D1 remote: `npm run db:migrate:remote`
  - Postgres: `npm run db:migrate:pg` (tsx) / `db:migrate:pg:docker` (built) · MySQL: `db:migrate:mysql` / `:mysql:docker`
  - Migration CLI entry: `src/migrate/cli.ts` (`octafuse-migrate` bin), driver-specific runners in `src/migrate/{postgres,mysql}.ts`.

### Applied-migration identity is the full filename

Runners record **the entire filename** (not the `NNNN` prefix), then skip any file whose name is already present.

Postgres / MySQL use our own runner and table:

```ts
// src/migrate/postgres.ts — same shape in mysql.ts
if (appliedVersions.has(fileName)) { skipped += 1; continue; }
// ...
INSERT INTO octafuse_gateway.schema_migrations (version) VALUES (${fileName})
```

D1 does **not** use that runner — `npm run db:migrate` delegates to `wrangler d1 migrations apply`,
which keeps its own `d1_migrations` table. The identity rule is the same there, which is what makes
the guidance below safe for all three drivers:

```sql
-- wrangler-managed, observed in .wrangler/state (local D1)
CREATE TABLE IF NOT EXISTS "d1_migrations"(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,            -- full filename, e.g. 0015_hash_api_keys.sql
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
```

Execution order is plain lexicographic sort of the filenames, so the `NNNN` prefix controls *order* while the whole name controls *identity*.

Two consequences that matter when resolving an upstream merge:

- **Renaming an already-applied migration makes it run again.** Its new filename is absent from the tracking table (`schema_migrations` / `d1_migrations`), so the runner treats it as new. Never renumber a migration that has shipped.
- **Renaming a never-applied migration is safe.** This is the supported way to resolve a numbering collision after an upstream merge: keep our shipped numbers fixed, and renumber the incoming upstream files upward.

Before renumbering, verify the two colliding migrations touch **disjoint tables**. If they do, there is no ordering dependency and either may run first. If they overlap, the relative order must be reasoned about explicitly rather than assumed from the numbers.

Renumbering is not just a `git mv`: grep the repo for the old filenames and update every operator-facing reference (`docs/operators/migrations/*`, `CHANGELOG.md`, `scripts/README.md`). Those documents contain commands people copy and paste, so a stale name there is a real defect, not a cosmetic one.

---

## Naming Conventions

- **Tables/columns**: `snake_case` (`api_keys`, `user_id`, `last_used_at`, `budget_reset_at`).
- **Domain types**: `PascalCase` with a `Row` suffix for DB shapes (`ApiKeyRow`, `ResolvedGatewayKeyRow`).
- **Impl files**: `<domain>.impl.ts` per driver dir. Non-impl shared helpers keep the bare domain name (`api-keys-types.ts`, `providers.ts`).

---

## Common Mistakes

- **Editing only one driver's migration or impl.** All three must stay in lockstep, or the Node/Workers runtimes diverge silently.
- **Importing `pg`/`mysql2` into a path reachable from the Workers bundle.** Postgres/MySQL contexts are `async` and lazy-import their factories on purpose; keep it that way.
- **Bypassing the repository layer** from `proxy`/`admin`. Consumers only ever see `GatewayRepositories`.
- **Ad-hoc float math on money** instead of `roundGatewayMoney()`.
