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


## Session 5: Fix provider custom_headers lost after PATCH

**Date**: 2026-08-02
**Task**: Fix provider custom_headers lost after PATCH
**Branch**: `main`

### Summary

User reported custom upstream headers disappearing after saving in provider edit modal. Root cause: upstream merge refactored updateProviderService from '{ ...body }' to explicit per-field patch building but left the 'customHeaders in patch' check checking patch (which never contains that key) instead of body — so custom_headers was silently never written, and the new empty-patch early-return made header-only edits a no-op. Existing rows from pre-merge (百倍/林夕/无名) survived; post-merge saves (CHY/pipi/君の公益) had been clobbered to null. Fixed check to 'customHeaders in body' + moved ahead of empty-patch return. Added 5 regression tests (mutation-verified: 4 fail on revert). Deployed admin worker (Version 7e53020c, 100%); user verified headers persist across refresh.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `46edbad` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete

---

## 2026-08-05 — Merge upstream v2.1.1

### What

Upgraded the fork from the v2.0.0 baseline to the official **v2.1.1** tag (23 upstream commits, 166 files, 19 conflicts). Deliberately excluded the 6 unreleased commits sitting on `upstream/main` after the tag. Also set up `api.qiwa.dpdns.org` / `admin.qiwa.dpdns.org` Custom Domains earlier in the session.

Adopted from upstream: `@octafuse/tool-engines`, `/v1/tools/ai-detection`, `/v1/tools/pricing`, stable gateway error codes + `X-OctaFuse-Error-Code`, consolidated user+model circuit breaker, `401/403` cooldown 10min→5min, provider-delete guard, Qwen presets.

Preserved from the fork: provider `custom_headers` (PATCH + egress), `sk-` key hashing, admin HMAC sessions, `/v1/responses`, tier-local route preference, Cloudflare deploy config.

### Three defects no conflict marker pointed at

1. **`/v1/responses` left behind by an upstream deletion.** Upstream replaced `sensitive-content-circuit-route` and migrated its own chat/messages/gemini routes. The fork-only route kept the dead import (typecheck caught it) *and* lacked the `markUserModelSuccess()` call upstream added on the success path (nothing caught it — the backoff ladder would never reset after a success). Fixing only the import would have looked completely green.
2. **A guard that could not fail.** Mutating the `kind`/`protocol` conditions out of `resolvesToResponsesSurface` turned no test red — both call sites already narrow first, so those conditions were unreachable. Simplified it and pinned the real call-site protection.
3. **Conflict-free docs reverted fork facts.** Three files auto-merged with no conflict and reintroduced upstream's `0015`/`0016` migration filenames plus a stale `2.0.0` claim. Migration identity is the full filename, so those would send an operator at files this fork does not ship.

Also caught three call sites passing `openaiSurface` into upstream's new `toolId` parameter slot — both string-shaped, so it type-checked silently.

### Git Commits

| Hash | Message |
|------|---------|
| `c8346b1` | Merge upstream v2.1.1 into fork |
| `658b32f` | test(admin): pin the v2.1.1 merge seam for the OpenAI Responses surface |
| `810878a` | docs: correct migration names and version baseline |
| `492137e` | docs(spec): record v2.1.1 upstream merge lessons |

Rollback tag `pre-v2.1.1-merge` → `58f5fd6`, pushed to both remotes.

### Testing

- [OK] 543 unit tests pass (pre-merge baseline 514)
- [OK] admin + proxy typecheck clean; admin lint 0 errors
- [OK] core/proxy/admin builds; `verify:proxy-bundle`; `verify:package-versions` (all 2.1.1)
- [OK] i18n en/zh/ja/ko structurally identical (1396 keys each)
- [OK] mutation proofs: custom_headers PATCH (2 mutations), merge seam (3 mutations)
- [OK] production D1 reports "No migrations to apply" — still `0018`, v2.1.1 adds none

### Status

[OK] **Merged and pushed** — production deployment deliberately NOT done.

### Next Steps

- Deploy v2.1.1 to production as a separate reviewed step. On deploy, regression-check CHY → ioll.pp.ua failover, the new 5min `401/403` cooldown, and error-code responses.
- `npm audit`: 13 upstream dependency vulns (10 high). Unrelated to this merge; handle separately.

---

## 2026-08-05 — 依赖漏洞分诊（v2.1.1 合并后）

### 结论

`npm audit` 报 13 项（10 high / 1 moderate / 2 low）。**按部署形态分诊，而不是按严重度标签升级**。修掉真正适用的 4 个，明确拒绝 3 个。

### 大部分 high 级 Next.js CVE 不适用

前置条件本项目都不满足：

| 前置条件 | 本项目 | 排除的 CVE 族 |
|---|---|---|
| `middleware.ts` | 无 | Middleware / Proxy bypass 全族（7+ 条） |
| `next/image` | 0 处引用 | Image Optimization DoS |
| `'use server'` | 0 处引用 | Server Actions DoS / SSRF |

