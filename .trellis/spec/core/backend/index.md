# `@octafuse/core` — Backend Guidelines

> Shared library consumed by `@octafuse/proxy` and `@octafuse/admin`. Storage,
> repositories, migrations, domain services, pricing/billing, lib utils.
> Read [`../../architecture.md`](../../architecture.md) first.

---

## Pre-Development Checklist

- [ ] Am I adding cross-driver behavior? Then it must land in **all three** repository impls (`db/d1`, `db/postgres`, `db/mysql`) and behind the repository interface.
- [ ] Am I adding a schema change? Then write **three** parallel migrations (`migrations-d1`, `migrations-postgres`, `migrations-mysql`) with the same number.
- [ ] Does new public surface need a `package.json` `exports` subpath? Consumers can only import declared subpaths.
- [ ] Am I touching money? Use `lib/money-precision.ts` helpers — never raw float arithmetic.
- [ ] Is there an existing lib util / service before I write a new one?

---

## Guidelines Index

| Guide | Description |
|-------|-------------|
| [Directory Structure](./directory-structure.md) | Storage/repository layout, exports map, migrations |
| [Database Guidelines](./database-guidelines.md) | Repository pattern, three-driver parity, drizzle, migrations |
| [Error Handling](./error-handling.md) | Fail-fast config resolution, error propagation |
| [Quality Guidelines](./quality-guidelines.md) | Money precision, ESM, testing, forbidden patterns |
| [Logging Guidelines](./logging-guidelines.md) | `console.*` structured logging, secret redaction |

---

## Quality Check (run before finishing a `core` task)

```bash
npm run build -w @octafuse/core      # prebuild clears dist, then tsc + esbuild bundle
npm run test:unit -w @octafuse/core  # tsx --test on the curated test list
```

- Cross-driver changes: verify the D1, Postgres, and MySQL impls stay in sync.
- Schema changes: verify all three `migrations-*` dirs got the same-numbered file and that seed data (`0002_seed.sql`) is consistent.

---

**Language**: documentation in English; inline code comments may be 中文, matching the file.
