# 合并 upstream v2.0.0 — 执行记录

分支 `merge-upstream-v2`，基于 `upstream/main` (1551b3e, v2.0.0)。

## 决策（用户确认）

1. **方案A**：放弃 provider key 加密，采纳上游单键明文 `providers.api_key`。
   `provider-key-crypto.*` 及 `GatewayRepositoriesOptions` 全链路移除。
   gateway key hash（`api-key-hash.ts`）与之正交，完整保留。
2. **rebase**（非 merge）到 `upstream/main`。
3. **squash 成 4 个主题 commit** 再 rebase（23 → 4）。
   压缩前用 `git diff --stat` 逐文件比对，确认树与原 `main` 完全一致（无损）。

## 迁移编号

上游 0014-0016 → **0016-0018**；本地已上线的 0014/0015 保持不动。

依据：迁移按**完整文件名**记录在 `schema_migrations`（见 `migrate/postgres.ts:87`）。
我们已执行的编号不变 → 不会重跑；上游那三个从未执行 → 可安全改名。
另核对两个 0015 触及的表互不相交（我们改 `api_keys`；上游改
`providers`/`model_routes`/`models`），无顺序依赖。
文档与 CHANGELOG 中的可执行指令已同步更新（旧编号零残留）。

## 冲突

共 45 处。规律：绝大多数是「上游加 `api_key`/`status`，我们加 `custom_headers`」
的纯增量 → 保留双方。需要真正判断的：

- `model-router.ts` / `failover-dispatch.ts`：上游把 `RouteResult` 从
  「provider + 多 key 池」重构为 target/surface/pool。**整体采用上游基线**再嵌入
  `providerCustomHeaders`，而非逐块拼接（逐块会写出编译不过的代码）。
- **403 修复跨了 commit 分区**（`failover-dispatch.ts` 在 S1，
  `upstream-failure-classifier.ts` 在 S5）。在 S1 一并移植，否则该修复会丢失。
- 部署脚本：**取上游**。上游的无 shell 实现（`spawnNpm` + `process.execPath`）
  严格优于我们的 `shell:true` + `shellQuote`（消除注入面），且已含
  `fetchRemoteMasterKey`，我们那个修复的目的已被完全满足。
- 上游已删除的文件（`provider-api-keys.impl.ts` ×3、`provider-key-limit-config`、
  `model-sticky-config`、`provider-api-keys-service`）：按方案A 删除，并确认无悬空引用。

## 顺带修掉的两个真缺陷

1. `upstreamOperationsForProviderModel` 从 `base` 派生出全部 capability，含
   `responses`。违反设计（`responses` 必须显式声明、绝不从 `base` 推导），会让管理端
   为仅配 `base` 的 provider 列出 `responses`，据此建的路由运行时必然抛错。已修。
2. `use-simulator-page-state.ts:655` 把 surface 值 `next` 传进了 `isAudioModel`
   槽位——签名重排导致的参数错位。已修。

## 排序回归（已修复，commit 1f819ab）

上游 `buildRouteAttemptPlan` 按「priority 硬序 → 层内 strategy 排序」编排，
会覆盖 `responses.ts` 原先建立的全局「直通优先」顺序。

修法比原设计更好：把「直通优先」从**全局重排**降级为**层内偏好**
（`preferWithinTier` → `preferInTier`）。
- admin 配置的 priority 分层被尊重（上游语义）
- 层内 strategy 仍生效，分区稳定（上游语义）
- 直通仍排在翻译之前（我们的语义）
- 原设计记录的代价「全局重排会覆盖 admin 权重顺序」
  （`07-26-responses-translate/design.md:231`）**因此不再存在**

顺带修正 `FailoverDispatchOptions`：三个字段实际都被 `?.` 兜底，改为可选以与实现
一致，从而去掉一处 `as` 强转（该强转会掩盖不完整对象）。

新增 5 条测试。经**变异测试**验证有效：偏好失效 → 2 条失败；
偏好跨层生效（原设计缺陷）→ 精确命中「never lets a preferred route jump a
higher priority tier」。

## 验证

- 511 测试全绿（core 157 / proxy 245 / admin 107 / deploy 2）
- typecheck 三包通过
- lint 0 error；7 warning 全在未触碰的上游文件中（合并前后一致）
- 双向审计：我们 4 项功能存活 + 上游 11 个新文件到位 + 10 个应删文件已彻底移除

## 未做（需要环境或人工）

- **未推送、未合入 main**（rebase 改写了历史，合 main 需 force-push，待确认）
- 迁移 0016→0018 未在真实库执行。**应用 0017 前必须**先跑
  `scripts/db/export-provider-api-keys.mjs` 导出密钥——它每个 provider 只保留一把，
  其余随 `DROP TABLE provider_api_keys` 丢失
- 未做 Codex CLI / 音频 / 路由策略的实机联调
- `npm audit` 6 个漏洞（1 low / 1 moderate / 4 high），来自上游依赖，未处理
