# Implement — audit maintenance

## M1 — cookie `Secure` (design changed mid-task)

The PRD said "default `ADMIN_COOKIE_SECURE` on". **I did not do that**, because the repo history shows the current opt-in default is a deliberate fix, not an oversight:

> CHANGELOG #69 / issue #36 — "Fix Admin console login being kicked out immediately on plain HTTP (e.g. Docker quickstart): make `admin_session` `Secure` opt-in via `ADMIN_COOKIE_SECURE` instead of always-on."

Flipping the default on would have re-introduced that bug for every plain-HTTP Docker/quickstart deployment.

Shipped instead — **infer from the request protocol**, which the PRD listed as an acceptable alternative:

- explicit `1`/`true`/`yes`/`on` → force `Secure`
- explicit `0`/`false`/`no`/`off` → force no `Secure`
- unset → `Secure` iff the request URL is `https:`

HTTPS deployments (like the Cloudflare instance) are hardened automatically; plain HTTP still works; both overrides remain. `resolveCookieSecure(request?)` now takes the request; the login route passes it.

Docs updated so they no longer describe the old contract: `docs/operators/deployment/docker.md` (env table + §7.3), `packages/admin/AGENTS.md`, `.trellis/spec/architecture.md`.

Tests: 2 new cases in `packages/admin/lib/auth.test.ts` (protocol inference both ways, explicit override both ways).

## M2 — dependencies

`npm audit fix` (non-breaking only): **24 → 18** advisories. `wrangler` is already 4.114.0.

Remaining 18 (`brace-expansion`, `postcss`, `sharp` via `miniflare`→`wrangler`) need `npm audit fix --force`, which pulls breaking majors (tailwind 3→4, eslint 9→10, recharts 2→3, typescript 5→7). **Deliberately not done** — all remaining advisories are dev/build toolchain and never reach the deployed Worker runtime, so forcing breaking majors would risk a working build for no runtime security gain. Revisit as its own upgrade task.

Only `package-lock.json` changed; no dependency ranges were edited.

## M3 — test bootstrap

Added `pretest:unit` to `packages/proxy/package.json` running `npm run build -w @octafuse/core`, because the proxy tests import the built `@octafuse/core/dist` entry.

Verified from a genuinely clean state (`rm -rf packages/core/dist` then `npm run test:unit`): 159 + 30 + 83 = **272 pass, 0 fail**, no manual pre-build.

## M4 — dead vitest files

Ported all five to `node:test` + `node:assert/strict` rather than adding vitest, keeping one testing idiom in the repo:
`gemini-upstream-url`, `lib/resolve-me-metadata`, `db/model-sticky-config`, `db/provider-key-limit-config`, `db/provider-key-utils`.

Assertions converted with a paren-balanced transform (`toBe`→`strictEqual`, `toBeNull`→`strictEqual(...,null)`, `toEqual`→`deepStrictEqual`, `toThrow`→`throws`, `not.*`→negated forms); one multi-line `toContain` converted by hand to `assert.ok(...includes(...))`.

All five registered in core `test:unit`. Core tests went **117 → 159** — those 42 assertions had never executed. Core `tsc --noEmit` is now fully clean (the `TS2307: Cannot find module 'vitest'` errors are gone).

## M5 — upstream remote

Added `upstream` → `https://github.com/OctaFuse/octafuse-gateway.git`.

Wrote `docs/developers/upstream-sync.md` (linked from `docs/developers/README.md`) covering the sync flow, the redeploy-after-preset-sync gotcha, and — most importantly — the four places where this fork **diverges for security reasons** and must not be overwritten by an upstream merge: the signed-session auth fix, `key_hash` storage, provider-key encryption, and the `ADMIN_COOKIE_SECURE` inference. Includes the forged-cookie curl to re-verify after any merge.

## Verification

| Check | Result |
|---|---|
| core `tsc --noEmit` | clean (vitest errors gone) |
| proxy / admin `typecheck` | clean |
| `npm run test:unit` from clean checkout | 272 pass / 0 fail |
| admin `lint` | 0 errors, 7 pre-existing warnings (unchanged) |
| admin `build:cf` | worker bundle builds |
| `npm audit` | 24 → 18 |
