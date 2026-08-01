# `@octafuse/core` — Directory Structure

> How the shared library is laid out. Source of truth: `packages/core/`.

---

## Layout

```
packages/core/
├── src/
│   ├── index.ts                 # main entry — re-exports the public surface
│   ├── db/                      # per-table repository implementations
│   │   ├── d1/*.impl.ts         # Cloudflare D1 (SQLite) implementation
│   │   ├── postgres/*.impl.ts   # Postgres implementation
│   │   ├── mysql/*.impl.ts      # MySQL implementation
│   │   ├── shared/              # driver-agnostic SQL helpers (e.g. sql-placeholders)
│   │   ├── *-types.ts           # row / DTO / param types per table
│   │   └── *.ts                 # driver-agnostic domain logic + *.test.ts
│   ├── storage/
│   │   ├── context.ts           # createD1/Postgres/MySqlStorageContext
│   │   ├── database-client.ts   # GatewayDatabaseClient union (driver + raw + drizzle)
│   │   ├── repositories-{d1,postgres,mysql}.ts   # wire impls into a repo bundle
│   │   ├── gateway-repository-interfaces.ts       # repository contracts
│   │   └── drizzle/client-{d1,postgres,mysql}.ts  # drizzle client init
│   ├── services/                # domain services (key-service, user-service, budget-transition-service)
│   ├── lib/                     # pure utils (money-precision, business-timezone, *-system-config, string-utils)
│   └── migrate/                 # Node migration CLI (cli.ts, postgres.ts, mysql.ts)
├── migrations-d1/               # numbered SQL, SQLite dialect
├── migrations-postgres/         # numbered SQL, Postgres dialect
└── migrations-mysql/            # numbered SQL, MySQL dialect
```

---

## Module Organization

- **One table = one `*.impl.ts` per driver** + a shared `*-types.ts`. Example: `api-keys.impl.ts` in each of `d1/`, `postgres/`, `mysql/`, with types in `db/api-keys-types.ts`.
- **Driver-agnostic domain logic** (pricing math, modality parsing, sticky config) lives directly under `db/` or `lib/` as plain `.ts` with a co-located `*.test.ts`.
- **Public surface is explicit.** `src/index.ts` re-exports the main API; additional deep imports must be declared as subpaths in `package.json` `exports` (e.g. `@octafuse/core/db/model-modalities`, `@octafuse/core/lib/money-precision`). Consumers cannot import undeclared paths.

---

## Naming Conventions

- Files: `kebab-case.ts`. Driver impls end in `.impl.ts`. Tests end in `.test.ts` next to their subject.
- Types files end in `-types.ts`. System-config helpers end in `-system-config.ts`.
- Indentation: **tabs** (`.editorconfig`), LF line endings, final newline.

---

## Examples

- Repository parity: `src/db/{d1,postgres,mysql}/api-keys.impl.ts`
- Driver-agnostic + tested logic: `src/db/pricing-profile.ts` + `pricing-profile.test.ts`
- Storage wiring: `src/storage/context.ts`, `src/storage/database-client.ts`
