# Syncing with upstream

This repository is a fork of [`OctaFuse/octafuse-gateway`](https://github.com/OctaFuse/octafuse-gateway). Remotes:

| Remote | URL | Use |
|---|---|---|
| `origin` | `git@github.com:lauchiwa/octafuse-gateway.git` | your fork — push here |
| `upstream` | `https://github.com/OctaFuse/octafuse-gateway.git` | read-only; fetch upstream changes |

## Routine sync

```bash
git fetch upstream
git checkout main
git merge upstream/main       # or: git rebase upstream/main
```

Static model presets (`packages/admin/lib/model-presets/*.json`) are compiled into the worker bundle, so after syncing new presets you must redeploy admin before they appear in the import dialog:

```bash
npm run deploy:cloudflare -- production --admin-only
```

## ⚠️ Security divergences — do NOT accept upstream's version

This fork carries security fixes that upstream does not have. When a merge conflicts in these files, **keep ours**. Taking upstream's version silently reintroduces a critical vulnerability.

### 1. `packages/admin/lib/auth.ts` + the two auth routes

Upstream's `checkAuth` only checks that an `admin_session` cookie *exists* — it never verifies the token. Combined with `app/api/admin/[...path]/route.ts` injecting the real `MASTER_KEY`, any forged cookie grants full admin access (verified: forged cookie returned HTTP 200 with admin data).

This fork replaces it with HMAC-signed, expiring session tokens. Affected files:
- `packages/admin/lib/auth.ts`
- `packages/admin/app/api/admin/[...path]/route.ts`
- `packages/admin/app/api/auth/login/route.ts`
- `packages/admin/app/api/auth/check/route.ts`

After any merge touching these, re-run `packages/admin/lib/auth.test.ts` and confirm a forged cookie is rejected:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Cookie: admin_session=totally-fake-value" \
  https://my-octafuse-prod-admin.chiwalau.workers.dev/api/admin/models   # must be 401
```

### 2. Gateway key storage (`api_keys.key_hash`)

Upstream stores `sk-` keys in plaintext in `api_keys.key`. This fork stores `SHA-256(key)` in `key_hash` plus a display-only `key_prefix` (migration `0015`). Conflicts in `packages/core/src/db/*/api-keys.impl.ts`, the drizzle schemas, `services/key-service.ts` or `services/api-key-hash.ts` must keep ours.

### 3. Provider key storage — **resolved in favour of upstream (v2.0.0)**

> **Superseded.** Earlier revisions of this document told you to keep a fork-local AES-GCM
> encryption layer here. That layer no longer exists — do not try to restore it.

This fork previously encrypted upstream provider credentials with AES-GCM
(`services/provider-key-crypto.ts`, `ofk1.` prefix, keyed by `PROVIDER_KEY_ENCRYPTION_KEY`).

Upstream v2.0.0 replaced the whole multi-key model with **one `api_key` per provider** stored on
`providers.api_key` (migration `0017_single_provider_key`), deleting `provider_api_keys` and every
`provider-api-keys.impl.ts`. We adopted upstream's architecture and **dropped our encryption layer**:
the credential is treated as a server-side secret like `DATABASE_URL`, and the Admin API that can
read it is already behind the master key.

Consequences for future merges:

- `PROVIDER_KEY_ENCRYPTION_KEY` is **no longer read anywhere**. If you find it reintroduced, that is a
  leftover, not a feature.
- Conflicts in `providers.impl.ts` / storage-context / repository factories should take **upstream's**
  side, not ours.
- Item 2 below (gateway `sk-` key hashing) is **unrelated and still ours** — it protects keys our own
  users hold, and upstream still stores those in plaintext. Do not conflate the two.

#### ⚠️ One-way data trap when cutting over from the encrypted layer

If a database was ever written by the **encrypted** build, its `provider_api_keys.api_key` values are
ciphertext (`ofk1.<iv>.<ct>`), not plaintext. Encryption was mandatory in that build — it threw rather
than storing plaintext — so there is no mixed state to hope for.

Migration `0017` copies that column verbatim:

```sql
UPDATE providers SET api_key = COALESCE((
  SELECT k.api_key FROM provider_api_keys k ...
), '');
```

It does **not** decrypt, and the post-merge code has no decrypt path left. The gateway would then send
`Authorization: Bearer ofk1.…` upstream and every provider returns 401 — after `DROP TABLE
provider_api_keys` has already discarded the only copy.

> **Upstream's stated escape hatch does not work here.** `scripts/db/export-provider-api-keys.mjs`
> reads `SELECT api_key FROM provider_api_keys` over raw SQL, so it exports the *ciphertext*. Running
> it gives you a backup file that looks fine and restores nothing usable.

Before applying `0017` on such a database, check first:

```bash
# any row starting with the cipher prefix means decrypt-before-migrate is required
psql "$DATABASE_URL" -c \
  "SELECT count(*) FROM provider_api_keys WHERE api_key LIKE 'ofk1.%';"
```

If the count is non-zero, decrypt those values back to plaintext (using the old
`PROVIDER_KEY_ENCRYPTION_KEY`) *before* migrating, or accept that the credentials are lost and
re-enter them from the provider afterwards.

**2026-08-02 production cutover — verified with the real trap**: the pre-cutover review had only
checked the local D1 database (3 rows, all plaintext, `ofk1.` count 0) and concluded the trap did
not apply. The remote production D1 had never been checked and actually held **9 `ofk1.`
ciphertext rows across 6 providers**. `0017` copied the ciphertext verbatim into
`providers.api_key` (visible as `ofk1.…` prefixes) and dropped the source table. The owner
accepted the loss (credentials re-entered afterwards); the plaintext was unrecoverable even from
the pre-migration `wrangler d1 export` backup, which dumps ciphertext too.

Check **every deployed environment** (local + each remote D1 / Postgres / MySQL) with the SQL
above before cutting over, not just the dev database.

### 4. `ADMIN_COOKIE_SECURE`

Upstream made `Secure` opt-in to fix plain-HTTP logins (their issue #36). This fork infers it from the request protocol instead — HTTPS gets `Secure` automatically, plain HTTP does not, and the env var still forces either way. Keep ours; it satisfies upstream's bug fix too.

## After any upstream merge

```bash
npm run test:unit          # core + proxy + admin
npm run typecheck -w @octafuse/admin
npm run typecheck -w @octafuse/proxy
```

If upstream has since fixed any of the above themselves, compare implementations rather than blindly keeping ours — but never end a merge with a weaker check than what is documented here.
