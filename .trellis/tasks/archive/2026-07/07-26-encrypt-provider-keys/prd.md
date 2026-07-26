# Encrypt provider upstream API keys at rest

Source: `.trellis/tasks/archive/2026-07/07-26-project-audit/report.md` finding #3 (HIGH).

## Problem

Upstream provider credentials (OpenAI / Anthropic / etc. API keys) are stored **plaintext**:

- `packages/core/src/db/d1/provider-api-keys.impl.ts` — `api_key` column written and read as plaintext; `getProviderKeyPlaintext(keyId)` returns it directly.
- No encryption primitives exist anywhere in `packages/core/src` today (only `crypto.randomUUID` / `getRandomValues`; no `encrypt`/`decrypt`/`cipher`).
- Admin listing already masks via `maskProviderApiKeyForAdmin` — **display is fine, storage is not**.

A DB leak exposes the owner's paid upstream credentials. This was directly exploitable during the auth-bypass window (fixed separately in `07-26-admin-auth-bypass`).

Note: parallel implementations exist for postgres and mysql (`db/postgres/`, `db/mysql/provider-api-keys.impl.ts`) — all must change together.

## Requirements

- R1: Encrypt `api_key` at rest (envelope encryption, e.g. AES-GCM with a key from a Worker secret / KV).
- R2: Decrypt only on the egress path where the upstream request is signed; never return plaintext from admin endpoints.
- R3: Keep the existing admin masking behaviour unchanged from the UI's perspective.
- R4: Migrate existing plaintext rows in place (values ARE recoverable here, unlike hashing) across d1/postgres/mysql.
- R5: Handle the "encryption key missing/rotated" case explicitly — fail closed with a clear error rather than sending a broken credential upstream.
- R6: Decryption happens on the hot proxy path — keep the per-request cost acceptable (cache the derived key, not the plaintext, where practical).

## Open questions (resolve during planning)

- Where does the master encryption key live? New Worker secret (e.g. `PROVIDER_KEY_ENCRYPTION_KEY`) vs. deriving from an existing secret. Note the admin session fix deliberately avoided new deploy config; this task likely **does** need a new secret — confirm with the owner and document the bootstrap/rotation story.
- Key rotation: support a key-version prefix on the ciphertext so rotation doesn't require downtime.
- Self-hosted Node/Postgres deployments need the same secret plumbed through.

## Acceptance Criteria

- [ ] `provider_api_keys.api_key` holds ciphertext; plaintext never persisted
- [ ] Egress path successfully authenticates upstream using decrypted keys (smoke test against a real provider)
- [ ] Admin endpoints expose masked values only; no endpoint returns plaintext
- [ ] Migration converts existing rows for d1/postgres/mysql without service interruption
- [ ] Missing/incorrect encryption key fails closed with a clear operator-facing error
- [ ] `npm run test:unit` passes across workspaces
