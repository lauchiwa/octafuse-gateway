# Responses API phase 1: ingress + native passthrough

Child of `07-26-responses-api`. Independently shippable: on its own it makes Codex CLI work against upstreams that already speak the Responses API.

**Ordering:** phase 2 (`07-26-responses-translate`) builds on the ingress route and provider-capability routing introduced here, so this ships first. Phase 2 is not required for this task to be complete or useful.

## Why this is already useful

The owner's relay `muyuan.do` was probed on 2026-07-26 and **natively serves `/v1/responses`** with working SSE streaming for `gpt-5.6-sol`. So phase 1 alone unblocks the actual goal — Codex CLI connecting to the gateway — without waiting for translation.

## Requirements

- R1: `POST /v1/responses` accepts the Responses request shape (item-centred `input`, `tools`, `store`, reasoning controls) and streams back `response.*` SSE events.
- R2: The request body is forwarded with **exactly two** routing-required changes and nothing else:
  (a) `model` is replaced with `route.providerModelName`, (b) the route's configured
  `custom_params` defaults are applied via `buildRouteRequestBody`. Every other field —
  `input`, `instructions`, `tools`, `store`, `reasoning`, `include` — passes through untouched.
  Measured reason: the relay injects Codex's own system prompt server-side and returns
  `encrypted_content` reasoning items; rewriting either corrupts the turn.
  The SSE **response** body is relayed byte-for-byte (no line reassembly).
- R3: **Client identity is preserved, but overridable per provider.** By default the caller's `User-Agent` and `originator` reach the upstream unchanged (measured reason: the relay returns `403 channel:client_restricted` to callers it does not recognise as Codex). A provider that configures `User-Agent` / `originator` in its `custom_headers` **overrides** the caller's value. The gateway never synthesises its own UA.
- R4: A provider is treated as natively capable when it declares a `responses` endpoint in the existing `providers.endpoints` JSON. No new configuration mechanism.
- R5: A route whose provider does not declare `responses` fails with a clear error naming the provider — no silent fallback to `chat/completions`, which would drop tool calls.
- R6: Auth, budget checks, rate limiting, sticky routing, failover, circuit breaking, request logging and billing all reuse the existing pipeline; this adds a protocol surface, not a parallel path.
- R7: Usage is parsed from the Responses shape — `input_tokens`, `input_tokens_details.{cached_tokens,cache_write_tokens}`, `output_tokens`, `output_tokens_details.reasoning_tokens` — and recorded so `api_key_request_logs` rows are comparable to chat traffic.
- R8: A stream that ends without a terminal event is recorded as `incomplete` with whatever usage was observed, never silently billed as zero. Bounded by the existing `USAGE_SAFETY_TIMEOUT_MS`.
- R9: The implementation obeys the package conventions in `.trellis/spec/proxy/backend/`: runtime-neutral (no `process.env` / `node:*` outside `runtime/`), `RequestTimingCollector` driven through the full lifecycle, billing via `scheduleBackgroundWork`, non-OK upstream responses classified before being treated as fatal, and no secrets or prompt content in logs.
- R10: Client-visible usage must not be double-counted. **Measured (2026-07-26, muyuan.do / gpt-5.6-sol): no intermediate `response.*` event carries usage — only `response.completed`.** So under byte passthrough there is nothing to strip, and chat's `transformStreamUsageForClient` is deliberately NOT reused (it would rewrite Responses frames). The parser is defensive anyway: scan any event for `data.response.usage`, ignore null, last non-null wins. If a future upstream is found emitting cumulative intermediate usage, that is a follow-up — byte passthrough is the settled decision here and stripping would contradict it.

## Constraints

- SSE correctness is the failure mode that matters: a malformed or truncated event sequence makes Codex hang mid-session rather than error cleanly.
- No response/session storage. Codex is stateless (`store: false`, no `previous_response_id`, full history each turn), so the gateway must not attempt to persist or chain responses.
- No regression to `/v1/chat/completions`, `/v1/images`, `/v1/messages`, `/v1beta`.

## Out of scope

- Responses ↔ Chat translation for chat-only relays (phase 2).
- WebSocket transport. Codex only uses it for providers declaring `supports_websockets`; HTTP + SSE is sufficient.
- Server-side conversation state (`previous_response_id`, `store: true`).

