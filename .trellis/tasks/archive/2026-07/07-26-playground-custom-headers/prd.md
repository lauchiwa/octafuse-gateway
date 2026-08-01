# 调试台自定义上游 header

## Goal

Admin 调试台（playground）直连上游时也注入 provider `custom_headers`，与 Proxy 行为一致。

## Background

`07-25-provider-custom-headers` 只把注入点做在 Proxy 的四个 egress 驱动上。Admin 调试台
（`packages/admin/lib/services/admin/playground-service.ts`，注释首行即声明「不经过 Proxy」）
是一条独立出站路径，三个协议分支的 header 均硬编码（`Content-Type` + 鉴权），未读 `custom_headers`。

后果：用户在 provider 上配了自定义 UA/header，调试台请求不带这些 header，调试台「测通」
不代表线上同样行为，失去诊断意义。这是上个任务遗漏的一致性缺口。

## Requirements

### R1 注入范围
- playground 三个协议分支（openai / anthropic / gemini）+ openai images 两个操作
  （generations JSON / edits multipart）均注入当前协议的 custom headers。
- 协议粒度与 Proxy 一致：按 `route.upstreamProtocol` 取该协议的 header 集合。

### R2 复用而非重写
- 复用 core `parseProviderCustomHeaders` / `resolveCustomHeadersForProtocol`。
- 复用同一个合并函数。当前 `mergeUpstreamHeaders` 位于
  `packages/proxy/src/services/egress/merge-upstream-headers.ts`，而 **admin 不依赖 proxy**：
  需将其上移到 core（并入 `provider-custom-headers` 模块，属同一特性），
  proxy 四驱动改为从 core 导入。不得在 admin 复制一份实现。

### R3 安全边界不变
- 合并顺序仍为 `{ ...custom, ...base }`：驱动/服务内置的鉴权与协议 header
  （`Authorization` / `x-api-key` / `anthropic-version` / `Content-Type`）永远覆盖 custom。
- core 校验器 denylist 保持不变，写入侧已拦截敏感 header。

### R4 无需额外查库
- `resolvePlaygroundRoute` 已 `getProviderById` 拿到 `ProviderRow`，其 `custom_headers` 字段已存在。
  在该处解析并挂到 `PlaygroundResolvedRoute` 上，不新增查询。

### R5 不扩大范围
- 不改数据模型、不加迁移、不动 UI、不加 i18n。
- 不改变 playground 既有语义（不鉴 API Key、不写日志、不计费、无 failover）。

## Acceptance Criteria

- [ ] AC1 `mergeUpstreamHeaders` 移入 core 并从 `@octafuse/core/provider-custom-headers` 导出；
      proxy 四驱动（openai / anthropic / gemini / openai-images）改为从 core 导入，行为不变。
- [ ] AC2 `PlaygroundResolvedRoute` 带 `providerCustomHeaders: Record<string,string>`（已按协议拍平，缺省 `{}`）。
- [ ] AC3 playground 全部上游 fetch 站点经 `mergeUpstreamHeaders` 注入：
      openai chat / openai images.generations / openai images.edits / anthropic messages / gemini。
- [ ] AC4 custom 中的 `Authorization` / `x-api-key` / `anthropic-version` / `Content-Type`
      无法覆盖服务内置值（单测断言）。
- [ ] AC5 provider 无 `custom_headers`（NULL / 脏数据）时，playground header 与改动前逐字节一致。
- [ ] AC6 测试：core merge 测试随模块迁移仍通过；admin 新增 playground 注入单测。
- [ ] AC7 全量校验通过：core build + test:unit、proxy typecheck + test:unit、
      admin lint + typecheck + test:unit。

## Notes

- gemini 分支的 header 由 `prepareGeminiUpstreamFetch` 产出（query-key 模式），
  custom 只加 header、不碰 URL，与 Proxy gemini 驱动处理方式一致。
- images.edits 为 multipart，`Content-Type` 由 runtime 依 `FormData` 自动设置，
  服务未显式设置该头 —— 注入 custom 时不得引入显式 `Content-Type`，否则会破坏 boundary。
