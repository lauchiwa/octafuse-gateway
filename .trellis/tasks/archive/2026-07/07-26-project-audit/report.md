# Security & Project Audit — octafuse-gateway

Date: 2026-07-26 · Scope: fork `lauchiwa/octafuse-gateway`, prod instance `my-octafuse-prod` (Cloudflare Workers + D1)
Method: read-only code inspection + local `typecheck`/`lint`/`test`/`npm audit`, plus one authorized live read-only probe of the owner's own instance.

## Severity summary

| # | Severity | Area | Finding |
|---|----------|------|---------|
| 1 | **CRITICAL** | Security / auth | Admin API auth bypass — any `admin_session=` cookie value grants full admin access (verified live) |
| 2 | **HIGH** | Security / secrets | Downstream gateway keys (`sk-…`) stored **plaintext**, returned in full by admin API |
| 3 | **HIGH** | Security / secrets | Provider upstream API keys stored **plaintext** at rest (no encryption) |
| 4 | **MEDIUM** | Security / session | Session cookie is unsigned/unverified; `/api/auth/check` is cosmetic |
| 5 | **MEDIUM** | Security / transport | `ADMIN_COOKIE_SECURE` defaults **off** |
| 6 | **LOW** | Deps | 24 npm advisories (21 high) — all in dev/build toolchain, not Worker runtime |
| 7 | **LOW** | Quality / tests | `proxy` unit tests fail on fresh checkout (core `dist/` missing) |
| 8 | **LOW** | Quality / tests | `core` has `vitest` test files that never run (suite uses `node:test`) |
| 9 | **INFO** | Quality | admin lint: 0 errors / 7 warnings; admin+proxy typecheck clean |
| 10 | **INFO** | Supply chain | No `upstream` remote; upstream sync is manual |

---

## 1. CRITICAL — Admin API authentication bypass (verified live)

**Evidence:**
- `packages/admin/lib/auth.ts` — `checkAuth` only substring-matches the cookie name:
  ```ts
  export function checkAuth(request: Request): boolean {
    const cookieHeader = request.headers.get('cookie');
    return cookieHeader?.includes('admin_session=') ?? false;  // value never validated
  }
  ```
- `packages/admin/app/api/admin/[...path]/route.ts` — when `checkAuth` passes, the server injects the real MASTER_KEY and forwards to the Hono admin API:
  ```ts
  if (checkAuth(request)) {
    h.set('Authorization', `Bearer ${masterKey}`);   // full admin authority granted
  }
  ```
- Session token from `generateSessionToken()` is random but **never stored, signed, or checked** — so any value passes.

