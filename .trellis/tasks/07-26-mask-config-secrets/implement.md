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
