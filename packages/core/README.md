# `@octafuse/core`

共享库：**D1 / Postgres / MySQL** 仓储、类型、迁移 CLI（`octafuse-migrate`）、关键写路径与领域服务。被 **`@octafuse/proxy`** 与 **`@octafuse/admin`** 引用；无独立 HTTP 入口。

- **D1**：`migrations-d1/` + 根目录 **`npm run db:migrate*`**（`wrangler.d1.jsonc`）
- **Postgres**：`migrations-postgres/` + **`npm run db:migrate:pg`**
- **MySQL**：`migrations-mysql/` + **`npm run db:migrate:mysql`**

2.0 的关键 Schema 变更为 `0015_single_provider_key` 与 `0016_route_surfaces_pools`。升级前先阅读 [2.0 升级指南](../../docs/operators/migrations/single-provider-key-cutover.md)。

架构与运行时矩阵：[docs/README.md](../../docs/README.md) · [runtime-data.md](../../docs/developers/architecture/runtime-data.md) · [route-topology.md](../../docs/developers/architecture/route-topology.md)