**Live confirmation** (owner's instance, single read-only GET):
```
curl -H "Cookie: admin_session=totally-fake-value" \
  https://my-octafuse-prod-admin.chiwalau.workers.dev/api/admin/models
→ HTTP 200, full model catalog JSON   (no credentials, no valid session)
curl (no cookie) → HTTP 401
```

**Blast radius** (everything under `/api/admin/*` is reachable unauthenticated):
- Dump all downstream gateway keys `sk-…` in **plaintext** (see #2) → LLM credit theft.
- Read/modify users, budgets, models, routes, system config; read request logs (prompts/completions).
- Add a malicious provider + use `/admin/playground` to fetch attacker-chosen URLs (SSRF to internal/metadata endpoints), billed to the owner.

**Remediation (any one closes the hole; do #a immediately):**
- **a.** Stop trusting cookie presence. Replace `checkAuth` presence-check with real verification: sign the session (HMAC/JWT with a server secret) and verify signature+expiry, **or** persist sessions server-side (D1 table) and look them up. Reject on mismatch.
- **b.** Until fixed, treat the instance as exposed: rotate `MASTER_KEY` and every `sk-` gateway key **after** the fix ships (rotating before the fix is pointless — the bypass re-exposes them).
- Consider a Cloudflare Access / WAF rule in front of `/api/admin/*` as defense-in-depth.

---

## 2. HIGH — Gateway keys stored plaintext and returned in full

**Evidence:**
- `packages/core/src/db/d1/api-keys.impl.ts` — proxy validates by plaintext equality: `SELECT * FROM api_keys WHERE key = ? AND status = 'active'`; the `key` column holds the raw `sk-…`.
- `packages/admin/lib/services/admin/keys-service.ts:142,348` returns `key: result.key` / `key: info.key` — full plaintext in admin responses.
- `packages/core/src/services/key-service.ts` generates `sk-` + 32 random bytes but never hashes on store.

**Impact:** any read of the keys endpoint (including via #1) yields usable production keys. A DB read (backup, D1 console, leak) does the same.

**Remediation:** store a hash (e.g. SHA-256) of the key; look up by hash on the proxy path; show only a masked value + a one-time reveal at creation (`new-api-key-secret-banner.tsx` already implies a create-time reveal pattern). This is a schema+lookup change — plan as its own task with a migration and key re-issue.

---

## 3. HIGH — Provider upstream API keys plaintext at rest

**Evidence:** `packages/core/src/db/d1/provider-api-keys.impl.ts` stores `api_key` plaintext; `getProviderKeyPlaintext()` returns it. No `encrypt/decrypt/cipher` anywhere in `packages/core/src` (only `crypto.randomUUID`/`getRandomValues`). Admin listing does mask (`masked_api_key`), which is good, but the underlying storage is cleartext.

**Impact:** DB compromise or #1 exposes upstream provider credentials (OpenAI/Anthropic/etc.).

**Remediation:** encrypt provider keys at rest (envelope encryption with a Worker secret / KV-held key), decrypt only on the egress path. Keep the existing masking for admin display.

---

## 4. MEDIUM — Session is unsigned; `/api/auth/check` is cosmetic

`app/api/auth/check/route.ts` and `AuthWrapper.tsx` only check that an `admin_session` cookie exists. This is client-side UX gating with no security value on its own; the real gate is (should be) #1. Folds into the #1a fix.

## 5. MEDIUM — `ADMIN_COOKIE_SECURE` defaults off

`packages/admin/lib/auth.ts:resolveCookieSecure()` returns `false` unless explicitly enabled → the session cookie can ride plaintext HTTP. `sameSite:'strict'` mitigates CSRF but not network capture. For a hosted admin behind HTTPS, default this **on** (or force `Secure` in production). Set `ADMIN_COOKIE_SECURE=1` on the current instance now.

## 6. LOW — Dependency advisories (dev/build toolchain only)

`npm audit`: **24 vulnerabilities (2 low, 1 moderate, 21 high)**. The high-severity ones are in `postcss` (build-time), `sharp`/`libvips` and `miniflare` (pulled via `wrangler`, dev-only), `esbuild` (dev). None of these ship in the deployed Worker runtime, so runtime exposure is low. Still worth `npm audit fix` and bumping `wrangler` (4.107→4.114) on a maintenance pass. Notable outdated majors (optional): recharts 2→3, tailwind 3→4, typescript 5→7, eslint 9→10, `@cloudflare/workers-types` 4→5.

## 7. LOW — Proxy tests fail on fresh checkout

`npm run test:unit` → proxy: **8 pass / 3 fail**, all `ERR_MODULE_NOT_FOUND: @octafuse/core/dist/index.js`. Cause: `packages/core/dist/` is not built and proxy tests import the built entry. Not a product bug, but the suite isn't self-bootstrapping. Fix: add a `pretest`/build step for core, or point proxy tests at source. (core: 12 pass; admin: 72 pass.)

## 8. LOW — Dead `vitest` test files in core

`tsc` on core reports `TS2307: Cannot find module 'vitest'` for several `*.test.ts` (e.g. `provider-key-utils.test.ts`, `model-sticky-config.test.ts`, `gemini-upstream-url.test.ts`). The core suite runs via `node:test`, so these vitest-authored tests never execute and don't typecheck. Either wire up vitest or port them to `node:test`.

## 9. INFO — Quality baseline is healthy
- Typecheck: **admin ✅, proxy ✅** clean. Core clean except the dead vitest files (#8).
- Lint (admin): **0 errors, 7 warnings** (react-hooks/exhaustive-deps, one `<img>`), all cosmetic.
- SQL: parameterized throughout; dynamic `UPDATE` columns come from a fixed `PROVIDER_API_KEY_PATCH_COLS` whitelist with `.bind()` values — **no injection**.
- Custom upstream headers feature: rejects control chars (`\r \n \t`, `0x7F`), validates names against an HTTP-token regex, applies a denylist, and merges `{ ...custom, ...base }` so built-in auth headers win — **well designed**.
- Secrets: `.env*` and `cloudflare-worker/*.env` correctly gitignored; no secret files tracked; `production.env` confirmed untracked.

## 10. INFO — Fork/supply-chain hygiene
`origin` = fork `lauchiwa/octafuse-gateway`; `package.json.repository.url` still points to upstream `OctaFuse/octafuse-gateway`; no `upstream` remote configured. Upstream sync (e.g. the opus-5 preset) is done manually. Add an `upstream` remote and a documented sync flow to reduce drift risk.

---

## Operational note (this session)
A Cloudflare API token was pasted in plaintext into the terminal during deploy and is now in shell history. **Revoke it** (Dashboard → My Profile → API Tokens) — deploy is done and it is no longer needed.

## Suggested follow-up tasks (fixes are out of scope for this read-only audit)
1. **fix/admin-auth-bypass** (Critical, do first): real session verification in `checkAuth` + `[...path]` route.
2. **fix/hash-gateway-keys** (High): hash `sk-` keys at rest, migrate, re-issue.
3. **fix/encrypt-provider-keys** (High): envelope-encrypt provider `api_key`.
4. **chore/secure-cookie-default** (Medium): default `ADMIN_COOKIE_SECURE` on in prod.
5. **chore/deps-and-test-bootstrap** (Low): `npm audit fix`, core build-before-test, resolve vitest files.
