# Design — hash gateway sk- keys at rest

Decision (owner, 2026-07-26): **Option B — invalidate existing keys**. One migration, no backfill script. Existing `sk-` keys stop working and are re-issued. This merges with the mandatory post-bypass key rotation, so it is one disruption instead of two.

## Storage change

`api_keys.key` (plaintext, `NOT NULL UNIQUE`) becomes:

| column | type | meaning |
|---|---|---|
| `key_hash` | TEXT NOT NULL UNIQUE | SHA-256 hex (64 chars) of the full `sk-…` key |
| `key_prefix` | TEXT (nullable) | first 11 chars (`sk-` + 8) for admin display |

**Rename, not table-rebuild.** `api_key_request_logs.api_key_id` and the user-audit table hold FKs to `api_keys(id)`. The SQLite "create new table / copy / drop / rename" pattern would break that history, so the migration renames the column in place — the existing UNIQUE constraint follows the rename, and inbound FKs reference `id`, which is untouched.

Existing rows are preserved (user links, budgets, log history stay intact) but neutralised:
- `key_prefix` = `substr(<old plaintext>, 1, 11)` — captured **before** the value is overwritten, so the admin UI can still identify historical keys.
- `key_hash` = `'migrated:' || id` — unique per row and can never collide with a real 64-char hex hash.
- `status` = `'revoked'` — belt and braces; the auth path already filters `status='active'`.

### Dialect notes
- **d1/sqlite**: `ALTER TABLE … RENAME COLUMN` (SQLite ≥3.25); `||` concat; `substr()`.
- **postgres**: same syntax.
- **mysql**: `RENAME COLUMN` needs 8.0, so use `CHANGE \`key\` key_hash VARCHAR(767) NOT NULL`; `||` is logical OR in MySQL, so use `CONCAT('migrated:', id)`.

## Hashing

New `packages/core/src/services/api-key-hash.ts`:
- `hashApiKey(plaintext): Promise<string>` — SHA-256 → lowercase hex, via `crypto.subtle.digest` (available in Workers and Node ≥20).
- `apiKeyPrefix(plaintext): string` — `plaintext.slice(0, 11)`.
- `maskApiKeyFromPrefix(prefix): string` — `sk-Ab3dEf9x…` for admin display.

Plain SHA-256 is the right primitive here: keys are 32 bytes from a 62-char alphabet (~190 bits of entropy), so brute force is infeasible and a slow KDF would only tax the proxy's hot auth path. This is deliberately *not* password hashing.

## Contract change (fail-loud by rename)

`ApiKeysRepository` methods that took plaintext are renamed so a stale caller cannot silently pass an unhashed key:

- `getApiKeyByKey` → `getApiKeyByKeyHash`
- `getApiKeyByKeyAnyStatus` → `getApiKeyByKeyHashAnyStatus`
- `getApiKeyWithUserByKey` → `getApiKeyWithUserByKeyHash`

Hashing happens at the **call site** (service layer), never inside the DB impls, so each driver stays a thin SQL layer. Only three call sites exist:

1. `packages/proxy/src/services/api-key-auth.ts:29` — hot auth path
2. `packages/admin/lib/services/admin/keys-service.ts:36` — `resolveKeyRow` (`sk-` lookup)
3. `packages/admin/lib/services/admin/keys-service.ts:44` — same, any-status variant

`ApiKeyRow.key: string` becomes `key_hash: string` + `key_prefix: string | null`.

## Admin API exposure

- `createAdminKey` (`keys-service.ts:142`) returns the plaintext **once** at creation — unchanged, this is the intended reveal.
- `getAdminKeyById` (`keys-service.ts:348`) currently returns `key: info.key` (full plaintext) → return the masked form.
- The admin list (`getAllApiKeys` impls, e.g. `d1/api-keys.impl.ts:235`) returns `key: r.key` → return masked.

After this change no endpoint can return a usable key after creation, because the plaintext no longer exists anywhere.

`deleteApiKeyHard(id, secretKey)` already ignores `secretKey` in the d1 impl; pass the hash and keep the signature (verify the pg/mysql impls do not use it either).

## Rollout

Order matters — the migration invalidates keys, so deploy code and schema together:

1. `npm run db:migrate:remote` (applies 0015)
2. `npm run deploy:cloudflare -- production --admin-only` (and `--proxy-only` — the proxy auth path changed)
3. Owner re-issues keys from the admin UI and redistributes them.

Rollback: the plaintext is destroyed by the migration, so rollback restores code but **not** key usability. Keys must be re-issued either way. Take a D1 export before migrating if the historical plaintext matters for anything.
