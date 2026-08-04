# 路由拓扑：Request Surface → Route Pool → Upstream Target

Octafuse Gateway 2.0 在原有 `models` / `model_routes` 之上增加显式路由拓扑，把“客户端如何进入模型”和“请求最终发往哪个上游”拆开表示：

```text
model + route_group + request protocol + operation
                    │
                    ▼
             Request Surface
                    │
                    ▼
               Route Pool
                    │
                    ├── Upstream Target A
                    ├── Upstream Target B
                    └── Upstream Target C
```

这一结构由迁移 `0016_route_surfaces_pools.sql` 引入。旧路由会自动转换为兼容的 wildcard Surface 和 Route Pool，不要求升级时手工重建。

## 三层对象

| 层 | 数据对象 | 作用 |
|----|----------|------|
| Request Surface | `model_surfaces` | 以 `model_id + route_group + request_protocol + request_operation` 表示一个公开请求入口，并指向一个 Route Pool。 |
| Route Pool | `route_pools` | 聚合一组可互相故障转移的 Upstream Target，并可设置 Pool 级路由策略。 |
| Upstream Target | `model_routes` | 描述具体 Provider、上游模型、`priority`、`weight`、上游协议 / operation、adapter、计费倍率与默认参数。 |

`route_group` 仍属于客户端模型选择语法的一部分，例如 `model-id:free`；Surface 则在选定 group 后进一步区分客户端协议与 operation。

## Request operation

当前拓扑白名单中的 operation：

| 请求协议 | operation |
|----------|-----------|
| OpenAI | `chat`、`responses`、`images.generations`、`images.edits`、`audio.transcriptions` |
| Anthropic | `messages` |
| Gemini | `generateContent`、`streamGenerateContent` |

`*` 是迁移兼容值。运行时先查精确 operation Surface，查不到时再回退同协议的 `*` Surface。

> `responses` 已作为拓扑标识保留，但 2.0 的 Proxy 尚未挂载 `/v1/responses` 用户入口；配置该 Surface 不会自动新增 HTTP endpoint。当前实际开放接口以 [用户 API](../api/user.md) 为准。

## 运行时解析

1. 从客户端 `model` 解析 `model_id` 与 `route_group`。
2. 根据入口确定 `request_protocol` 与 `request_operation`。
3. 查找 active 的精确 Surface；不存在时查 wildcard Surface。
4. 读取该 Surface 指向的 active Route Pool 及其 active Targets。
5. 2.0 仅支持 `adapter=passthrough`，因此请求协议必须与上游协议一致；跨协议转换尚未开放。
6. 按 `priority` 分层，并在同层内应用有效路由策略与 `weight`。
7. 跳过 disabled / 无 key / 已熔断的 Provider，逐 Target 故障转移。

在迁移尚未应用、Surface 查询不可用的滚动发布窗口，Proxy 会暂时回退旧的 `model + route_group + protocol` 查询路径，避免代码与 Schema 部署顺序造成中断。该回退只用于升级兼容，不应长期依赖。

## 策略优先级

有效策略按以下顺序解析：

1. `route_pools.strategy`
2. `models.route_policy.rules[protocol.capability:route_group]`
3. `models.route_policy.rules[protocol:route_group]`
4. `models.route_policy.strategy`
5. `system_config.ROUTE_STRATEGY`
6. 代码默认 `affinity`

Pool 级策略只影响当前请求 Surface 指向的 Pool，适合让 Chat 保持 `affinity`，同时让 Images / Audio 使用 `weighted_random`。完整算法见 [route-strategies.md](../reference/route-strategies.md)。

## Admin API

- `POST /admin/routes` 可传 `request_protocol`、`request_operation`、`upstream_protocol`、`upstream_operation`、`adapter`；服务端会创建或复用对应 Surface / Pool。
- `PATCH /admin/routes/:id` 可调整 Target；当请求协议或 operation 改变时会重新关联对应 Pool。
- `PATCH /admin/routes/pools/:poolId`，body 为 `{ "strategy": "affinity" }`；`null` / 空值表示继承模型或全局策略。
- `GET /admin/routes` 返回 `route_pool_id` 与序列化的 `surfaces`，供 Admin 绘制路由流。

对外调用 Admin 时，路径前面加 `/api`，即 `/api/admin/routes/...`。

## 请求日志与排障

迁移 0016 为 `api_key_request_logs` 增加：

- `request_operation`
- `model_surface_id`
- `route_pool_id`
- `route_target_id`
- `upstream_operation`
- `adapter`
- `route_trace`

排障时先确认 Surface 是否匹配，再确认 Pool 是否 active、是否存在 active Target，最后检查 Provider 状态、密钥和熔断。2.0 的 `route_trace` 是 `{ surface, pool, target }` JSON 快照，记录最终选中（或最后失败）的拓扑标识，不是完整 attempt 列表。

## 升级兼容

迁移 0016 会按历史 `model_id + route_group + upstream_protocol` 建立 Pool，为每个 Pool 建立 `request_operation='*'` 的兼容 Surface，并把历史 `model_routes` 关联进去。升级步骤与验收清单见 [single-provider-key-cutover.md](../../operators/migrations/single-provider-key-cutover.md)。
