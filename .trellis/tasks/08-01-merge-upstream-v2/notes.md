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

## 排序回归（已修复，commit aceb5bf）

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

## 合并后安全审查（追加）

在分支推送之后做了一轮专门的审查（提示词投毒 / 逻辑 / 安全），结论：

- **提示词投毒：无。** 读过的上游代码、4 份 CHANGELOG、运维文档、minified wrangler bundle
  中都没有试图操纵行为的注入内容；全程按数据处理。
- **安全：无新增，且有一处提升。** 采纳上游部署脚本移除了本地方案的 `shell: true` +
  `shellQuote`，改为 `process.execPath` 直调，消除命令注入面。gateway key hash 与 admin
  HMAC 校验均完好。
- **逻辑：发现 1 个严重数据缺陷（见下）。**

### 缺陷 A：加密的 provider key 会在 0017 之后变成不可用乱码

因果链（逐步验证过）：旧代码**强制**加密写入（未配 secret 直接抛错），所以库中存的是
`ofk1.` 密文 → 迁移 0017 用纯 SQL 把 `provider_api_keys.api_key` 原样复制到
`providers.api_key`，不解密 → 方案A 已删除全部解密能力（grep 确认零调用）→ 新代码
`Authorization: Bearer ${route.providerApiKey}` 直接发出密文 → 全部 provider 401，
且 `DROP TABLE` 后明文不可恢复。

**511 测试全绿也发现不了**：所有 fixture 都用明文。这是「代码兼容 ≠ 数据兼容」的典型。

**上游给的退路是假的**：`scripts/db/export-provider-api-keys.mjs` 走裸 SQL
`SELECT api_key FROM provider_api_keys`，导出的同样是密文——看起来备份成功，实则无法还原。

处置：owner 确认 provider 数据可弃（从中转站重新配置）。实证核查本地 D1 库 3 行 key
**全是明文**（`sk-` 前缀），`ofk1.` 密文 0 行，该功能从未对此库生效，陷阱未触发。
已把陷阱与检测 SQL 写入 `docs/developers/upstream-sync.md`。

## 迁移验证（已完成）

本地 D1 库原本正好停在 0015，是一个带真实已应用状态的库。备份后用真实工具链
（`npm run db:migrate`）应用 0016→0018，全部成功，并逐项核对数据而非只看退出码：

- `d1_migrations` 记录到 0018；`providers.api_key` 3 把 key 全部搬运成功（长度与迁移前一致）
- 无 provider 因搬运失败被 disabled；`provider_api_keys` 已 DROP；`sticky_config` 已移除
- 0018 路由拓扑回填的 4 个不变量全部归零：无 route 缺 pool、无孤儿 pool 引用、
  无 pool 缺 surface 兜底、无 surface 指向不存在的 pool
- `PRAGMA integrity_check` = ok，`foreign_key_check` 无违规
- drizzle schema 声明与实际库**零漂移**（逐表逐列比对）

Postgres / MySQL 无法本地执行（无 psql、docker 未运行），改做静态对等审查：0016 语义等价
（MySQL `DOUBLE` 为方言差异）、0017 三驱动取键逻辑一致、0018 自然键唯一约束三驱动都在。

### 缺陷 B：ETL 表清单与 0018 后的 schema 脱节

`scripts/db/lib/migration-tables.ts` 仍列着已被 DROP 的 `provider_api_keys`，且漏了 0018
新增的 `route_pools` / `model_surfaces`。后果：D1→Postgres 迁库脚本会 `SELECT * FROM
provider_api_keys` 报错中断，而且即使跳过也会**静默丢失整个路由拓扑**，同时
`model_routes.route_pool_id` 指向未被复制的 pool 造成 FK 违规。

修复：移除已删表，把两张新表插在 `models` 之后、`model_routes` 之前（外键顺序要求：
`route_pools`→`models`，`model_surfaces`→`models`+`route_pools`，
`model_routes.route_pool_id`→`route_pools`）。用真实库的外键图做了拓扑校验，0 违规。

并补了 4 条**契约测试**（`scripts/db/lib/migration-tables.test.ts`），以迁移文件为真相来源
（CREATE 减 DROP）自动检测漂移，让同类缺陷无法再悄悄发生。经 4 次变异验证各自精确命中、
无交叉误报。新增 `npm run test:db` 并接入 `test:unit`（511 → 515）。

### 边界情况：跨驱动 pool id 派生不同

D1 用 `hex(...)`、Postgres 用 `md5(...)` 派生 legacy pool id，同一逻辑 pool 在两库 id 不同。
ETL 原样复制 id 且 `ON CONFLICT` 目标是 `(id)`，所以已跑过 0018 且 `model_routes` 非空的
PG 库若不带 `--truncate` 灌入，`model_surfaces` 会撞自然键约束报 unique violation。
确认这是**显式失败而非静默双份数据**，属安全的失败模式。已在
`docs/operators/migrations/d1-postgres-cutover.md` 写明「0018 之后首次 ETL 必须 `--truncate`」
——原文档称增量 ETL「幂等（可重复执行）」，对新表已不成立。

## 沉淀的可复用知识

- `.trellis/spec/core/backend/database-guidelines.md` —— 迁移身份契约：按**完整文件名**记录，
  不是 `NNNN` 前缀。重命名已应用的迁移会重跑，重命名未应用的才安全。原本只验证了
  Postgres/MySQL 的 runner，后发现 D1 走 wrangler 自己的 `d1_migrations` 表，不能外推，
  于是直接查本地 D1 库确认 `name TEXT UNIQUE` 同样存全名，才把断言写成覆盖三驱动。
- `.trellis/spec/guides/upstream-merge-thinking-guide.md` —— 7 步合并检查，每条都来自本次真实
  缺陷。核心是 Step 5「检查已落盘的数据」（缺陷 A 的教训）。
- `docs/developers/upstream-sync.md` —— 修掉一处**危险的过期指引**：原文让未来的合并者
  「保留我们的 provider key 加密」，照做会去恢复已删除的文件。

## 未做（需要环境或人工）

- **未合入 main**（rebase 改写了历史，合 main 需 force-push，待确认）。分支已推送到
  github 与 gitee，三方一致。
- 迁移 0016→0018 已在**本地 D1** 验证；Postgres / MySQL 仅静态审查，未实际执行。
- 未做 Codex CLI / 音频 / 路由策略的实机联调。
- provider 数据按 owner 决定弃用重配，不再需要导出脚本（且该脚本对密文无效）。
- `npm audit` 6 个漏洞（1 low / 1 moderate / 4 high），来自上游依赖，未处理。建议与本次合并
  分开处理。