### 真正适用、已修

- **hono 4.12.12 → 4.13.0**：我们挂了 `hono/cors`，所以 CORS ReDoS（`Access-Control-Request-Headers`，`<4.12.34`）适用。
  - 但"wildcard origin + credentials 反射"那条**不适用**：`origin` 是显式 `'*'`，且从未开启 `credentials`。
  - `jsx` / `jwt` / `cache` / `bodyLimit` / `ip-restriction` / `serve-static` / `cookie` 全部未使用 → 对应条目均不适用（这些占了 hono 报告里的多数）。
- **next 16.2.3 → 16.3.0**，**postcss 8.5.9 → 8.5.23**（sourceMappingURL 路径穿越），**wrangler 4.107 → 4.118**（顺带清掉数个传递 high）。
- 顺手对齐了 root/proxy/admin 三处的 `hono` 与 `wrangler` range，避免再次漂移。

### 明确拒绝（重要：不要跑 `npm audit fix`）

- **`@opennextjs/cloudflare`**：audit 建议 `1.8.4`，这是从精确 pin `1.19.4` **降级**。该 pin 是为 Workers 上的 middleware-manifest 修复（opennextjs-cloudflare#1232），记录在 `.trellis/spec/architecture.md`。照建议做会让 Admin 重新 500。
- **`@hono/node-server` 2.1.0**（major）：CVE 是 `serve-static` 在 Windows 上的路径穿越。生产是 Workers；node-server 仅用于 Node/Docker 自托管路径；且 `serve-static` 未使用。
- **`esbuild` 0.28.1**（major）：仅影响 Windows 上的 dev server 文件读取；我们只把 esbuild 当打包器。

### 剩余项

全是构建/开发链传递依赖（wrangler、miniflare、undici、esbuild、@babel/core、js-yaml、brace-expansion、form-data），**不进入任何部署产物**。

### Git Commits

| Hash | Message |
|------|---------|
| `7e11f79` | chore(deps): patch applicable CVEs in hono, next, postcss, wrangler |

### Testing

- [OK] 543 单测通过；proxy + admin typecheck 干净；admin lint 0 error
- [OK] core / proxy 构建 + `verify:proxy-bundle` 通过
- [OK] **admin OpenNext 构建在 Next 16.3.0 下成功**（次版本跳跃的主要风险点）
- [OK] `verify:package-versions` 全部 2.1.1

### Status

[OK] **已提交并推送**（`7e11f79`，github + gitee 一致）

### Next Steps

- 生产仍在 v2.0.0。部署 v2.1.1 待你确认——需要先决定 agentrouter 的 `400 content-blocked` 是否接受新的 user+model 熔断（20s 起，跨窗口升到 10min；405/WAF 不受影响，已实测）。

---

## 2026-08-05 — 生产部署 v2.1.1

### 部署

| Worker | 部署前 | 部署后 |
|---|---|---|
| proxy | `e178a59d` | **`8b8178ca`** |
| admin | `59664f05` | **`548509e5`** |

无迁移（部署前后 `migrations list` 均为 "No migrations to apply"，生产维持 `0018`）。

部署前备份：`~/Backups/octafuse/d1-prod-20260805-154808.sql.gz`（17M 原始 / 986K 压缩，12 表，尾部完整未截断，sha256 前缀 `87ef14c1f29a`）。回滚 tag `pre-v2.1.1-merge` → `58f5fd6`。

### v2.1.1 生效判定

用错误码头做标记（部署前 absent → 部署后 present）：

```
x-octafuse-error-code: gateway.auth_failed
body: {"error":"Invalid API key","code":"gateway.auth_failed"}
```

`error` 字段仍在 → 纯增量，客户端不破。

### 部署后验证

- 四入口全 200：api.qiwa / admin.qiwa（直连免代理）、两个 workers.dev（代理）
- `GET /v1/models` → 13 个模型
- **`GET /v1/tools/pricing`（v2.1.1 新端点）→ 200**，返回 metered/standard/charged 三账本
- OpenAI `chat/completions` → `V211-OK`（deepseek-v4-flash，计费落库 charged=0.00013）
- Anthropic `/v1/messages` → `ANTHRO-OK`（claude-opus-5，走 custom UA 路径）
- 请求日志路由拓扑字段齐全：surface / pool / target 均非空，`adapter=passthrough`
- 部署后请求状态分布：3/3 success，**无新错误类别**

### 关键结论：新的 400 熔断在真实流量下不会升级

部署前的顾虑是"普通 400 会触发 user+model 熔断"。查了近一周 22 次 400：

- 6 次 `content-blocked` → **旧版也熔断**，无变化
- 16 次 `client_error` → v2.1.1 新增熔断行为

**同一 user+model 的连续 400 最小间隔 34 秒，全部 ≥ 20 秒首档窗口** → 阶梯永不升级，且期间任何成功都清零。实际影响：约 16 次/周的 20 秒短路，不累积。且属保护性（阻止畸形请求继续打上游）。

