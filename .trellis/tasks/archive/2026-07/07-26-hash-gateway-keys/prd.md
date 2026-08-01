# Hash gateway sk- keys at rest

Source: `.trellis/tasks/archive/2026-07/07-26-project-audit/report.md` finding #2 (HIGH).

## Problem

Downstream gateway keys (`sk-…`) are stored and compared in **plaintext**:

- `packages/core/src/services/key-service.ts` — `generateKey()` makes `sk-` + 32 random bytes, stored as-is (no hashing).
- `packages/core/src/db/d1/api-keys.impl.ts` — proxy auth path does `SELECT * FROM api_keys WHERE key = ? AND status = 'active'` (plaintext equality); also `getApiKeyByKeyAnyStatus`, `getApiKeyWithUserByKey`.
- `packages/admin/lib/services/admin/keys-service.ts:142,348` — returns `key: result.key` / `key: info.key`, i.e. full plaintext in admin API responses.

Any DB read (backup, D1 console, leak) or any admin-API read yields usable production keys. This was directly exploitable during the auth-bypass window (fixed separately in `07-26-admin-auth-bypass`).

Note: the same `.impl.ts` pattern exists for postgres and mysql drivers — all must change together.

## Requirements

- R1: Store a hash of the key (e.g. SHA-256), not the plaintext. Proxy auth looks up by hash.
- R2: Admin API must return a masked form (e.g. `sk-abc…xyz`) for listing; never full plaintext after creation.
- R3: Reveal the full key exactly once, at creation time (`packages/admin/lib/new-api-key-secret-banner.tsx` already implies this UX).
- R4: Migration must handle existing rows across **d1 / postgres / mysql** drivers. Existing plaintext keys cannot be recovered from a hash, so decide and document the strategy: hash-in-place on migration (keys keep working) vs. force re-issue.
- R5: Lookup must stay a single indexed query — no full-table scan on the hot proxy auth path.

## Open questions (resolve during planning)

- Plain SHA-256 (fast, fine for 256-bit random keys) vs. a slow KDF? Recommendation: SHA-256 — these are high-entropy random keys, not user passwords, and the proxy path is latency-sensitive.
- Keep a `key_prefix` column for display/lookup UX?

## Acceptance Criteria

- [ ] `api_keys` no longer stores plaintext key material (schema + code verified)
- [ ] Proxy auth still resolves a valid key correctly; unit/smoke tests cover it
- [ ] Admin list/detail endpoints return masked values only; creation returns the plaintext once
- [ ] Migration applied for d1/postgres/mysql; documented whether existing keys survive or must be re-issued
- [ ] `npm run test:unit` passes across workspaces
