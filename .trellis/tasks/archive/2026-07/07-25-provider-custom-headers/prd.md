# 自定义上游 UA/Header

## Goal

允许运营者按 **provider × protocol** 粒度配置一组自定义 HTTP header（首要用途是自定义 `User-Agent`，也支持任意合规业务 header），在网关向上游 `fetch` 时注入。同一 provider 的 openai / anthropic / gemini 协议可各自配置不同的 header。

## Background

- 现状：四个 egress 驱动（openai / anthropic / gemini / openai-images）各自 `fetch` 时使用硬编码 header，均未设置 `User-Agent`，且无任何自定义 header 能力。
- 已有平行先例：`providers.endpoints`（JSON，`Partial<Record<UpstreamProtocol, {...}>>`），本特性完全镜像其数据模型、解析/校验/序列化三段式、UI 协议分组形态与三驱动 lockstep 落地方式。

## Requirements

### 功能
- R1 每个 provider 可按协议（openai/anthropic/gemini）配置零到多个自定义 header（键值对）。
- R2 配置持久化到 `providers.custom_headers`（TEXT/JSON），结构 `Partial<Record<UpstreamProtocol, Record<string,string>>>`；空对象序列化为 `null`。
- R3 请求分发时，按本次路由命中的 `upstreamProtocol` 取出对应协议的 header，注入该请求的上游 `fetch`。
- R4 Admin UI 在 provider 弹窗内、每个协议的 Advanced 折叠区提供键值对编辑，形态与既有 endpoints 覆盖一致（不新造 UI 范式）。
- R5 三种存储驱动（D1 / Postgres / MySQL）行为一致；create、update(patch)、read、import 路径均正确处理该字段。

### 安全约束（硬性）
- S1 注入顺序为 `{...custom, ...base}`：驱动内置的鉴权/协议 header 永远覆盖 custom，custom 不能篡改 `Authorization` / `x-api-key` / `anthropic-version` / `content-type` 等关键 header。
- S2 denylist（大小写不敏感）直接拒绝配置：`authorization, x-api-key, anthropic-version, content-type, content-length, host, connection`（与 S1 双保险）。
- S3 header 名称必须匹配 HTTP token 规则；header 值拒绝 CR/LF 及控制字符（防 header 注入/请求走私）。
- S4 上限：每协议 ≤ 20 个 header；单协议序列化后 ≤ 1KB。
- S5 校验失败必须在 Admin 保存路径给出明确错误，不静默丢弃。

### 兼容性约束
- C1 `insertProvider` 的 customHeaders 参数必须可选，避免破坏 preset import 路径（该路径仅传 `{name, endpoints, description}`）。
- C2 迁移只新增列、不回填、不改动既有列，旧数据 `custom_headers` 为 NULL 时行为与今天完全一致。
- C3 不改变任何现有对外协议路由或响应结构。

## Acceptance Criteria

- [ ] AC1 三个 `0014_provider_custom_headers.sql`（d1/postgres/mysql）均新增 `custom_headers` 列，编号一致。
- [ ] AC2 D1 / Postgres / MySQL 三驱动 round-trip 单测通过：写入含 openai+anthropic 两协议 header 的 provider，读回一致。
- [ ] AC3 校验器单测覆盖：denylist 命中拒绝、非法 token 名拒绝、CR/LF 值拒绝、超 20 个/超 1KB 拒绝、合法配置通过。
- [ ] AC4 合并顺序单测：custom 中若混入 `authorization` 也无法覆盖驱动内置鉴权 header（验证 `{...custom, ...base}`）。
- [ ] AC5 provider PATCH 能更新 custom_headers（`PROVIDER_PATCH_COLS` 已放行），且不影响 endpoints。
- [ ] AC6 Admin UI 可在每个协议 Advanced 区新增/编辑/删除 header 并保存成功；四语言（en/zh/ja/ko）文案齐全，结构一致。
- [ ] AC7 `npm run build -w @octafuse/core`、`typecheck` + `test:unit`（core/proxy/admin）全绿；lint 通过。
- [ ] AC8 运行时实测：部署后经 `wrangler tail` + 打到回显端点，确认自定义 `User-Agent` 是否被 Workers runtime 透传；若被 runtime 覆盖/忽略，在 UI 给出提示说明。

## Out of Scope

- 全局（provider 无关）默认 header。
- 响应 header 改写。
- Codex `/responses` 原生协议支持（另议）。

## Notes

- AC8 是唯一无法靠读代码确认、必须运行时验证的点：Cloudflare Workers `fetch` 对出站 `User-Agent` 等受限 header 的处理需实测。