因此按上游默认部署，未做本地偏离。

### 顺带发现：2 个 provider 仍是 ofk1. 密文

与"已全部重配"不符，但**都不可调度**，不阻塞：

| provider | prov status | route status | 结论 |
|---|---|---|---|
| pipi公益站 | active | **inactive** | 路由停用，不承接流量 |
| 君の公益 | **disabled** | active | provider 停用，不承接流量 |

两者所属模型（`claude-opus-5` / `gpt-5.6-sol`）均有健康可调度路由（claude-opus-5 有 7 条 DISPATCHABLE）。要么补配真 key，要么直接删掉这两行。

### failover 频次是既有特征，非本次引入

部署前基线：claude-opus-5 平均 1.57 次尝试、deepseek-v4-flash 1.44、glm-5.2 1.67。部署后 3 个样本量太小，不足以判断趋势，需持续观察。

### Status

[OK] **v2.1.1 已上线并验证**

### Next Steps

- 观察 24-48h：failover 率、`circuit.client_error` 出现频次、是否有新错误类别
- 清理 2 个 ofk1. 密文 provider（补真 key 或删行）
- **轮换 gateway API key** —— `sk-P13si…` 在会话中多次明文出现

---

## 2026-08-05 — 部署：移除翻译层 + 修复 1102 内存超限

### 部署

| Worker | 前 | 后 |
|---|---|---|
| proxy | `8b8178ca` | **`2edf53ea`** |
| admin | `548509e5` | **`045a47df`** |

含两个提交：`9d3d9d6`（移除 Responses→Chat 翻译，改为同协议进出）、`362514c`（日志 body 脱敏提出后台闭包）。无迁移。

### Error 1102 根因（内存，非 CPU）

用户报 `Error 1102: Worker exceeded resource limits`，时间 `17:18:23Z`。

**日志缺口即证据**：17:17–17:22 在 `api_key_request_logs` 里完全没有记录——isolate 被终止，`scheduleBackgroundWork` 来不及写日志。崩溃前输入 token 从 237K 爬到 416K，17:14 单分钟 7 个并发。

**根因**：`*UpstreamWireBodyForLog(chosenRoute, body)` 写在 `scheduleBackgroundWork` 闭包内，闭包因此捕获整个已解析 body（41 万 token ≈ 1.6MB JSON，V8 对象图远大于此），并存活到 usage settle 或 `USAGE_SAFETY_TIMEOUT_MS`（5 分钟）到期。Worker 内存是**每 isolate、并发共享**的 128MB，几个这种请求重叠就撞穿。

而该值上限仅 16KB（`MAX_REQUEST_LOG_JSON`），生产实测峰值约 600 字符（脱敏丢弃 `messages`/`system` 只留计数）。

**修复**：四条流式路由都把计算提到调度之前，闭包只捕获短字符串。纯计算，提前/延后求值等价（`buildRouteRequestBody` 不改原 body，dispatch 后 `body` 无改动）。

**排除的方向**：图像/音频缓冲上限 5×20MB=100MB —— 但近两周零图像零音频请求；SSE `lineBuffer` 处理正确；`deepMergeDefaults` 数组按引用返回不深拷；CPU 不成立（代理主要在 await fetch，等待 I/O 不计 CPU）。

### 移除翻译层（-3119 行）

`/v1/responses` 改回能力门禁：未显式声明 `endpoints.openai.endpoints.responses` 的 provider 被过滤，全无则 502 并列出待配置名单。

理由：翻译必然丢弃 `reasoning`（`encrypted_content` 只对产出它的上游有意义）与 `prompt_cache_key`，且**不报错**，表现为「模型变笨 + 缓存全 miss」；更糟的是会掩盖 endpoint URL 配错——今天无名那个 `/v1` 缺 `/responses` 的笔误正是如此。

删除前确认：近一周 523 次 Responses 请求全部落在 4 个已声明的渠道上，无一次走翻译路径。

### 部署后验证

- 四入口全 200；`x-octafuse-error-code` 未回归
- chat → `HOIST-OK`；messages → `HOIST-ANTHRO`
- **真实用户流量**（含 131K token 请求）`request_body` / `upstream_request_body` 双列正常落库，计费完整
- 门禁双向验证：`gpt-5.6-sol` → 405（千刀 nginx，上游问题，说明门禁放行了已声明渠道）；`deepseek-v4-flash` → 502 并列出 6 个待配置 provider

### Status

[OK] **已部署并验证**

### Next Steps

- 观察 1102 是否复现（关注 `api_key_request_logs` 是否再出现分钟级缺口）
- 待定：缩短 `USAGE_SAFETY_TIMEOUT_MS`（5min→90s）、加请求体大小上限返回 413（故障隔离）
- 千刀 405 是其 nginx 拒绝 POST，网关无解；建议停用该路由或联系对方
