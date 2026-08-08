# 路由策略展示对齐 ID 硬切换（0021）

将持久化与运行时的路由策略 ID 与 Admin 展示名对齐：

| 旧 ID | 新 ID（canonical） |
|-------|---------------------|
| `cache_affinity` | `hash_affinity` |
| `fixed_order` | `weight_priority` |
| `weighted_random` | （不变） |
| `weighted_round_robin` | （不变） |

**无旧 ID 别名**：迁移后的 Core / Proxy / Admin **只接受**新 ID；写入旧 ID → `400`。未迁移的数据在新代码下会被当作非法并回退到默认 `hash_affinity`（或忽略该层覆盖），因此必须在维护窗口内完成「迁移 + 同版本部署」。

迁移文件（三库同步）：

- `packages/core/migrations-d1/0023_route_strategy_display_ids.sql`
- `packages/core/migrations-postgres/0023_route_strategy_display_ids.sql`
- `packages/core/migrations-mysql/0023_route_strategy_display_ids.sql`

改写位置：

1. `system_config.ROUTE_STRATEGY`
2. `route_pools.strategy`
3. `route_pools.tier_strategies`（JSON map 的 **value**）
4. `models.route_policy`（仅 `"strategy":"旧ID"` / `"strategy": "旧ID"`，避免误改 rule key）

不改写：历史审计日志、已发布 CHANGELOG、历史迁移（含 0019）中的示例注释。

---

## 维护窗口步骤（必做）

1. **暂停** Admin 配置写入与 Proxy 业务流量（或进入只读维护）。
2. **应用 0021**（按当前环境选 D1 / Postgres / MySQL 迁移流水线）。
3. **立即部署**同一发布版本的 Core + Proxy + Admin（**禁止**旧新版本混跑）。
4. 用下方校验 SQL 确认旧 ID 计数为 0。
5. 冒烟：Config 全局策略、Routes Pool / 每层策略、保存非法旧 ID 应 400；推理请求层内排序符合预期。
6. **恢复**流量与配置写入。

---

## 校验 SQL（旧 ID 必须为 0）

### D1 / SQLite

```sql
SELECT 'system_config' AS loc, COUNT(*) AS old_ids
FROM system_config
WHERE key = 'ROUTE_STRATEGY'
  AND value IN ('cache_affinity', 'fixed_order')
UNION ALL
SELECT 'route_pools.strategy', COUNT(*)
FROM route_pools
WHERE strategy IN ('cache_affinity', 'fixed_order')
UNION ALL
SELECT 'route_pools.tier_strategies', COUNT(*)
FROM route_pools
WHERE tier_strategies IS NOT NULL
  AND (
    tier_strategies LIKE '%"cache_affinity"%'
    OR tier_strategies LIKE '%"fixed_order"%'
  )
UNION ALL
SELECT 'models.route_policy', COUNT(*)
FROM models
WHERE route_policy IS NOT NULL
  AND (
    route_policy LIKE '%"strategy":"cache_affinity"%'
    OR route_policy LIKE '%"strategy": "cache_affinity"%'
    OR route_policy LIKE '%"strategy":"fixed_order"%'
    OR route_policy LIKE '%"strategy": "fixed_order"%'
  );
```

### Postgres（`search_path` / schema：`octafuse_gateway`）

与上相同，先执行：

```sql
SET search_path TO octafuse_gateway;
```

### MySQL

与 D1 相同；`system_config` 的键列为 `` `key` ``。

---

## 回滚说明

本迁移为数据值改写，**无自动反向迁移**。若必须回滚代码，需先将四表策略值改回旧 ID，再部署旧版本——同样需要维护窗口，且不推荐。优先前滚修复。

策略语义与推荐缺省见 [route-strategies.md](../../developers/reference/route-strategies.md)。
