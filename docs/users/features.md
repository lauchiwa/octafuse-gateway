# 功能地图

Octafuse Gateway 是可自托管的 **AI 能力网关与运营控制面**：统一接入 Chat、图片生成 / 编辑、语音转写、可扩展 Agent Tools、私有模型服务和多上游 Provider，并在一个 Gateway 入口上管理路由、密钥、预算、计费、日志与审计。

## 核心组件

| 概念 | 作用 |
|------|------|
| Proxy | 对外 AI 能力入口，提供 OpenAI / Anthropic / Gemini 兼容推理、Images、Audio Transcriptions 与 `/v1/tools/*`。 |
| Admin | 管理 UI 与 `/api/admin/*`，用于维护 Provider、模型、路由、用户、Key、日志与配置。 |
| Provider | 一个上游模型供应商或兼容端点；**一把**上游 API Key + `active` / `disabled`。 |
| Model / Route group | Gateway 暴露给客户端的模型 ID 与可选分组，例如 `model-id:default`、`model-id:free`。 |
| Request Surface | 客户端实际进入模型的协议与操作，例如 OpenAI `chat`、Anthropic `messages`、OpenAI `images.generations`。 |
| Route Pool | 一个 Surface 指向的故障转移池，包含一组可替换的上游 Target，并可覆盖路由策略。 |
| Upstream Target | 具体的 Provider + 上游模型，包含 `priority` / `weight`、上游 operation、计费倍率与默认参数。 |
| Route strategy | 同 Pool、同 priority 层内如何排序候选 Provider：`hash_affinity`（默认）、`weighted_random`、`weight_priority`、`weighted_round_robin`。 |
| Agent Tool | 通过 `/v1/tools/*` 暴露给 Agent 的可扩展能力；当前包含 `web-search`、`web-fetch`、`web-deep-search`、`ai-detection`。 |
| User / API Key | Gateway 发给实际使用方的身份与访问密钥；支持 External system → User → API Key 分层，并可绑定预算、状态和元数据。 |

## 主要能力

