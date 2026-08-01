# 技术设计 — 自定义上游 UA/Header

参照先例：`providers.endpoints`（`packages/core/src/provider-endpoints.ts` + 三驱动 impl + admin service + `provider-modal.tsx`）。本特性在数据模型、三段式解析、UI 形态、三驱动 lockstep 上完全镜像它。

## 1. 数据模型

新增列 `providers.custom_headers TEXT`（JSON）：

```jsonc
{
  "openai":    { "User-Agent": "myapp/1.0", "X-Trace": "abc" },
  "anthropic": { "User-Agent": "myapp/anthropic" }
}
```

类型：`ProviderCustomHeadersMap = Partial<Record<UpstreamProtocol, Record<string,string>>>`。空 map 序列化为 `null`（与 endpoints 一致）。

## 2. 优先级 / 合并语义

上游 fetch header 组装：

```ts
const finalHeaders = { ...customHeadersForProtocol, ...driverBaseHeaders };
```

`base` 后展开 → 驱动内置的 `Authorization` / `x-api-key` / `anthropic-version` / `content-type` 等**永远赢**。这是安全边界（S1），也回答了「base 与 custom 都有 UA 时以谁为准」：当前四驱动均未内置 UA，故 custom UA 生效；若将来驱动内置 UA，则内置赢。

## 3. 新核心模块（镜像 provider-endpoints 三段式）

`packages/core/src/provider-custom-headers-types.ts`
- `ProviderCustomHeadersMap`

`packages/core/src/provider-custom-headers.ts`
- `parseProviderCustomHeaders(provider): ProviderCustomHeadersMap` — 容错解析 JSON，坏数据返回 `{}`。
- `serializeProviderCustomHeaders(map): string | null` — 空 → null。
- `validateAndNormalizeProviderCustomHeaders(map): { ok: true; value } | { ok: false; error }` — 安全校验：
  - 协议 key 仅 `openai|anthropic|gemini`。
  - header 名：`^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$`（RFC 7230 token）。
  - header 值：拒绝 `\r` `\n` 及 `< 0x20`（除普通空格）/ `0x7F` 控制字符。
  - denylist（lower-case 比较）：`authorization, x-api-key, anthropic-version, content-type, content-length, host, connection` → 拒绝（S2）。
  - 每协议 ≤ 20 个 header（S4）；单协议 `JSON.stringify` 后 ≤ 1024 字节（S4）。
  - 名称去空白、按原样保留大小写（HTTP header 名大小写不敏感，展示保留用户输入）。
- `resolveCustomHeadersForProtocol(map, protocol): Record<string,string>` — 取单协议，缺省 `{}`。

新 exports 子路径（core `package.json`）：`./provider-custom-headers`。

## 4. 存储层（三驱动 lockstep）

### 迁移（编号 0014，三份）
- `migrations-d1/0014_provider_custom_headers.sql`：`ALTER TABLE providers ADD COLUMN custom_headers TEXT;`
- `migrations-postgres/0014_provider_custom_headers.sql`：同上（PG `TEXT`）。
- `migrations-mysql/0014_provider_custom_headers.sql`：`ALTER TABLE providers ADD COLUMN custom_headers TEXT;`（MySQL `TEXT`，与 endpoints 列同类型）。
- 三 CLI 均扫目录应用（d1 走项目自研 `wrangler-d1-cli.mjs`，pg/mysql 走 `octafuse-migrate`，均 readdir+排序+`schema_migrations` 去重），放文件即执行，无清单登记。

### Drizzle schema
- `schema.pg.ts` / `schema.mysql.ts` 的 `providersTable` 加 `customHeaders: text('custom_headers')`（否则 Drizzle select 不带出该列）。D1 用原生 SQL，无 schema 文件。

### 三驱动 impl（`db/{d1,postgres,mysql}/providers.impl.ts`）
- D1：`getProviderById` 为 `SELECT *` 自动带出；`listProviders` / `insertProvider` 的**显式列清单**加 `custom_headers`。
- Postgres：`mapPgProviderRow` / `providerRecordFromPg` 手工映射加字段；`insertProvider` `.values()` 加 `customHeaders`。
- MySQL：`mapMyProviderRow` / `providerRecordFromMy` + insert 同样处理。
- `insertProvider` 新增参数 `customHeaders?: string | null`（**可选**，C1）。

