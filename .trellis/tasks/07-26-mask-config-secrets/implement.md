# Implement — mask sensitive system_config values

## Ordered checklist

1. [ ] `packages/admin/lib/services/admin/system-config-mask.ts` — classification sets, heuristic, mask formatter, scalar + catalog masking, `maskSystemConfigRow`.
2. [ ] `system-config-mask.test.ts` — flat keys, catalog JSON (`cost` preserved, `apiKey` masked), heuristic hits/misses, unparseable JSON fails safe, non-sensitive passthrough, short-secret masking.
3. [ ] `dashboard-service.ts:185` `listAdminSystemConfigService` — map rows through the helper.
4. [ ] `AdminConfigRow` type — add `is_secret` / `is_set` / `value_masked`, `value` becomes nullable.
5. [ ] Catalog merge-on-write so "save cost only" cannot wipe keys (web search / fetch / deep search update paths).
6. [ ] `config/page.tsx` — drafts start empty for `MASTER_KEY` + both webhooks; show 已配置/未配置 + mask; skip PUT on empty draft; add explicit 清除 for webhooks.
7. [ ] `tools/page.tsx` — `syncWeb*FromRows` keep `cost`, leave `apiKey` empty, carry mask + `apiKeySet`; omit `apiKey` from the payload when the draft is empty.
8. [ ] Register the new test in admin `test:unit`.

## Validation

```bash
npm run test:unit -w @octafuse/admin
npm run typecheck -w @octafuse/admin
npm run lint -w @octafuse/admin
npm run build:cf -w @octafuse/admin
```

## Manual checks that unit tests cannot cover

Against a local `npm run dev:admin` or after deploy:

1. Config page loads — secrets show 已配置 + mask, inputs empty.
2. **Mask-writeback hazard:** save the MASTER_KEY / webhook section with the input untouched → stored value unchanged (re-read via `--show-master-key`).
3. Rotate `MASTER_KEY` by typing a new value → old key 401s, new key works.
4. Webhook 清除 → value emptied.
5. Tools page: costs still display; saving cost alone keeps the API key working.

## Deploy

Admin only, no migration:
```bash
npm run deploy:cloudflare -- production --admin-only
```

Post-deploy verification (expect `0`):
```bash
curl -s -H "Authorization: Bearer <MASTER_KEY>" \
  https://my-octafuse-prod-admin.chiwalau.workers.dev/api/admin/config \
  | grep -c '<the real MASTER_KEY value>'
```

## Rollback
Code revert + redeploy. No data or schema changes, so rollback is clean.

---

## 结论：已实现但**决定不上线**（2026-07-26）

代码完整、验证通过（17 条新单测，admin 套件 83 → 100，typecheck / lint / build:cf 全绿），保留在分支 `fix/mask-config-secrets`，**未合并 main、未部署**。

### 不上线的理由

评估后认定对本实例性价比不足：

- **收益比预期小。** `/admin/config` 只对已鉴权的管理员开放（MASTER_KEY 或已签名会话），认证绕过已在 `dbca9b3` 修掉。脱敏挡的不是未授权访问，而是「管理后台 XSS / 会话被借用 / 截图与屏幕共享 / 临时管理员顺手带走凭据」这类意外暴露。本实例单人运维，这些场景基本不存在 —— 属于纵深防御，不是补漏洞。
- **代价明确。** 后台不再能读回 MASTER_KEY、webhook URL、搜索 API key；日常拿 MASTER_KEY 只能走终端 `--show-master-key`（需 CF token）。对单人运维是实打实的摩擦。
- 另新增困惑点：留空保存变成静默 no-op。

### 如果以后要捡起来

触发条件：多人协作 / 外部承包商 / 合规要求，或管理后台暴露面变大。

**那时更适合的是「默认脱敏 + 显式 reveal 按钮」**（原 design.md 里被否掉的备选 B），而非本分支的纯写入-only：既避免随手暴露，又保住「要用时一步可得」。改造点：在本分支基础上加 `GET /admin/config/:key/reveal`（MASTER_KEY 鉴权 + 审计日志）与前端「查看」按钮。
