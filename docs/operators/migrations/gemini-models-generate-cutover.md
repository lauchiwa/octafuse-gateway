# v2.2.0：Gemini `models.generate` 收敛（迁移 0017）

把 Gemini 的 `generateContent` / `streamGenerateContent` 合并为单一具名 operation **`models.generate`**，使一次 Surface / Pool 配置同时服务流式与非流式；并在 Admin 删除 / 迁移 Target 后自动 GC 空 Pool。

**迁移文件**（三库同语义）：

- `packages/core/migrations-d1/0019_gemini_models_generate.sql`
- `packages/core/migrations-postgres/0019_gemini_models_generate.sql`
- `packages/core/migrations-mysql/0019_gemini_models_generate.sql`

**行为说明**：[route-topology.md](../../developers/architecture/route-topology.md) · 规划 [.roadmap/routing-protocol/v2.2.0-gemini-models-generate.md](../../../.roadmap/routing-protocol/v2.2.0-gemini-models-generate.md)

---

## 1. 发布顺序（必读）

**必须先跑迁移 0017，再发布新 Proxy / Admin。**

| 顺序错误 | 后果 |
|----------|------|
| 先发新 Proxy、后迁移 | Proxy 用 `models.generate` 查 Surface，库里只有旧值 → 精确匹配失败，回退到 `*` wildcard（若无则 502） |
| 先迁移、后发代码 | 旧 Proxy 仍按 wire action 查 Surface；迁移后精确行已是 `models.generate`，旧代码会 miss → 同样依赖 `*` 或 502 |

正确流程：

1. 备份数据库。
2. 应用 `0019_gemini_models_generate`（见 §2）。
3. 复核冲突 Pool（见 §3）。
4. 发布含 v2.2.0 代码的 Proxy + Admin。
5. 用流式 / 非流式各打一枪验收（见 §4）。

---

## 2. 应用迁移

按当前部署模式选一（仓库根）：

```bash
# D1 local / remote
npm run db:migrate
npm run db:migrate:remote

# Postgres
npm run db:migrate:pg

# MySQL
npm run db:migrate:mysql
```

迁移会：

1. 同组两个 legacy Surface 指向**不同** Pool 时：保留 `generateContent` 的 Pool；删除 `streamGenerateContent` Surface；将其 Pool 置 `inactive` 并加名字前缀 `[v220-conflict] `（Target 保留）。
2. 同组同 Pool：删除冗余的 `streamGenerateContent` Surface。
3. 将其余 `generateContent` / `streamGenerateContent` Surface 改名为 `models.generate`。
4. 将 `model_routes.upstream_operation` 的 gemini 旧值改为 `models.generate`（`*` 不动）。
5. 改写自动生成的 Pool 名 `gemini.<legacy> · <group>` → `gemini.models.generate · <group>`。
6. **不改** `*` wildcard Surface；**不改** Provider JSON（读侧继续认旧键）。

---

## 3. 冲突 Pool 复核

```sql
-- Postgres / MySQL / D1（按需调整）
SELECT id, model_id, route_group, name, status
FROM route_pools
WHERE name LIKE '[v220-conflict]%'
ORDER BY model_id, route_group;
```

对每条冲突：

- Target 仍在，可手动改挂到保留的 `models.generate` Pool，或确认无流量后删除 Target。
- 确认后可删除 inactive 冲突 Pool（其 Surface 已在迁移时移除）。

---

## 4. 验收

- 新建 gemini 路由只需选一次 `models.generate`；流式与非流式命中同一 Surface / Pool。
- 上游：非流式 `…:generateContent`，流式 `…:streamGenerateContent`（含 `alt=sse`）。
- 请求日志：`request_operation` / `upstream_operation` 为 `models.generate`；`route_trace.gemini.action` 为真实 wire action。
- `countTokens` 等未开放 action 仍被 Proxy 拒绝。
- 删除 Pool 内最后一个 Target 后，该 Pool / Surface 不再残留。
- Provider 表单：单一 `{model}:{action}` 覆盖；无法合并的旧双键显示告警并原样保存。

---

## 5. 行为变更说明

### 5.1 空 Pool GC 与 `*` 回退

升级前：精确 Surface 指向**空** Pool → 502 `noRoute`（即使存在 `*` Surface）。  
升级后：空 Pool 被 GC 删除后，请求可回落到同组 `*` wildcard Surface（若存在）。

### 5.2 Route policy

历史键 `gemini.generateContent:default` / `gemini.streamGenerateContent:default` 读侧别名到 `gemini.models.generate:default`。  
若两键同时存在且策略不同，优先 `generateContent`（其次 `streamGenerateContent`）。新写入只产出家族键。

### 5.3 Provider endpoints

写侧可继续提交旧键；新 UI 优先写 `endpoints['models.generate']`（须含 `{model}` 与 `{action}`）。运行时回落：`models.generate` 模板 → 旧 per-action 模板 → `base` 派生。

---

## 6. 回滚

SQL 迁移不提供自动 down。若必须回滚代码：

1. 停新 Proxy，临时保留已迁移库时，旧 Proxy 只能依赖仍存在的 `*` Surface，或手工把 `models.generate` Surface 再拆回两个 legacy 行（不推荐）。
2. 更好做法：从迁移前备份恢复数据库，再部署旧版本二进制。

冲突 Pool 的 Target 未被删除，可在 Admin 中继续调整。
