# Maintenance: cookie secure default, deps, test bootstrap, upstream remote

Source: `.trellis/tasks/archive/2026-07/07-26-project-audit/report.md` findings #5–#8 and #10.
Five independent, low-risk items. Each can ship separately; no ordering dependency between them.

## Scope

### M1 — Default `ADMIN_COOKIE_SECURE` on in production (report #5, MEDIUM)

`packages/admin/lib/auth.ts:resolveCookieSecure()` returns `false` unless explicitly enabled, so the `admin_session` cookie can travel over plaintext HTTP. `sameSite:'strict'` mitigates CSRF but not network capture.

Constraint: must not break local HTTP development or self-hosted plain-HTTP deployments. Prefer "secure by default, explicit opt-out" (e.g. default on unless `ADMIN_COOKIE_SECURE` is explicitly falsy, or key the default off `NODE_ENV`/runtime detection). Document the escape hatch.

### M2 — Dependency advisories (report #6, LOW)

`npm audit`: 24 advisories (2 low, 1 moderate, 21 high). All in the **dev/build toolchain**, not the deployed Worker runtime: `postcss` (build), `sharp`/libvips + `miniflare` (via `wrangler`, dev), `esbuild` (dev). Runtime exposure is low.

Do: `npm audit fix`; bump `wrangler` 4.107 → 4.114. Re-run typecheck + full unit suites + `build:cf` afterwards. Optional/riskier majors, evaluate separately: recharts 2→3, tailwind 3→4, eslint 9→10, `@cloudflare/workers-types` 4→5, typescript 5→7.

### M3 — Make proxy unit tests self-bootstrapping (report #7, LOW)

On a fresh checkout `npm run test:unit` fails 3 proxy tests with `ERR_MODULE_NOT_FOUND: @octafuse/core/dist/index.js` — proxy tests import the built core entry but `packages/core/dist/` is not built. (Counts at audit time: core 12 pass, admin 81 pass, proxy 8 pass / 3 fail.)

Fix: build core before proxy tests (a `pretest:unit` step or root-level ordering), or point the affected proxy tests at core source instead of `dist`.

### M4 — Dead vitest test files in core (report #8, LOW)

Core's suite runs on `node:test`, but several test files import `vitest`, so they never execute and fail `tsc`:
`src/db/model-sticky-config.test.ts`, `src/db/provider-key-limit-config.test.ts`, `src/db/provider-key-utils.test.ts`, `src/gemini-upstream-url.test.ts`, `src/lib/resolve-me-metadata.test.ts`.

Decide one: add vitest as a real dev dependency + runner, or port these to `node:test` and register them in core's `test:unit`. Either way core `tsc --noEmit` must come out clean.

### M5 — Configure upstream remote (report #10, INFO)

This repo is a GitHub fork of `OctaFuse/octafuse-gateway` but has no `upstream` remote; `package.json.repository.url` still points at upstream. Sync is manual.

Add `upstream` remote and document the sync flow in the contributor docs.

**Important:** the admin auth fix (`07-26-admin-auth-bypass`) diverges from upstream, which still ships the vulnerable substring `checkAuth`. The sync doc must call out that `packages/admin/lib/auth.ts` and the two auth routes must NOT be reverted to upstream on merge.

## Constraints

- No behaviour change to the admin auth fix already shipped.
- M2 must not silently pull a breaking major into the Worker runtime — verify `build:cf` after upgrading.

## Acceptance Criteria

- [ ] M1: cookie is `Secure` by default in production; documented opt-out for plain-HTTP setups; local dev still works
- [ ] M2: `npm audit` high-severity count reduced; typecheck + all unit suites + `build:cf` still pass
- [ ] M3: `npm run test:unit` passes from a clean checkout with no manual pre-build
- [ ] M4: core `tsc -p tsconfig.json --noEmit` clean; the five listed test files either run or are removed
- [ ] M5: `upstream` remote documented; sync notes warn about the auth.ts divergence
