# Support OpenAI Responses API so Codex CLI can connect

Parent task. Owns the requirement set, the child task map, and the cross-child acceptance criteria. Not an implementation target itself.

## Why

The owner wants Codex CLI to talk directly to this gateway. That is currently impossible, and there is **no configuration workaround**.

Verified against the installed binary (`codex-cli 0.144.6`):

```
`wire_api = "chat"` is no longer supported.
How to fix: set `wire_api = "responses"` in your provider config.
```

The binary contains no `chat/completions` string at all. Codex only speaks the Responses API, so the gateway must expose `POST /v1/responses`.

Current gateway state:
- Egress OpenAI capabilities are `chat` / `images.generations` / `images.edits` only (`packages/core/src/provider-endpoints.ts:17-27`).
- Ingress routes are `/v1/chat/completions`, `/v1/images`, `/v1/messages`, `/v1beta`, … — no `/v1/responses` (`packages/proxy/src/app.ts:70-78`).

## Findings that shape the design

Two facts cut the scope substantially — both verified, not assumed:

1. **Stateless.** Codex sets `store: false`, never sends `previous_response_id`, and resends the full conversation in `input` every turn. The gateway therefore needs **no server-side response/session storage**, which would otherwise have been the largest component.
2. **No WebSocket needed.** `ModelProviderInfo` (17 fields) has a per-provider `supports_websockets` flag alongside `websocket_connect_timeout_ms`. Omitting it keeps Codex on HTTP + SSE. The "Codex 0.118+ uses WebSockets" reports apply to providers that opt in.

One fact that shapes the split:

3. Third-party relays vary — some expose a native `/v1/responses`, some are chat-only. The owner needs **both** supported.

## Requirements

- R1: `POST /v1/responses` on the proxy, accepting the Responses request shape (item-centred `input`, tools, streaming) and returning an SSE stream of `response.*` events.
- R2: Auth, budget, rate limiting, failover, request logging and billing behave the same as the existing `/v1/chat/completions` path. This is a new protocol surface, not a bypass.
- R3: Per-provider routing decides passthrough vs translation. A provider that declares a native `responses` endpoint is forwarded to verbatim; one that does not is served by translating to `chat/completions`.
- R4: Provider capability is declared through the **existing** `providers.endpoints` JSON (protocol → capability → URL/base), not a new parallel config mechanism.
- R5: No regression to the existing chat / images / messages / gemini paths.
- R6: Codex CLI 0.144.6 works end to end against the deployed gateway: multi-turn conversation with tool calls (shell commands, file edits).

## Constraints

- Streaming correctness is the hard part; a malformed SSE sequence makes Codex hang or die mid-session rather than fail cleanly.
- Usage/billing must be derived from the Responses usage shape, which differs from Chat Completions.
- Reasoning items carry `encrypted_content` across turns; passthrough must not mangle them.

## Child tasks

| Task | Scope | Ships |
|---|---|---|
| `07-26-responses-passthrough` (P1) | `/v1/responses` ingress + SSE + native passthrough egress + billing | Codex working against OpenAI-native upstreams |
| `07-26-responses-translate` (P2) | Responses ↔ Chat translation for chat-only relays | Codex working against any OpenAI-compatible relay |

Ordering: phase 2 depends on phase 1's ingress and routing. Written in each child's own artifacts — do not infer it from tree position alone.

## Cross-child acceptance criteria

- [ ] Codex CLI 0.144.6 completes a multi-turn session with tool calls through the gateway, against a **native** upstream (phase 1)
- [ ] Same, against a **chat-only** relay (phase 2)
- [ ] `api_key_request_logs` rows and billing for Responses traffic are correct and comparable to chat traffic
- [ ] Existing chat / images / messages / gemini paths unaffected (full unit suites + a live smoke on each)
- [ ] A provider missing any `responses` config still works via translation rather than erroring (phase 2)
