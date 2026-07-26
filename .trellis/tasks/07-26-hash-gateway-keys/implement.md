# Implement — hash gateway sk- keys at rest

## Ordered checklist

1. [ ] `packages/core/src/services/api-key-hash.ts` — `hashApiKey`, `apiKeyPrefix`, `maskApiKeyFromPrefix` (+ export from core index if the package exposes a barrel).
2. [ ] `packages/core/src/types.ts` — `ApiKeyRow.key` → `key_hash`; add `key_prefix: string | null`. Update the doc comment (no longer "明文存库").
3. [ ] Drizzle schemas — `schema.d1.ts:41`, `schema.pg.ts:45`, `schema.mysql.ts:74`: `key` → `keyHash` + add `keyPrefix`.
4. [ ] `packages/core/src/storage/gateway-repository-interfaces.ts:78-81` — rename the three lookup methods to `…ByKeyHash`.
5. [ ] Three impls (`db/d1`, `db/postgres`, `db/mysql/api-keys.impl.ts`) — `WHERE key = ?` → `WHERE key_hash = ?`; insert writes `key_hash` + `key_prefix`; row mappers return the new fields; `getAllApiKeys` returns masked instead of plaintext.
6. [ ] `packages/core/src/db/api-keys-types.ts` — `InsertKeyParams.key` → `keyHash` + `keyPrefix`; check `AdminApiKeyListItem.key` shape.
7. [ ] `packages/core/src/services/key-service.ts` — `createKey` hashes before insert, still returns the plaintext once.
8. [ ] `packages/proxy/src/services/api-key-auth.ts:29` — hash the incoming key, then `getApiKeyWithUserByKeyHash`.
9. [ ] `packages/admin/lib/services/admin/keys-service.ts` — `resolveKeyRow` (lines 36/44) hashes `sk-` input; `getAdminKeyById` (line 348) returns masked; `deleteApiKeyHard` call site (line 409) passes the hash.
10. [ ] Migrations `0015_hash_api_keys.sql` for `migrations-d1`, `migrations-postgres`, `migrations-mysql`.
11. [ ] Unit tests for the hash util + a regression test that a plaintext key no longer matches a stored hash lookup.

## Migration bodies

**d1 / postgres**
```sql
ALTER TABLE api_keys RENAME COLUMN key TO key_hash;
ALTER TABLE api_keys ADD COLUMN key_prefix TEXT;
UPDATE api_keys SET key_prefix = substr(key_hash, 1, 11);
UPDATE api_keys SET key_hash = 'migrated:' || id, status = 'revoked';
```

**mysql**
```sql
ALTER TABLE api_keys CHANGE `key` key_hash VARCHAR(767) NOT NULL;
ALTER TABLE api_keys ADD COLUMN key_prefix VARCHAR(64) DEFAULT NULL;
UPDATE api_keys SET key_prefix = SUBSTRING(key_hash, 1, 11);
UPDATE api_keys SET key_hash = CONCAT('migrated:', id), status = 'revoked';
```

Order is load-bearing: `key_prefix` is derived from the old plaintext, so it must be set before `key_hash` is overwritten.

## Validation

```bash
npm run test:unit -w @octafuse/core
npm run test:unit -w @octafuse/admin
npm run typecheck -w @octafuse/admin
npm run typecheck -w @octafuse/proxy
npx tsc -p packages/core/tsconfig.json --noEmit   # expect only the known dead-vitest errors (task 07-26-audit-maintenance M4)
npm run build:cf -w @octafuse/admin
```

Local D1 migration smoke:
```bash
npm run db:migrate            # applies 0015 against local state
```

## Review gate
- `grep -rn "\.key\b" packages/*/src packages/admin/lib` shows no remaining read of a plaintext `api_keys.key`.
- Creation path still returns the plaintext exactly once.
- Auth path hashes before lookup (no plaintext reaches SQL).

## Deploy (owner triggers)

Schema and code must ship together — the migration invalidates keys.

```bash
npm run db:migrate:remote
npm run deploy:cloudflare -- production            # both workers: proxy auth path changed
```

Then re-issue keys in the admin UI and redistribute.

## Rollback
Code can be reverted; the plaintext is destroyed by the migration and cannot be restored. Keys must be re-issued regardless. Export D1 before migrating if the old values matter.
