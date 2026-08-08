# 部署与运维文档

这里面向负责把 Gateway 跑在生产环境、升级、迁移、排障和维护运行时的人。

## 部署

| 场景 | 文档 |
|------|------|
| 部署模式总览（Cloudflare 默认） | [deployment/README.md](./deployment/README.md) |
| Cloudflare 外部用户快速部署 | [deployment/cloudflare-quickstart.md](./deployment/cloudflare-quickstart.md) |
| Cloudflare Worker + Admin + D1（运维） | [deployment/cloudflare.md](./deployment/cloudflare.md) |
| Docker / 自托管 / Postgres / MySQL | [deployment/docker.md](./deployment/docker.md) |
| Zeabur 容器平台 | [deployment/zeabur.md](./deployment/zeabur.md) |

## 迁移与切换

| 场景 | 文档 |
|------|------|
| D1 与 Postgres 之间 ETL、对账和切换 | [migrations/d1-postgres-cutover.md](./migrations/d1-postgres-cutover.md) |
| 1.11.x → 2.0：单键 Provider + 路由拓扑（本 fork 迁移 0017 / 0018） | [migrations/single-provider-key-cutover.md](./migrations/single-provider-key-cutover.md) |
| 2.1.2 → 2.2.0：Gemini operation 收敛（本 fork 迁移 0019） | [migrations/gemini-models-generate-cutover.md](./migrations/gemini-models-generate-cutover.md) |
| 2.1.2 → 2.2.0：Route Pool 按 priority 层覆盖策略（本 fork 迁移 0020） | [migrations/route-pool-tier-strategies-cutover.md](./migrations/route-pool-tier-strategies-cutover.md) |
| 2.1.2 → 2.2.0：路由策略 canonical ID 硬切换（本 fork 迁移 0021） | [migrations/route-strategy-canonical-ids-cutover.md](./migrations/route-strategy-canonical-ids-cutover.md) |
| 2.2.0 → 2.3.0：Route Pool Provider Sticky Routing（本 fork 迁移 0022） | [migrations/route-pool-sticky-routing-cutover.md](./migrations/route-pool-sticky-routing-cutover.md) |
| 路由策略展示对齐 ID 硬切换（本 fork 迁移 0023：`hash_affinity` / `weight_priority`） | [migrations/route-strategy-display-ids-cutover.md](./migrations/route-strategy-display-ids-cutover.md) |
| User audit 兼容导出移除说明 | [migrations/user-audit-legacy-exports.md](./migrations/user-audit-legacy-exports.md) |

## 本地演练

本地 D1、Node + Postgres、Node + MySQL 的组合启动方式放在开发者文档中：[developers/local-development.md](../developers/local-development.md)。

发布版本、Changesets 和 GHCR 镜像发布见 [maintainers/release-versioning.md](../maintainers/release-versioning.md)。
