# 单键 Provider + 路由策略切换（迁移 0017）

将 `provider_api_keys` 折叠为 **一个 Provider 一把 `api_key`**，并引入可切换路由策略（`ROUTE_STRATEGY` / `models.route_policy` / `model_routes.weight`）。

**迁移文件**（三库同语义）：

- `packages/core/migrations-d1/0017_single_provider_key.sql`
- `packages/core/migrations-postgres/0017_single_provider_key.sql`
- `packages/core/migrations-mysql/0017_single_provider_key.sql`

**行为说明**：[route-strategies.md](../../developers/reference/route-strategies.md) · [proxy-request-lifecycle.md](../../developers/architecture/proxy-request-lifecycle.md)

---

## 1. 迁移前：导出密钥

迁移对每个 provider **只保留一把 active key**（`priority DESC, created_at ASC` 取第一条）。其余 key 会随 `DROP TABLE provider_api_keys` 丢失。

在仓库根、**仍有 `provider_api_keys` 表**时导出：

```bash
DATABASE_URL='postgres://...' node scripts/db/export-provider-api-keys.mjs > provider-api-keys-backup.json
# MySQL：
# DATABASE_DRIVER=mysql DATABASE_URL='mysql://...' node scripts/db/export-provider-api-keys.mjs > provider-api-keys-backup.json
```

输出 JSON 含 `kept` / `discarded` / `all_keys`。妥善保管（含明文 `api_key`）。

> D1：脚本当前面向 Postgres/MySQL。D1 请在迁移前用 `wrangler d1 execute` / SQL 导出 `provider_api_keys`，或先 ETL 到 PG 再导出。

---

## 2. 应用迁移 0017

按当前部署模式选一：

| 库 | 命令（仓库根） |
|----|----------------|
| D1 本地 | `npm run db:migrate` |
| D1 远程 | `npm run db:migrate:remote` |
| Postgres | `npm run db:migrate:pg` |
| MySQL | `npm run db:migrate:mysql` |

迁移会：

1. `providers` 增加 `api_key`、`status`；从首把 active key 回填；无 key 则 `status=disabled`
2. `model_routes` 增加 `weight`（默认 1）
3. `DROP` `provider_api_keys`
4. 删除 `models.sticky_config`，增加 `models.route_policy`
5. `INSERT OR IGNORE` / 等价写入 `system_config.ROUTE_STRATEGY = 'affinity'`

然后部署含本重构的 Proxy / Admin 版本（Admin 不再提供 `/admin/providers/:id/keys*`）。

---

## 3. 重建被丢弃的密钥

`discarded` 中的密钥需建成**新的 Provider** + 对应 **model_routes**（同一模型、合适的 `priority` / `weight` / `route_group`）。

示例（Admin API，路径对外为 `/api/admin/...`）：

```bash
# 1) 新建 Provider（复制原 endpoints + 丢弃的 api_key）
curl -X POST "$GATEWAY_MASTER_URL/api/admin/providers" \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"vendor-b","api_key":"...","status":"active","endpoints":{...}}'

# 2) 为模型挂路由（priority 分层；同层用 weight）
curl -X POST "$GATEWAY_MASTER_URL/api/admin/routes" \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model_id":"glm-4","provider_id":"<new-id>","provider_model_name":"...","priority":10,"weight":1,"route_group":"default","upstream_protocol":"openai"}'
```

同供应商多账号场景：每个账号一个 Provider 行，而不是同一 Provider 下多 key。

---

## 4. 确认全局策略

```bash
curl -X PUT "$GATEWAY_MASTER_URL/api/admin/config" \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key":"ROUTE_STRATEGY","value":"affinity"}'
```

需要 per-model / per-capability 覆盖时：`PATCH /api/admin/models/:id`，body 含 `route_policy` JSON（见 [route-strategies.md](../../developers/reference/route-strategies.md)）。

---

## 5. 验证清单

- [ ] `GET /api/admin/providers`：列表含脱敏 `api_key`、`status`；**无** `/keys` 子资源
- [ ] `GET /api/admin/providers/:id/api-key`：可揭示明文（鉴权 MASTER_KEY）
- [ ] `GET /api/admin/routes`：行含 `weight`
- [ ] `GET /api/admin/config`：存在 `ROUTE_STRATEGY=affinity`（或你设定的值）
- [ ] Proxy：`POST /v1/chat/completions` 成功；Request Logs 中 `provider_key_id` ≈ provider id，`provider_key_label` ≈ provider name
- [ ] 故意打挂主 provider（或置 `status=disabled`）后，同层/下层路由 failover 仍可用
- [ ] 旧 sticky / limit_config UI/API 已不存在；勿再依赖 `provider_api_keys` 表

回滚：需从备份恢复库 + 部署旧版本；0015 为破坏性 schema 变更，无自动 down 脚本。
