# Design — signed admin session

## Approach: stateless HMAC-signed token

No D1 session table (keeps Workers cold-path cheap, no migration). Token is a mini-JWT:

```
admin_session = base64url(payloadJson) "." base64url(HMAC-SHA256(base64url(payloadJson), key))
payloadJson   = {"iat": <unix s>, "exp": <unix s>, "nonce": <hex>}
```

- `nonce` = 16 random bytes (hex) so identical-time tokens differ.
- `exp` = iat + 24h (matches current cookie 24h expiry).

### Signing key derivation (R4 — no new config)

```
keyMaterial = SHA-256( "octafuse-admin-session:v1:" || ADMIN_PASSWORD )   // 32 bytes, domain-separated
key = crypto.subtle.importKey("raw", keyMaterial, {name:"HMAC", hash:"SHA-256"}, false, ["sign","verify"])
```

Rationale: `ADMIN_PASSWORD` is already a required secret (typed in `types/cloudflare-env-shim.d.ts`, set via `wrangler secret put`). Deriving from it means the fix ships with zero new deployment variables. Password rotation invalidates outstanding sessions — desirable. The static prefix domain-separates this use from any other use of the password. Forging a token requires knowing `ADMIN_PASSWORD`, which is exactly the login credential.

### Verification (R1–R3)

`verifySession(token, key)`:
1. Split on `.`; require exactly 2 parts. Reject otherwise.
2. `crypto.subtle.verify("HMAC", key, sigBytes, payloadBytes)` — **constant-time** by construction. Reject on false.
3. Parse payload JSON; require numeric `exp`; reject if `exp <= nowSeconds`.
4. Return true only if all pass. Any throw → false (fail closed).

## Files touched

### `packages/admin/lib/auth.ts` (core change)
- Add `deriveAdminSigningKey(adminPassword: string): Promise<CryptoKey>`.
- Add `async issueSessionToken(adminPassword, ttlSeconds=86400): Promise<string>`.
- Add `async verifySessionToken(token, adminPassword): Promise<boolean>`.
- Add `async verifyRequestSession(request: Request, adminPassword: string): Promise<boolean>` — extracts `admin_session` from the `Cookie` header (exact cookie parse, not substring) and calls `verifySessionToken`.
- Keep `resolveCookieSecure` as-is (separate task). Remove the old presence-only `checkAuth` and the now-unused `generateSessionToken` export (nonce generation moves inside `issueSessionToken`). Update the file header comment.
- Add small helpers: `base64url` encode/decode, `readCookie(header, name)`.

### `packages/admin/app/api/auth/login/route.ts`
- Replace `generateSessionToken()` with `await issueSessionToken(adminPassword)`. `adminPassword` is already resolved in this handler (lines 24–31).

### `packages/admin/app/api/admin/[...path]/route.ts`
- Resolve `adminPassword` from the same `env` it already reads (`env.ADMIN_PASSWORD` on Cloudflare; `process.env.ADMIN_PASSWORD` on Node fallback).
- Replace `if (checkAuth(request))` with `if (await verifyRequestSession(request, adminPassword))`. The `else` branch (external `Authorization: Bearer <MASTER_KEY>`) is unchanged (R6).
- If `adminPassword` is missing, skip the cookie branch (cookie can never verify) and fall through to Bearer check — preserves external access even if password not set, and browser path fails closed.

### `packages/admin/app/api/auth/check/route.ts`
- Read `admin_session` via `cookies()`, resolve `ADMIN_PASSWORD` from env, return `{authenticated: await verifySessionToken(token, adminPassword)}`. Invalid/expired → `authenticated:false` (AuthWrapper then shows login).

### `packages/admin/lib/auth.test.ts` (new) + `package.json`
- Unit tests: round-trip verify ok; tampered payload → false; tampered signature → false; expired (`ttl` negative) → false; wrong password → false; malformed token → false; `verifyRequestSession` parses cookie among others.
- Add `lib/auth.test.ts` to admin `test:unit` file list so it runs.

## Runtime notes
- `crypto.subtle` is available in the Workers runtime and in Node ≥ 20 (`tsx --test`). Module already relies on global `crypto`.
- All new exports are async; the two server routes that call them are already async.

## Rollout / rollback
- Rollout: `npm run deploy:cloudflare -- production --admin-only` (no migrate). Existing admins re-login once.
- Verify post-deploy: forged-cookie probe returns 401; real login works.
- Rollback: revert the 4 source files and redeploy; no data/schema changes, so rollback is clean.

## Post-fix (owner action, outside code)
- Rotate `MASTER_KEY` and all `sk-` gateway keys **after** deploy (bypass previously exposed them).