### 类型 & 白名单
- `types.ts` `ProviderRow`、`repository-dtos.ts` `ProviderAdminRow` 显式加 `custom_headers?: string | null`。
- `patch-allowlists.ts` `PROVIDER_PATCH_COLS` 加 `'custom_headers'`（AC5）。

## 5. 路由 & 驱动（proxy）

- `model-router.ts` `RouteResult` 加 `providerCustomHeaders: Record<string,string>`（已拍平为当前协议的 header）。唯一构造点 `routeRowToResult`：`parseProviderCustomHeaders(provider)` 后 `resolveCustomHeadersForProtocol(map, upstreamProtocol)`。缺省 `{}`，保证下游永远拿到对象而非 undefined。
- 新 helper `packages/proxy/src/services/egress/merge-upstream-headers.ts`：`mergeUpstreamHeaders(base, custom) => ({ ...custom, ...base })`。集中一处，便于测试与将来审计。
- 四驱动（openai / anthropic / gemini / openai-images）在各自 `fetch` 前，把原本的 header 对象经 `mergeUpstreamHeaders(baseHeaders, routeResult.providerCustomHeaders)` 包一层。gemini 的 query-key 模式不受影响（custom 只加 header，不碰 URL）。
- 约束：不引入 `node:*`；helper 是纯函数，Worker/Node 双运行时安全。

## 6. Admin BFF + UI

### service（`lib/services/admin/providers-service.ts` + `types.ts`）
- 新增 `resolveCustomHeadersFromMutation`（镜像 `resolveEndpointsFromMutation`）：从 mutation 输入取 `customHeaders`，调 core 校验器，失败抛 `{ success:false, message }`。
- create / update 路径传入序列化结果。`AdminProviderMutationInput` / `AdminProviderRow` 已有 `[key:string]: unknown` 索引签名，显式加 `custom_headers` 字段更清晰。

### UI（`providers/components/*` + `provider-*.ts`）
- `types.ts` `ProtocolEndpointForm` 加 `customHeaders: Array<{name:string; value:string}>`（键值对行）；`EMPTY_PROTOCOL_FORM` 补默认空数组。
- `provider-utils.ts`：`protocolFormFromConfig` 反填、`configFromProtocolForm` 收集、新增 `formDataToCustomHeadersMap` + `protocolFormHasCustomHeaders`（镜像 `protocolFormHasOverrides`，控制 Advanced 默认展开）。
- `provider-api.ts` `saveProvider` payload 加 `customHeaders: formDataToCustomHeadersMap(formData)`；PATCH 分支保持 `delete patchBody.id`。
- `provider-modal.tsx`：在每个协议 Advanced 折叠区，endpoints 覆盖下方加一个键值对编辑块（新增/删除行）。复用既有协议分组结构，不新造范式（R4）。
- i18n：`messages/{en,zh,ja,ko}.json` 加同结构 key（en 为基线）。

## 7. 测试

- core：`provider-custom-headers.test.ts`（校验器全分支 + parse/serialize round-trip）；三驱动 provider round-trip 加断言。
- proxy：`merge-upstream-headers.test.ts`（合并顺序 + auth 不可被覆盖）。
- admin：`provider-utils.test.ts` 补 `formDataToCustomHeadersMap` / `protocolFormHasCustomHeaders`。

## 8. 兼容性 & 回滚

- 纯增量：新列可空、旧数据 NULL → 解析为 `{}` → 合并注入零 header，行为与今天一致（C2）。
- 回滚：代码回退后遗留的 `custom_headers` 列为惰性列，无需回滚迁移；如需彻底移除另开 drop 迁移。

## 9. 运行时未知项（AC8）

Cloudflare Workers `fetch` 对出站受限 header（尤以 `User-Agent`）的处理需部署后实测：`wrangler tail` + 打到回显端点核对。若被 runtime 覆盖/忽略，在 UI header 编辑区加提示。这是设计层无法消除、只能运行时验证的点。
