# Journal - chiwalau (Part 1)

> AI development session journal
> Started: 2026-07-24

---



## Session 1: Provider 自定义上游 header（provider × protocol）

**Date**: 2026-07-25
**Task**: Provider 自定义上游 header（provider × protocol）
**Branch**: `main`

### Summary

新增 providers.custom_headers(JSON) 列，按 provider × 协议注入上游 fetch header（主要 User-Agent）。合并语义 { ...custom, ...base } 保证驱动内置鉴权/协议 header 永远覆盖 custom，外加校验器 denylist 双保险。贯穿三驱动 DB 层（三份同号迁移 0014 + schema + impl）、proxy 四驱动 egress、admin provider 弹窗（四语言）。core 95 测试 / proxy 34 / admin 58 全过，lint+typecheck 通过。AC8（Workers 出站 UA 是否被 runtime 覆盖）待部署后 wrangler tail 实测。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `c2d6592` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: Merge upstream v2.0.0 — merge to main & finish

**Date**: 2026-08-02
**Task**: Merge upstream v2.0.0 — merge to main & finish
**Branch**: `main`

### Summary

Merged merge-upstream-v2 into main (reset + force-push to github & gitee). Verified 515 tests green, typecheck x3, build, lint 0 err. Archived 08-01-merge-upstream-v2. End-to-end audio/route-strategy testing still pending (needs real API keys); Postgres/MySQL migrations statically reviewed only.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `766c1c8` | (see git log) |
| `8c72785` | (see git log) |
| `0528d64` | (see git log) |
| `39ed55e` | (see git log) |
| `328156f` | (see git log) |
| `aceb5bf` | (see git log) |
| `84d8ae0` | (see git log) |
| `42d614c` | (see git log) |
| `3424559` | (see git log) |
| `f42eef2` | (see git log) |
| `56ab191` | (see git log) |
| `89df1e1` | (see git log) |
| `4a6e64a` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 3: Deploy v2.0.0 to Cloudflare (production cutover)

**Date**: 2026-08-02
**Task**: Deploy v2.0.0 to Cloudflare (production cutover)
**Branch**: `main`

### Summary

Deployed merged v2.0.0 to Cloudflare Workers production: D1 migrations 0016-0018 applied (audio billing, single provider key, route surfaces/pools), topology invariants verified (0 violations, 6 providers/10 routes/6 pools/6 surfaces), proxy & admin workers deployed (Versions 0d29ea2d/02d5617b, 100%). Pre-migration D1 backup: /tmp/octafuse-backup/production-20260802-094306.sql. VERIFIED the provider-key trap attacked production: 9 ofk1. ciphertext rows across 6 providers were copied verbatim by 0017; owner accepted loss & will re-enter keys. Deleted now-unused PROVIDER_KEY_ENCRYPTION_KEY secret from both workers. Recorded the deployment lesson in spec guide + upstream-sync docs. workers.dev locally DNS-blocked (resolves to Facebook IP) — verify via proxy/VPN/custom domain.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `60a8df1` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 4: Explore free providers & tune CHY routing

**Date**: 2026-08-02
**Task**: Explore free providers & tune CHY routing
**Branch**: `main`

### Summary

Diagnosed ccMesh pulling 0 models: workers.dev is GFW-blocked, must route via Clash proxy (documented in cloudflare-quickstart.md). Evaluated OmniRoute as alternative gateway (37k stars, 290+ providers) but decided against it — too complex for current needs; stopped local daemon. Tried wiring OpenCode Free / Pollinations Free into OctaFuse as keyless providers, but OctaFuse always sends Authorization header (no no-auth egress path) and free tiers are rate-limited/unstable — cleaned up all 14 models/routes/providers from D1. Analyzed CHY provider logs: 529 overload (12x), 429 rate-limit (7x), 40% success/22s avg latency vs ioll.pp.ua 85%/8s — root cause is CHY instability, not egress IP. User set CHY priority=10, ioll.pp.ua=5 for fallback.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `798896a` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
