# Fix admin API auth bypass (signed session)

## Problem

`/api/admin/[...path]/route.ts` injects the real `MASTER_KEY` whenever `checkAuth(request)` is true, but `checkAuth` (`lib/auth.ts`) only substring-checks that an `admin_session=` cookie exists — the token value is never verified. `generateSessionToken()` produces a random value that is never stored or signed. Result: any request with an arbitrary `admin_session=` cookie gets full admin authority. Verified live: forged cookie → HTTP 200 with admin data.

## Requirements

- R1: `checkAuth` must **cryptographically verify** the session token, not check presence. A forged/tampered/arbitrary `admin_session` value must be rejected (server returns 401).
- R2: Sessions must **expire**; an expired token must be rejected even if the signature is valid.
- R3: Signature verification must be **constant-time** (no timing oracle on the MAC).
- R4: The signing key is **derived from `ADMIN_PASSWORD`** — no new deployment secret/variable required. If `ADMIN_PASSWORD` is unset, auth fails closed (same as today's "credentials not configured" 500).
- R5: Login (`/api/auth/login`) issues a signed token; `/api/auth/check` and `/api/admin/[...path]` both verify it with the same logic.
- R6: External callers using `Authorization: Bearer <MASTER_KEY>` directly (documented in the route) must **still work** unchanged.
- R7: No change to deployment inputs; existing browser sessions may be invalidated (users re-login once) — acceptable.

## Non-goals (tracked separately in audit report)

- Hashing gateway `sk-` keys at rest (report #2).
- Encrypting provider keys (report #3).
- Defaulting `ADMIN_COOKIE_SECURE` on (report #5).

## Acceptance Criteria

- [ ] Forged cookie `admin_session=<arbitrary>` against `/api/admin/*` → 401 (was 200). Re-probe live after deploy.
- [ ] Valid login → subsequent `/api/admin/*` calls succeed via the signed cookie.
- [ ] Tampered payload, tampered signature, and expired token all rejected — covered by unit tests.
- [ ] `Authorization: Bearer <MASTER_KEY>` path still returns 200.
- [ ] `npm run typecheck -w @octafuse/admin` clean; new `lib/auth.test.ts` passes under the admin test runner.
- [ ] No new required env var introduced (grep confirms signing derives from `ADMIN_PASSWORD`).
