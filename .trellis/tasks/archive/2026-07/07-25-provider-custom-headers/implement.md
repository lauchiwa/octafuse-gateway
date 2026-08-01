# 执行计划 — 自定义上游 UA/Header

依赖顺序：数据层 → 核心模块 → 路由/驱动 → Admin → i18n → 测试。每组结束跑对应 typecheck/test。

## 阶段 A：core 数据层与模块

- [x] A1. 三份迁移 `0014_provider_custom_headers.sql`（d1 / postgres / mysql），各 `ALTER TABLE providers ADD COLUMN custom_headers TEXT;`
- [x] A2. Drizzle schema：`schema.pg.ts` / `schema.mysql.ts` `providersTable` 加 `customHeaders: text('custom_headers')`
- [x] A3. 新模块 `provider-custom-headers-types.ts`（`ProviderCustomHeadersMap`）
- [x] A4. 新模块 `provider-custom-headers.ts`（parse / serialize / validateAndNormalize / resolveCustomHeadersForProtocol），含 denylist / token 正则 / CRLF 拒绝 / ≤20 / ≤1KB
- [x] A5. core `package.json` `exports` 加 `./provider-custom-headers`
- [x] A6. 三驱动 `providers.impl.ts`：
  - d1：`listProviders` / `insertProvider` 显式列加 `custom_headers`；`insertProvider(customHeaders?)`
  - postgres：`mapPgProviderRow` / `providerRecordFromPg` / insert `.values()`
  - mysql：`mapMyProviderRow` / `providerRecordFromMy` / insert
- [x] A7. 类型：`types.ts` `ProviderRow`、`repository-dtos.ts` `ProviderAdminRow` 加 `custom_headers?: string | null`
- [x] A8. `patch-allowlists.ts` `PROVIDER_PATCH_COLS` 加 `'custom_headers'`
- [x] 验证：`npm run build -w @octafuse/core`

## 阶段 B：proxy 路由 + 驱动

- [x] B1. `model-router.ts`：`RouteResult` 加 `providerCustomHeaders`；`routeRowToResult` parse+resolve 拍平
- [x] B2. 新 helper `egress/merge-upstream-headers.ts`（`{...custom, ...base}`）
- [x] B3. 四驱动 fetch 前包 `mergeUpstreamHeaders`（openai / anthropic / gemini / openai-images）
- [x] 验证：`npm run typecheck -w @octafuse/proxy`

## 阶段 C：Admin BFF + UI

- [x] C1. service `resolveCustomHeadersFromMutation` + create/update 接入；`types.ts` mutation/row 加字段
- [x] C2. UI `types.ts` `ProtocolEndpointForm` 加 `customHeaders`；`EMPTY_PROTOCOL_FORM` 补默认
- [x] C3. `provider-utils.ts`：反填 / 收集 / `formDataToCustomHeadersMap` / `protocolFormHasCustomHeaders`
- [x] C4. `provider-api.ts` `saveProvider` payload 加 `customHeaders`
- [x] C5. `provider-modal.tsx` 协议 Advanced 区加键值对编辑块
- [x] 验证：`npm run typecheck -w @octafuse/admin`

## 阶段 D：i18n + 测试

- [x] D1. `messages/{en,zh,ja,ko}.json` 同结构 key（en 基线）
- [x] D2. core `provider-custom-headers.test.ts` + 三驱动 round-trip 断言
- [x] D3. proxy `merge-upstream-headers.test.ts`
- [x] D4. admin `provider-utils.test.ts` 新增函数覆盖

## 阶段 E：全量校验

- [x] `npm run build -w @octafuse/core`
- [x] `npm run test:unit -w @octafuse/core`
- [x] `npm run typecheck -w @octafuse/proxy` + `npm run test:unit -w @octafuse/proxy`
- [x] `npm run lint -w @octafuse/admin` + `npm run typecheck -w @octafuse/admin` + `npm run test:unit -w @octafuse/admin`

## 部署后（AC8，非本任务代码范围，但需记录）

- [ ] `wrangler tail` + 回显端点核对 Workers 出站 `User-Agent` 是否透传；若被覆盖，UI 加提示（部署后执行）

## 回滚点

- 阶段 A 后未接入 proxy/admin：列存在但无人写，无副作用。
- 任一阶段 typecheck 失败：定位单包修复，不跨阶段堆叠。
