# Implement — signed admin session

## Ordered checklist

1. [ ] `lib/auth.ts`: add `base64url` enc/dec + `readCookie(header, name)` helpers.
2. [ ] `lib/auth.ts`: add `deriveAdminSigningKey`, `issueSessionToken`, `verifySessionToken`, `verifyRequestSession`; remove `checkAuth` + `generateSessionToken`; update header comment. Keep `resolveCookieSecure`.
3. [ ] `app/api/auth/login/route.ts`: issue signed token (`await issueSessionToken(adminPassword)`).
4. [ ] `app/api/admin/[...path]/route.ts`: resolve `adminPassword` from env; `await verifyRequestSession(...)`; keep Bearer branch.
5. [ ] `app/api/auth/check/route.ts`: verify token instead of presence.
6. [ ] `lib/auth.test.ts`: add unit tests; register file in admin `package.json` `test:unit`.

## Validation (run in order)

```bash
# type safety
npm run typecheck -w @octafuse/admin

# unit tests (new auth tests + existing admin suite)
npm run test:unit -w @octafuse/admin

# build the CF bundle (also proves no runtime import breaks)
npm run build:cf -w @octafuse/admin
```

## Review gate
- Confirm the Bearer external-caller path is untouched (R6).
- Confirm no new env var: `grep -rn "process.env\|env\." app/api/admin app/api/auth lib/auth.ts` shows only `ADMIN_PASSWORD`/`ADMIN_USERNAME`/existing vars.

## Deploy (owner triggers; needs CLOUDFLARE_API_TOKEN or wrangler login)

```bash
npm run deploy:cloudflare -- production --admin-only
```

## Post-deploy verification

```bash
# forged cookie must now be rejected
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Cookie: admin_session=totally-fake-value" \
  https://my-octafuse-prod-admin.chiwalau.workers.dev/api/admin/models   # expect 401

# real login in the browser still works (manual)
```

## Rollback point
Revert the 4 source files (`git checkout -- packages/admin/lib/auth.ts packages/admin/app/api/...`) and redeploy. No schema/data changes.

## After merge (owner, non-code)
- Rotate `MASTER_KEY` and all `sk-` gateway keys.
- Set `ADMIN_COOKIE_SECURE=1` on the instance (report finding #5).
