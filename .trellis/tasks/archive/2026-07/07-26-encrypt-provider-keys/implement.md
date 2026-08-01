# Implement — encrypt provider upstream API keys at rest

## What shipped

1. [x] `packages/core/src/services/provider-key-crypto.ts` — AES-GCM encrypt/decrypt, `ofk1.` format, legacy-plaintext passthrough, `createProviderKeyCrypto` handle. Exported from the core barrel and as `@octafuse/core/services/provider-key-crypto`.
2. [x] `provider-key-crypto.test.ts` — 11 tests (round-trip, IV uniqueness, wrong secret, tamper rejection, legacy passthrough, fail-closed read/write, malformed input, unicode/long values). Registered in core `test:unit`.
3. [x] Three provider-key repo impls (d1 / postgres / mysql) take an optional `ProviderKeyCrypto`:
   - `getActiveProviderKeys` (proxy egress hot path) and `getProviderKeyPlaintext` decrypt
   - `listProviderKeys` / `getProviderKeyById` decrypt before masking, so the mask reflects the real key
   - `createProviderKey` / `updateProviderKeyByPatch` encrypt before persisting
   - No crypto injected → behaves exactly as before (legacy passthrough), keeping existing tests valid
4. [x] `GatewayRepositoriesOptions` threaded through `createXRepositories` → `createXStorageContext` (all optional params, no caller breakage).
5. [x] Entry points supply the secret: `proxy/src/runtime/workers.ts` (from `context.env`), `proxy/src/runtime/node.ts` (from `process.env`), `admin/lib/storage-context.ts` (from bindings, populated by `app/api/admin/[...path]/route.ts`). `AdminBindings` gained `PROVIDER_KEY_ENCRYPTION_KEY`.
6. [x] Backfill: `POST /admin/providers/keys/encrypt-existing` → `encryptExistingProviderKeysService`. Reads (decrypt/passthrough) then writes (encrypt) each key. Idempotent; per-key failures collected rather than aborting the run.

No migration file: ciphertext lives in the existing `provider_api_keys.api_key` TEXT column.

## Verification (all run)

| Check | Result |
|---|---|
| core `tsc --noEmit` | clean (bar the known dead-vitest files, task 07-26-audit-maintenance M4) |
| proxy `typecheck` | clean |
| admin `typecheck` | clean |
| core `test:unit` | 117 pass / 0 fail |
| admin `test:unit` | 81 pass / 0 fail |
| proxy `test:unit` | 30 pass / 0 fail |
| admin `build:cf` | worker bundle builds |

Route-collision check: `POST /keys/encrypt-existing` cannot be captured by `POST /:id/keys` (that pattern needs a literal `keys` second segment), and it is registered first regardless.

## NOT verified locally
- No end-to-end run against a real upstream provider with an encrypted key. The unit tests cover the crypto contract, but the full egress path (decrypt → sign upstream request) has not been exercised against a live provider. **Do this right after deploy.**
- Postgres/MySQL impls are code-symmetric with d1 but were not run against live engines (no local pg/mysql in this environment).

## Deploy (owner)

Set the secret on **both** workers before deploying, or the write path starts throwing:

```bash
npx wrangler secret put PROVIDER_KEY_ENCRYPTION_KEY --name my-octafuse-prod-proxy
npx wrangler secret put PROVIDER_KEY_ENCRYPTION_KEY --name my-octafuse-prod-admin
```

Use a long random value, e.g. `openssl rand -base64 48`. **Store it somewhere safe — losing it means re-entering every upstream provider key by hand.**

Then:
```bash
npm run deploy:cloudflare -- production          # both workers
```

Existing plaintext keys keep working at this point. Then convert them once:
```bash
curl -X POST -H "Authorization: Bearer <MASTER_KEY>" \
  https://my-octafuse-prod-admin.chiwalau.workers.dev/api/admin/providers/keys/encrypt-existing
```

Finally send one real request through the gateway to confirm upstream auth still works.

## Rollback
Revert the code. If the backfill has already run, encrypted rows are unreadable by the old code — rollback then also needs a pre-backfill D1 export, or re-entering the provider keys.
