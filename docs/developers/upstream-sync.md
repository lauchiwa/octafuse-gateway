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

### 3. Provider key encryption (`provider_api_keys.api_key`)

Upstream stores upstream provider credentials in plaintext. This fork encrypts them with AES-GCM (`services/provider-key-crypto.ts`, `ofk1.` prefix), keyed by the `PROVIDER_KEY_ENCRYPTION_KEY` secret. Conflicts in `packages/core/src/db/*/provider-api-keys.impl.ts` or the storage-context/repository factories must keep ours.

### 4. `ADMIN_COOKIE_SECURE`

Upstream made `Secure` opt-in to fix plain-HTTP logins (their issue #36). This fork infers it from the request protocol instead — HTTPS gets `Secure` automatically, plain HTTP does not, and the env var still forces either way. Keep ours; it satisfies upstream's bug fix too.

## After any upstream merge

```bash
npm run test:unit          # core + proxy + admin
npm run typecheck -w @octafuse/admin
npm run typecheck -w @octafuse/proxy
```

If upstream has since fixed any of the above themselves, compare implementations rather than blindly keeping ours — but never end a merge with a weaker check than what is documented here.
