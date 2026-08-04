# 路由策略（Route Strategies）

同一个 Route Pool 的 `model_routes.priority` 层内，排序策略为可插拔实现。Pool、模型与全局配置共同决定本次请求使用哪一种。

**代码**：`packages/proxy/src/services/route-strategies/` · **路由拓扑**：[route-topology.md](../architecture/route-topology.md) · **生命周期**：[proxy-request-lifecycle.md](../architecture/proxy-request-lifecycle.md) · **升级切换**：[single-provider-key-cutover.md](../../operators/migrations/single-provider-key-cutover.md)

---

## 四种策略

| 名称 | 行为 | 缓存亲和 | 负载均衡 |
|------|------|----------|----------|
| **`affinity`**（默认） | 加权 Rendezvous hash：对 `(affinityKey, providerId)` 稳定打分，再按 `weight` 加权；同分按 `providerId` 升序 | **高**（同用户同模型同协议稳定首选） | 随 weight 倾斜，非均匀随机 |
| **`weighted_random`** | 按 `weight` 无放回加权随机打散 | 低 | **高** |
| **`strict`** | `weight` DESC，再 `providerId` ASC（确定性） | 无随机 | 固定优先高 weight |
| **`round_robin`** | 按 weight 展开序列，进程内计数器轮转后去重 | 无 | 进程内轮转（Workers 多 isolate 各自计数） |

Affinity 分数：`score = max(1, weight) / -ln(u)`，`u` 来自 FNV-1a（`route-affinity-hash.ts`）。

---

## affinityKey / tierKey（协议粒度）

| 键 | 格式 | 用途 |
|----|------|------|
| **affinityKey** | `userId\|baseModelId\|routeGroup\|protocol` | Affinity 打分输入；**不含 capability** |
| **tierKey 前缀** | `baseModelId\|routeGroup\|protocol` | Round-robin 等层内状态 |
| **完整 tierKey** | `{prefix}\|{priority}` | 同一 priority 桶的计数器键 |

`generateContent` 与 `streamGenerateContent` 等不同 capability **共享**同一 affinityKey（协议粒度），避免流式/非流式落到不同首选 provider、破坏上游 cache。

---

## `route_policy` 规则键

`models.route_policy`（TEXT JSON）：

```json
{
  "strategy": "affinity",
  "rules": {
    "openai:default": { "strategy": "affinity" },
    "openai.chat:default": { "strategy": "strict" }
  }
}
```

| 键格式 | 示例 |
|--------|------|
| `{protocol}.{capability}:{route_group}` | `openai.chat:default`、`gemini.generateContent:free` |
| `{protocol}:{route_group}` | `openai:default`、`anthropic:free` |

- 用 `lastIndexOf(':')` 拆分；protocol / capability / route_group 规范化为小写。
- capability 须属于对应协议白名单（`provider-endpoints`：如 openai 的 `chat`、`images.generations`、`audio.transcriptions` 等）。
- `null` / 空串 = 清空，回退全局 `ROUTE_STRATEGY`。
- Admin：`PATCH /admin/models/:id`，字段 `route_policy`；校验见 `normalizeModelRoutePolicyInput`。

---

## 六级解析顺序

`resolveRouteStrategy`：

1. **Route Pool** 的 `route_pools.strategy`
2. **capability × route_group** rule（`route_policy.rules`）
3. **protocol × route_group** rule
4. **model 顶层** `route_policy.strategy`
5. **全局** `system_config.ROUTE_STRATEGY`（进程内缓存 **30s**；非法值回退代码默认）
6. **代码默认** `affinity`（`DEFAULT_ROUTE_STRATEGY`）

写入 Pool：`PATCH /admin/routes/pools/:poolId`，body 为 `{ "strategy": "weighted_random" }`；`null` / 空值表示继承下一级。写入全局：`PUT /admin/config`，`key=ROUTE_STRATEGY`，`value` 为四策略之一。

---

## 按 capability 的推荐缺省

| 场景 | 建议 | 原因 |
|------|------|------|
| Chat / Messages / Gemini 文本 | **`affinity`**（全局默认即可） | 提升 prompt cache 命中 |
| Images / Audio（无强 cache 需求） | 对应 Route Pool 可设 **`weighted_random`** 或保持 affinity | 更均匀分摊上游 |
| 明确主备（同层） | **`strict`** + 不同 `weight` | 确定性优先高 weight |
| 单进程 Node、要轮转 | **`round_robin`** | 注意 CF Workers 多 isolate 不共享计数器 |

跨供应商主备仍优先用 **不同 `priority` 层**（硬序）；同层策略只决定层内顺序。

---

## 如何新增策略

1. 在 `@octafuse/core` 的 `RouteStrategyName` / `ROUTE_STRATEGY_NAMES` 增加名称。
2. 实现 `RouteOrderStrategy`：`(routes, { affinityKey, tierKey }) => RouteResult[]`，放到 `packages/proxy/src/services/route-strategies/<name>.ts`。
3. 注册进 `ROUTE_STRATEGIES`（`route-strategies/index.ts`）。
4. Admin Config 下拉与 `PUT /admin/config` 白名单会随 `ROUTE_STRATEGY_NAMES` 生效。
5. 补单测（确定性 / 权重 / 与 planner + 熔断交互）。
6. 更新本文与 [proxy-request-lifecycle.md](../architecture/proxy-request-lifecycle.md)。