## Acceptance Criteria

Verifiable by me:

- [ ] `POST /v1/responses` with `stream:false` returns 200 and writes one usage row with correct
      `input_tokens` / `output_tokens` / cache split, `request_protocol='openai'`, and
      `upstream_message_id` = the `resp_*` id. **Note the shape difference:** non-streaming usage
      is at `body.usage` / `body.id` (the body *is* the response object), not `data.response.usage`
      as in the SSE frames. Reusing the streaming parser unchanged here yields zero usage and a
      null id (finding C-4).
- [ ] Streaming request relays the event sequence through `response.completed` **byte-for-byte**
      (no re-encoding, no trailing `.trim()`); usage is read from `data.response.usage` with
      last-non-null-wins across all frames, not "terminal frame only" — the defensive contract
      survives an upstream that reports early (finding C-2).
- [ ] Timing fields are non-null for a streamed request: `gatewayOverheadMs` (needs
      `markGatewayComplete`), first-byte, first-event, first-token, stream-complete.
- [ ] The driver does **not** call `markUpstreamDispatchStart` / `markAttemptFailover` /
      `markFinalAttempt` — those belong to `failover-dispatch`; `upstreamFailoverCount` stays
      correct.
- [ ] Client aborts mid-stream → row is `cancelled` (not `incomplete`); a stream that never
      yields usage → `incomplete` after `USAGE_SAFETY_TIMEOUT_MS`.
- [ ] Header precedence asserted **through `new Headers(merged).get('user-agent')`**, including
      the case where the provider configures `User-Agent` and the caller sends `user-agent` —
      the provider value must win outright, with no comma-joined concatenation.
- [ ] A provider with only `openai.base` (no explicit `endpoints.responses`) is **not** treated
      as Responses-capable; a model whose routes all lack the capability returns a 502 naming
      the providers, and **no provider-key circuit opens** in that path.
- [ ] A model with mixed routes (one capable, others not) still works — incapable routes are
      filtered with a logged skip, not fatal.
- [ ] Request-log body contains no `input`, `instructions`, or `prompt` text, and
      `upstream_request_body` matches what the driver actually sent.
- [ ] Cache-token normalisation unit-tested for both upstream conventions
      (prompt-includes-cache and prompt-excludes-cache) so billing cannot silently under-count.
- [ ] No behavioural regression to `/v1/chat/completions`, `/v1/messages`, `/v1beta`,
      `/v1/images/*`. Precise claim: the only edit to an existing driver is adding one `export`
      keyword to `normalizeInputTokensFromPrompt` in `openai-driver.ts` — no logic moves, and the
      chat pump is not touched. (An earlier draft claimed `openai-driver.ts` was "not modified at
      all" while also planning to relocate that function; the relocation was dropped.) Evidence:
      new normaliser unit test + `test:unit` green + one live streamed chat request. Note that
      `test:unit` alone proves little here — no registered proxy test exercises `openai-driver.ts`.
- [ ] `npm run gen:wrangler` then `npx wrangler deploy --dry-run` succeeds for the proxy
      (Workers-runtime check). `packages/proxy/wrangler.jsonc` is generated and gitignored, so
      the config must be regenerated first on a clean tree.
- [ ] Both i18n keys exist in all four locale files (`en`/`zh`/`ja`/`ko`):
      `providers.modal.capResponses` **and** `providers.card.cap.responses` — the card renders
      badges through a separate namespace, so one alone leaves a raw key visible.
- [ ] A UA-gated upstream 403 (`channel:client_restricted`) does not open an `auth` circuit on
      every key of that provider. `upstream-failure-classifier.ts:34` maps 401/403 to
      `retry_key` + `failureKind:'auth'`, so one misconfigured request would otherwise walk every
      key, trip a circuit per key, and fire an alert webhook per key. Either special-case a
      request-identity 403, or record this as an accepted deviation with that blast radius
      written down.

Owner-verified (outside what I can run):

- [ ] Codex CLI 0.144.6 completes a multi-turn session **with tool calls** through the gateway
      without stalling — the real SSE-fidelity test.
- [ ] Admin analytics show the Responses requests with sane cost and timing.


## Verification note

The Codex-session criterion cannot be met by automated tests in this environment — it needs the owner to run their Codex CLI against the deployed gateway. Everything else is checkable locally or by curl.
