# Mask sensitive system_config values in admin API

Follow-up hardening from the 2026-07-26 audit. Not an open vulnerability — `/admin/config` now sits behind the fixed auth — but it still hands every secret to any authenticated caller, and it was the exact path that exposed `MASTER_KEY` during the bypass window.

## Problem

`listAdminSystemConfigService` (`packages/admin/lib/services/admin/dashboard-service.ts:185`) maps every `system_config` row straight through, value included. Secrets currently returned in full:

| key | what it is |
|---|---|
| `MASTER_KEY` | admin master credential |
| `WEB_SEARCH_API_KEY` / `WEB_FETCH_API_KEY` | third-party service keys (legacy flat form) |
| `ALERT_WEBHOOK_WECOM_URL` / `ALERT_WEBHOOK_FEISHU_URL` | webhook URLs whose token *is* the credential |
| `WEB_SEARCH_CATALOG` / `WEB_FETCH_CATALOG` / `WEB_DEEP_SEARCH_CATALOG` | **JSON blobs with an `apiKey` field per provider** |

The catalog keys were not in the original plan. They are the authoritative store when present (`tools/page.tsx:97-115` prefers the catalog and only falls back to the flat key), so masking the flat keys alone would leave the real secrets exposed. Masking them wholesale is also wrong: each entry carries a non-secret `cost` the UI needs.

## Constraints

- **Rotation must still work from the UI.** `MASTER_KEY` was rotated through this page; that flow cannot break.
- **Do not let a mask get written back.** Both pages currently prefill edit drafts from the list response (`config/page.tsx:204-208`, `tools/page.tsx:105/123`). If the list returns `8bxa…xejN` and the user hits save, that literal string overwrites the real secret. This is the main hazard in the task.
- **Clearing must stay possible.** The webhook handler currently treats empty as "clear" (`config/page.tsx:429-447`). Under write-only editing, empty has to mean "leave unchanged", so clearing needs its own explicit affordance.
- Losing UI visibility is acceptable: `npm run deploy:cloudflare -- production --show-master-key` reads D1 directly and remains the out-of-band recovery path.

## Requirements

- R1: `GET /admin/config` never returns a usable secret. Sensitive scalar keys return a mask plus an "is set" signal; catalog keys return their JSON with each `apiKey` masked and every other field intact.
- R2: Sensitivity is decided by an explicit key list **plus** a name heuristic (`_KEY` / `_SECRET` / `_TOKEN` / `WEBHOOK_*_URL` suffixes), so a future secret-bearing key is masked by default rather than by remembering to register it.
- R3: Both UIs switch to write-only: show configured/not-configured plus the mask, start the input empty, and only PUT when the user actually typed something.
- R4: An explicit clear action for each configured secret, replacing "save empty to clear".
- R5: Writes are unchanged — setting a new value works exactly as before, including `MASTER_KEY` rotation.
- R6: Non-sensitive keys (`BILLING_CURRENCY`, `BUSINESS_TIMEZONE`, costs, active-provider selections) are untouched.

## Acceptance Criteria

- [ ] `GET /admin/config` response contains no usable secret — verified against the live instance after deploy
- [ ] Catalog rows still expose `cost` and provider structure; only `apiKey` is masked
- [ ] Rotating `MASTER_KEY` from the config page still works end-to-end
- [ ] Saving a secret section without typing anything leaves the stored value unchanged (the mask-writeback hazard)
- [ ] Clearing a webhook is still possible via the explicit action
- [ ] Unit tests cover the masking helper: flat keys, catalog JSON, heuristic matches, non-sensitive passthrough
- [ ] `npm run test:unit`, typecheck (3 workspaces), admin lint and `build:cf` all pass
