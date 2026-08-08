# 路由策略（Route Strategies）

同一个 Route Pool 的 `model_routes.priority` 层内，排序策略为可插拔实现。Pool、模型与全局配置共同决定本次请求使用哪一种。

**代码**：`packages/proxy/src/services/route-strategies/` · **路由拓扑**：[route-topology.md](../architecture/route-topology.md) · **生命周期**：[proxy-request-lifecycle.md](../architecture/proxy-request-lifecycle.md) · **策略 ID 硬切换**：[route-strategy-canonical-ids-cutover.md](../../operators/migrations/route-strategy-canonical-ids-cutover.md)

---

## 四种策略

| 名称 | 行为 | 缓存亲和 | 负载均衡 |
|------|------|----------|----------|
| **`hash_affinity`**（默认） | 加权 Rendezvous hash：对 `(affinityKey, providerId)` 稳定打分，再按 `weight` 加权；同分按 `providerId` 升序 | **高**（同用户同模型同协议稳定首选） | 随 weight 倾斜，非均匀随机 |
| **`weighted_random`** | 按 `weight` 无放回加权随机打散 | 低 | **高** |
| **`weight_priority`** | `weight` DESC，再 `providerId` ASC（确定性） | 无随机 | 固定优先高 weight |
| **`weighted_round_robin`** | 按 weight 展开序列，进程内计数器轮转后去重 | 无 | 进程内轮转（Workers 多 isolate 各自计数） |

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
  "strategy": "hash_affinity",
  "rules": {
    "openai:default": { "strategy": "hash_affinity" },
    "openai.chat:default": { "strategy": "weight_priority" }
  }
}
```

| 键格式 | 示例 |
|--------|------|
| `{protocol}.{capability}:{route_group}` | `openai.chat:default`、`gemini.models.generate:free` |
| `{protocol}:{route_group}` | `openai:default`、`anthropic:free` |

- 用 `lastIndexOf(':')` 拆分；protocol / capability / route_group 规范化为小写。
- capability 须属于对应协议白名单（`provider-endpoints`：如 openai 的 `chat`、`images.generations`、`audio.transcriptions` 等）。
- Gemini 历史键 `gemini.generateContent:*` / `gemini.streamGenerateContent:*` 读取时会归一为 `gemini.models.generate:*`；Admin 新写入只保存 canonical 家族键。
- `null` / 空串 = 清空，回退全局 `ROUTE_STRATEGY`。
- Admin：`PATCH /admin/models/:id`，字段 `route_policy`；校验见 `normalizeModelRoutePolicyInput`。

---

## 解析顺序

每次请求先解析 **base**（Pool / 模型 / 全局），再按 priority 层套用 **tier override**。

`resolveRouteStrategyPlan`（Proxy）：

0. **`route_pools.tier_strategies[priority]`**（若该层有覆盖）→ 仅影响该 priority 层内排序
1. **Route Pool** 的 `route_pools.strategy`（base）
2. **capability × route_group** rule（`route_policy.rules`）
3. **protocol × route_group** rule
4. **model 顶层** `route_policy.strategy`
5. **全局** `system_config.ROUTE_STRATEGY`（进程内缓存 **30s**；非法值回退代码默认）
6. **代码默认** `hash_affinity`（`DEFAULT_ROUTE_STRATEGY`）

`tier_strategies` 列存 JSON map，例如 `{ "10": "hash_affinity", "0": "weight_priority" }`。未配置的层使用 base。

写入 Pool：`PATCH /admin/routes/pools/:poolId`，body 可为：

```json
{
  "strategy": "weighted_random",
  "tier_strategies": { "10": "hash_affinity", "0": "weight_priority" }
}
```

- `strategy`：`null` / 空值表示继承下一级（模型 / 全局）。
- `tier_strategies`：`null` / 空对象清空列；非法 priority key 或策略名 → `400`。
- 两个字段均可选；至少提供其一。

写入全局：`PUT /admin/config`，`key=ROUTE_STRATEGY`，`value` 为四策略之一。

---

## 按 capability 的推荐缺省

| 场景 | 建议 | 原因 |
|------|------|------|
| Chat / Messages / Gemini 文本 | **`hash_affinity`**（全局默认即可） | 提升 prompt cache 命中 |
| Images / Audio（无强 cache 需求） | 对应 Route Pool 可设 **`weighted_random`** 或保持 hash_affinity | 更均匀分摊上游 |
| 明确主备（同层） | **`weight_priority`** + 不同 `weight` | 确定性优先高 weight |
| 单进程 Node、要轮转 | **`weighted_round_robin`** | 注意 CF Workers 多 isolate 不共享计数器 |

跨供应商主备仍优先用 **不同 `priority` 层**（硬序）；同层策略只决定层内顺序。

---

## Provider sticky routing（Pool 前置规则，非第五策略）

Route Pool 可另开 **Provider 粘性**（`sticky_enabled` + `sticky_idle_ttl_seconds`），与上述四种层内策略正交：

1. 无有效绑定时：仍按 **Priority → 层内策略 → Failover** 选路；成功后写入共享表 `route_pool_sticky_bindings`。
2. 有有效绑定时：将该 Target **跨 Tier 插到尝试序列最前**；成功则滑动续期（默认空闲 1h，60s 内 touch 合并）。
3. Provider 可归因故障（429 / 5xx / 401–403 / 524 / 网络）→ CAS 解绑并继续常规计划；400/404 / 图片 abort **不解绑**。
4. 粘到低优先级 Tier 后**不主动探测**高层；仅故障、配置变更（`sticky_epoch++`）或空闲过期后重选。
5. Lookup 细分：`invalid_circuit`（熔断中）保留旧绑定且不重绑；`invalid_target`（目标不在候选）用 `expectedToken` CAS 覆盖；`invalid_epoch` 由既有 expiry/epoch CAS 覆盖。
6. `route_trace.sticky` 在 bind/touch CAS settle 后写入，便于观察 `unchanged` / `storage_error`。过期行由机会式 GC（~1/500 请求）清理。

Admin：Routes Flow 中 Route Group 节点下方 Chip → 配置弹窗。运维迁移见 [route-pool-sticky-routing-cutover.md](../../operators/migrations/route-pool-sticky-routing-cutover.md)。

与 **`hash_affinity`** 的区别：后者是无状态哈希「稳定首选」；sticky 是跨请求成功记忆 + 可跨 Tier。

---

## 如何新增策略

1. 在 `@octafuse/core` 的 `RouteStrategyName` / `ROUTE_STRATEGY_NAMES` 增加名称。
2. 实现 `RouteOrderStrategy`：`(routes, { affinityKey, tierKey }) => RouteResult[]`，放到 `packages/proxy/src/services/route-strategies/<name>.ts`。
3. 注册进 `ROUTE_STRATEGIES`（`route-strategies/index.ts`）。
4. Admin Config 下拉与 `PUT /admin/config` 白名单会随 `ROUTE_STRATEGY_NAMES` 生效。
5. 补单测（确定性 / 权重 / 与 planner + 熔断交互）。
6. 更新本文与 [proxy-request-lifecycle.md](../architecture/proxy-request-lifecycle.md)。
