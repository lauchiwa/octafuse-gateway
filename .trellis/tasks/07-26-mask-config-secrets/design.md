# Design — mask sensitive system_config values

## Server: one masking helper, applied in the list service

New `packages/admin/lib/services/admin/system-config-mask.ts`:

```ts
maskSystemConfigRow({ key, value, description }) -> AdminConfigRow
```

Returned shape gains two fields (additive, so non-secret rows are unaffected):

```ts
{
  key, description,
  value: string | null,   // null for masked scalars; masked JSON for catalogs
  is_secret: boolean,
  is_set: boolean,        // whether a value exists, so the UI can say 配置/未配置
  value_masked: string | null,  // e.g. "8bxa…xejN"
}
```

### Classification (R2)

```
SENSITIVE_CONFIG_KEYS = { MASTER_KEY, WEB_SEARCH_API_KEY, WEB_FETCH_API_KEY,
                          ALERT_WEBHOOK_WECOM_URL, ALERT_WEBHOOK_FEISHU_URL }
SECRET_CATALOG_KEYS   = { WEB_SEARCH_CATALOG, WEB_FETCH_CATALOG, WEB_DEEP_SEARCH_CATALOG }
heuristic: /(_KEY|_SECRET|_TOKEN)$/  or  /^ALERT_WEBHOOK_.*_URL$/
```

Explicit list first, heuristic as the safety net — a future `FOO_API_KEY` is masked without anyone remembering to register it. The heuristic deliberately does **not** match `WEB_SEARCH_PROVIDER` or `*_ACTIVE`, which are not secrets.

### Catalog masking

Parse the JSON; for each provider entry replace `apiKey` with its mask and keep every other field (`cost`) as-is. Unparseable JSON → mask the whole value (fail safe, not fail open).

```
{"tavily":{"apiKey":"tvly-abc123def","cost":0.01}}
  → {"tavily":{"apiKey":"tvly…3def","cost":0.01,"apiKeySet":true}}
```

`apiKeySet` lets the UI distinguish "configured" from "empty string" without leaking length.

### Mask format

`first4…last4` when the value is longer than 12 chars, otherwise a fixed `••••` — never reveal enough of a short secret to matter. Empty/unset → `value_masked: null`, `is_set: false`.

## Client: write-only editing

Both pages stop seeding drafts from the response.

**`config/page.tsx`**
- `MASTER_KEY`, both webhooks: draft starts `''`; the field shows `已配置 8bxa…xejN` / `未配置` as helper text with placeholder "留空则不修改".
- Save handlers skip any secret whose draft is empty (this is the fix for the mask-writeback hazard).
- Webhooks gain an explicit 清除 button issuing `PUT {value: ''}`, since empty-means-clear is gone (R4).

**`tools/page.tsx`**
- `syncWebSearchFromRows` / `syncWebFetchFromRows` read `cost` from the catalog as today but leave `apiKey` drafts empty, carrying `apiKeySet` + the mask for display.
- On save, omit `apiKey` when the draft is empty so the stored key survives; the service merges the incoming partial entry over the existing catalog rather than replacing it wholesale.

That merge-on-write is the one server-side behaviour change beyond masking: without it, "save costs only" would wipe the keys.

## What is deliberately not done

No reveal endpoint. The out-of-band `--show-master-key` path already covers recovery, and a second endpoint that emits plaintext would re-open exactly what this task closes.

## Rollout

Pure hardening: no migration, no schema change, no breaking data change. Deploy admin only (`--admin-only`); the proxy does not read these rows through this path. Rollback is a code revert.

Post-deploy check:
```bash
curl -s -H "Authorization: Bearer <MASTER_KEY>" \
  https://my-octafuse-prod-admin.chiwalau.workers.dev/api/admin/config | grep -c '<the real master key>'   # expect 0
```