| 能力 | 说明 |
|------|------|
| 统一入口 | 客户端只需要配置 Gateway Base URL 和用户 Key。 |
| 多协议兼容 | 支持 OpenAI Chat Completions、Anthropic Messages、Gemini `v1beta` 风格入口。 |
| 图片生成 / 编辑（Images） | OpenAI 兼容 `/v1/images/*`；目录价支持 **token** 分项与 **per_image** 按张；默认 `GET /v1/models` 不含纯 image 模型，可用 `kind=image` / `kind=all` 或直接打 Images API。 |
| 语音转写（Audio） | OpenAI 兼容 `/v1/audio/transcriptions`；目录价支持 **`per_second`（按时长）** 与 **`token`（按上游 usage）** 双模式；默认 `GET /v1/models` 不含 ASR，可用 `kind=audio` / `kind=all`。 |
| Agent Tools | 面向 Agent 的可扩展产品 API（`/v1/tools/*`）：`web-search` 支持博查、Tavily、阿里云 CleverSee、腾讯云 WSA；`web-fetch` 支持 Firecrawl、Tavily Extract、Jina Reader；`web-deep-search` 支持 Firecrawl Search、Jina Search；`ai-detection` 多引擎 catalog（当前实现腾讯云 TMS）。Admin → **Tools** 为每种工具配置多个引擎并选择一个 Active；联网类工具**按次**、AI 检测按**计费字符单元**写入三账本（供应 / 目录 / 用户），**仅 charged 扣预算**；**上游失败不扣费**。调用记入请求日志（`provider_id=octafuse-tools`）。定价只读见 `GET /v1/tools/pricing`（含 `metered` / `standard` / `charged`，`cost` = charged）。 |
| 公开 Catalog | `GET /catalog/models` 无需用户 Key，聚合 active 路由的模型与协议能力，适合门户 discovery；与需鉴权的 `GET /v1/models`（默认 LLM、含 `default,free` route group）分工不同。 |
| 路由与故障转移 | 客户端请求先按协议 / operation 命中 Request Surface，再进入 Route Pool：Pool 内按 **priority** 分层，同层按 **策略 + weight** 排序；失败则换下一 Provider（provider 级熔断）。默认策略 **hash_affinity** 提高上游 prompt cache 命中。详见 [路由拓扑](../developers/architecture/route-topology.md)与 [路由策略](../developers/reference/route-strategies.md)。 |
| 预算与计费 | 按用户 Key 记录请求、Token、成本与扣费，支持周期预算和用量查询。模型与 Agent Tools 均区分 **供应成本**、**目录标准价**、**用户计费** 三笔账（Tools 在 catalog 直接配绝对单价，无 Route factor/schedule）；`budget_spent` 只累加 charged。模型路由可配基础倍率与**每日时段倍率**（业务时区下的高峰 / 闲时），对齐各家模型按时段定价。 |
| 预置 Provider / Models | Admin 可从静态目录一键导入：除官方模型厂外，还覆盖聚合平台与各类 Coding / Token Plan；预填 Base URL 与模型目录价等信息，导入后补齐真实 API Key 并挂路由即可使用。完整清单见官网 [Providers Catalog](https://octafuse.dev/zh/catalog/providers/) 与 [Models Catalog](https://octafuse.dev/zh/catalog/models/)；Coding / Token Plan 的专用 endpoint 不应与普通按量模板混用。 |
| Provider 管理 | 每 Provider 维护单键、启用状态与 `endpoints`；明文 key 仅经 reveal 接口查看。多账号 = 多个 Provider。 |
| 日志与审计 | 请求日志记录调用链路（含 Images / Audio / Tools），审计日志记录预算扣减、用户与 Key 生命周期等事件；Admin Analytics 可按模型 / Provider / 用户观察用量。 |
| Playground / Simulator | **Playground**：Routes 模式直连单条 `model_routes` 上游（不计费、不写日志、无 failover）；Tools 模式读 `system_config` catalog **直连引擎**（可测非 Active，验证密钥；同样不计费、不写日志）。**Simulator**：浏览器打真实 Proxy（鉴权、路由、计费、日志）；Kind 含 LLM / Image / Audio / **Tools**（`POST /v1/tools/*`），Tools 模式隐藏 model/route，响应链到 Tools → Invocations。 |
| 管理 API | 外部门户、后台或脚本可通过 `/api/admin/*` 自动创建用户、发 Key、同步预算和读取配置。 |
| 部署与数据库 | 支持 **Cloudflare Workers + D1**，也支持 Docker / Node + **Postgres 或 MySQL**；同一实例只使用一种数据面。 |

## 四种路由策略

| 策略 | 效果与适用场景 |
|------|----------------|
| `hash_affinity`（默认） | 同用户、模型、分组和协议稳定首选同一 Provider，Prompt Cache 命中率高；短时流量不一定完全均匀。 |
| `weighted_random` | 按 `weight` 加权随机分流，负载均衡性高，适合按比例分摊或 A/B；缓存亲和较弱。 |
| `weight_priority` | 同 priority 层内按 `weight` 从高到低固定排序，适合可预测的主备；首选 Provider 承担大部分流量。 |
| `weighted_round_robin` | 按 `weight` 轮转分摊；计数器按运行实例维护，Cloudflare Workers 多 isolate 之间不全局同步。 |

跨供应商硬主备应使用不同 `priority`；上述策略只决定同一 priority 层内的候选顺序。完整算法与覆盖层级见 [路由策略](../developers/reference/route-strategies.md)。

行为与计费字段以 [developers/api/user.md](../developers/api/user.md)（含 Images / Audio / Tools）、[developers/reference/image-models.md](../developers/reference/image-models.md) 为准。

## 适合的使用方式

- 个人把多个 AI / Coding 资源聚合成一个入口，方便 IDE、命令行工具或其它客户端统一配置。
- 团队为成员、项目或客户发独立 Key，按预算和日志区分使用情况。
- 平台把 Gateway 接入自己的门户或后台，自动开通用户、同步预算并拉取审计数据。
- 运维人员在供应商不可用、额度不足或价格变化时，通过路由策略与 priority / weight 切换上游。

需要了解 API 和系统集成时，继续看 [developers/integration.md](../developers/integration.md)。
