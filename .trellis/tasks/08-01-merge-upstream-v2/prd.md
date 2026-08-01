# Merge upstream v2.0.0 with local security enhancements

## Goal

Merge OctaFuse upstream main (v2.0.0) into the local fork, preserving local security enhancements (gateway key hash, admin auth fix, custom headers) while adopting upstream's new architecture (single provider key, route strategies, audio transcription, admin UI refactor).

## Background

The local fork has diverged from upstream (`b28bf22`) with 23 commits (mostly security and operational improvements), while upstream has added 32 commits culminating in the v2.0.0 release with major architectural changes.

## Confirmed facts

- **Provider key encryption** (`provider-key-crypto.ts`) will be dropped in favor of upstream's plaintext single key on `providers.api_key`. Decision: **方案A**.
- **Gateway key hash** (`api-key-hash.ts`, SHA-256 digest of `sk-` keys) is orthogonal to upstream changes and must be preserved.
- **Custom upstream headers** per provider (our `providers.custom_headers`) does not exist upstream — must be preserved.
- **Admin auth bypass fix** (HMAC signature verification on `admin_session`) does not exist upstream — must be preserved.
- **Upstream deleted** `provider_api_keys` table and all related code (migration 0015). `provider-api-keys.impl.ts`, `provider-key-*`, `sticky-key-binding.*`, `model-sticky-config.*` are removed upstream.
- **Upstream added**: audio transcription (`/v1/audio`, `audio-usage-charge.ts`, `openai-audio-driver.ts`), route strategies (`route-attempt-planner.ts`, `route-strategies/`), route topology (`route-topology.ts`), model route policy, and 3 new migrations (0014 audio billing, 0015 single provider key, 0016 route surfaces/pools).
- **Upstream refactored**: admin providers/routes/models pages, failover dispatch, model router, and all three DB driver layers.
- **Upstream added** system config for route strategy (`ROUTE_STRATEGY`) with `affinity` as default.

## Requirements

- R1: All upstream v2.0.0 features are adopted — audio transcription, route strategies, single provider key, new admin UI.
- R2: Local security features are preserved — gateway key hash (`sk-` SHA-256 digest), admin session HMAC verification, custom upstream headers.
- R3: No regression on existing chat, images, messages, gemini, responses paths.
- R4: All existing tests pass (core + proxy + admin).
- R5: Migrations are reconciled — local migrations (0014 custom_headers, 0015 hash_api_keys) and upstream migrations (0014 audio billing, 0015 single key, 0016 route surfaces) must coexist without conflict.

## Migration numbering plan (方案 B)

Reconcile numbering to avoid collision:

| Final # | Our file | Upstream file |
|---------|----------|---------------|
| 0014 | `0014_provider_custom_headers.sql` | — |
| 0015 | `0015_hash_api_keys.sql` | — |
| 0016 | — | `0016_request_log_audio_billing.sql` (was 0014) |
| 0017 | — | `0017_single_provider_key.sql` (was 0015) |
| 0018 | — | `0018_route_surfaces_pools.sql` (was 0016) |

## Squash plan (方案 B)

Rebase local commits onto upstream/main as 4 squashed commits:

1. `feat(providers): custom upstream headers per provider × protocol` — custom_headers column, schema, provider impl, egress merge, admin UI, playground injection
2. `fix(admin): verify admin_session HMAC signature` — auth bypass fix, session verification
3. `feat(security)!: hash gateway sk- keys at rest` — SHA-256 digest, key prefix, api_keys table updates
4. `chore: deploy scripts, audit maintenance, and toolchain` — Cloudflare deploy fixes, Trellis toolchain, cookie Secure, dep bumps

**Provider key encryption commit** (`88ccc82`) is dropped during squash (方案A).

## Key risks

- **File-level merge conflicts**: 45+ files modified by both sides, including core egress drivers, storage layer, admin services, and migration files.
- **Architectural conflict**: upstream removed `provider-api-keys`; our local code references it indirectly through the proxy middleware stack.
- **Migration numbering collision**: both sides have an `0014` migration (ours: custom_headers, theirs: audio billing). Must renumber one side.
- **Admin route refactor**: upstream completely rewrote admin providers/routes pages; our local changes (custom_headers dialog, HMAC fix) must be reapplied on top.
- **Package.json dependency bumps**: upstream updated many deps; compatible with our Node 24 runtime.

## Acceptance criteria

- [ ] Merge succeeds with all local security commits preserved on top of upstream v2.0.0.
- [ ] `npm run build` passes across all packages.
- [ ] `npm run check` (lint + type-check) passes.
- [ ] All unit tests pass (core + proxy + admin).
- [ ] Audio transcription endpoint works end-to-end.
- [ ] Route strategies work (affinity/round-robin/weighted/strict).
- [ ] Single provider key works (providers with one `api_key`, no `provider_api_keys`).
- [ ] Gateway `sk-` key hash still works (SHA-256 digest, key prefix stored).
- [ ] Custom upstream headers still injected on egress.
- [ ] Admin auth bypass fix still in place (HMAC session verification).
- [ ] Existing chat/images/messages/gemini/responses paths unbroken.

## Out of scope

- Provider key encryption at rest (dropped per 方案A).
- New features beyond what upstream v2.0.0 delivers.
- Migration rollback scripts for production data.

## Open questions

None — all resolved:
- 方案A: Drop provider key encryption
- 方案B: Renumber upstream migrations to 0016-0018
- Rebase strategy: Squash to 4 logical commits + rebase onto upstream/main