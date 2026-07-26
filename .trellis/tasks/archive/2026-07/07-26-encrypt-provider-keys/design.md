# Design — encrypt provider upstream API keys at rest

Decision (owner, 2026-07-26): **dedicated Worker secret** `PROVIDER_KEY_ENCRYPTION_KEY`. Not derived from `MASTER_KEY`, because `MASTER_KEY` is being rotated after the auth-bypass incident and that would make every provider key undecryptable.

## No schema change

Ciphertext is stored in the existing `provider_api_keys.api_key` TEXT column. No migration file — this is a value-format change, not a shape change. That also means rollback is just a code revert (as long as the secret is kept).

## Ciphertext format

```
ofk1.<base64url(iv)>.<base64url(ciphertext‖tag)>
```

- AES-GCM, 256-bit key, 12-byte random IV per value.
- Key = `SHA-256(PROVIDER_KEY_ENCRYPTION_KEY)`, so the secret can be any length/charset.
- `ofk1` is a version tag; a future `ofk2` can change algorithm or key without ambiguity.

**Legacy detection:** a value that does not start with `ofk1.` is treated as pre-existing plaintext and returned as-is. This is what makes a zero-downtime rollout possible — code can ship before the data is converted.

## Transparent at the storage layer

Encryption lives in the provider-api-keys repository, not at call sites. Rationale: there are ~7 consumers today (proxy egress, admin playground, key reveal, list, create, update) and a future one that forgets to decrypt would silently send ciphertext upstream, or worse, store plaintext. Making it a property of the repo removes that whole class of mistake.

Plumbing (optional parameter, so existing callers and tests keep working):

```
createD1StorageContext(db, opts?)            // opts.providerKeyCrypto
  └─ createD1Repositories(client, opts?)
       └─ createD1ProviderApiKeysRepository(client, opts?)
```

Same optional-param shape for the postgres/mysql factories.

Wired at the two real entry points, both of which already have env in hand:
- `packages/proxy/src/runtime/workers.ts` — `resolveWorkerDatabaseConfig(context.env)` already takes env.
- `packages/admin/lib/storage-context.ts` — `resolveAdminStorageContext(bindings)` already receives bindings.

Node/self-hosted paths read `process.env.PROVIDER_KEY_ENCRYPTION_KEY`.

## Behaviour matrix (fail-closed where it matters)

| Stored value | Secret set | Result |
|---|---|---|
| `ofk1.…` | yes | decrypt → plaintext |
| `ofk1.…` | **no** | **throw** — never send a broken credential upstream |
| plaintext (legacy) | yes | return as-is; log once that a plaintext row remains |
| plaintext (legacy) | no | return as-is (today's behaviour) |
| **write** any | yes | encrypt before persisting |
| **write** any | **no** | **throw** — refuse to silently keep storing plaintext |

The write-side throw is what stops the system from quietly regressing once encryption is expected.

## Backfill

Existing rows stay plaintext until converted. Conversion needs JS (SQL cannot do AES-GCM), so it ships as an admin-only endpoint rather than a CLI, since this deployment is Workers-based:

`POST /admin/providers/keys/encrypt-existing` — walks `provider_api_keys`, re-writes any non-`ofk1.` value encrypted, returns `{ converted, skipped }`. Idempotent; safe to re-run. Requires `MASTER_KEY` like every other admin route.

## Rollout

1. `wrangler secret put PROVIDER_KEY_ENCRYPTION_KEY --name my-octafuse-prod-proxy` (and the admin worker).
2. Deploy both workers. Existing plaintext keys keep working; new/edited keys are stored encrypted.
3. Call the backfill endpoint once.
4. Verify a live request still reaches an upstream provider.

Order matters: **set the secret before deploying**, or the write path starts throwing.

## Rollback

Revert the code. Rows already encrypted become unreadable by the old code, so if step 3 has run, rollback also requires restoring a pre-backfill D1 export — or re-entering the provider keys by hand. Keep the secret safe; losing it means re-entering every upstream key.
