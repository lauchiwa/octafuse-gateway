# Responses API phase 2: translate to chat for chat-only relays

Parent: `07-26-responses-api`. Phase 1 (`07-26-responses-passthrough`, shipped `b80b1d8`) made
Codex work against upstreams that expose a native `/v1/responses`. This phase makes it work
against relays that only speak `/v1/chat/completions`.

## Why

Phase 1's capability gate is deliberately strict: a provider serves Responses traffic only if it
declares `endpoints.openai.endpoints.responses` explicitly (never derived from `base`, see phase 1
design). Measured consequence: of the 42 built-in presets, **10 configure only `openai.base`** and
32 use per-capability URLs — so today a large share of configured providers return

```
502 No provider for this model serves the Responses API.
    Configure endpoints.openai.endpoints.responses for: <names>
```

The owner's requirement from the parent task is explicit: support **both** OpenAI-official and
third-party relays. A relay that proxies `/chat/completions` and nothing else is currently
unusable from Codex, with no configuration workaround (Codex 0.144.6 removed `wire_api="chat"`).

## Requirements

- R1: A provider **without** a declared `responses` endpoint serves `/v1/responses` traffic by
  translating to `/chat/completions`, instead of being filtered out and 502'd.
- R2: A provider **with** a declared `responses` endpoint keeps phase 1's byte-passthrough
  behaviour, unchanged. Passthrough stays the preferred path whenever it is available.
- R3: Request translation covers what Codex actually sends: item-centred `input`
  (message / function_call / function_call_output / reasoning items), `instructions`, `tools`
  (function tools), `tool_choice`, `parallel_tool_calls`, `temperature`, `max_output_tokens`.
- R4: Response translation emits a `response.*` SSE sequence that Codex parses without hanging,
  including a terminal event carrying `usage`. Non-streaming (`stream:false`) returns a
  Responses-shaped JSON object.
- R5: The tool-call round trip works across turns: an assistant `tool_calls` delta becomes
  Responses `function_call` output items, and the `function_call_output` items Codex sends back
  translate to chat `role:"tool"` messages with matching `tool_call_id`.
- R6: Billing and request logging are as correct as the chat path: chat usage
  (`prompt_tokens`/`completion_tokens`/`prompt_tokens_details`) maps into `UsageFromStream`
  through the same `normalizeInputTokensFromPrompt` reconciliation phase 1 uses.
- R7: Auth, budget, rate limiting, sticky routing, failover, circuit breaking and the
  sensitive-content circuit behave identically to phase 1 — this is a new egress strategy behind
  the existing route, not a second pipeline.
- R8: No regression to `/v1/chat/completions`, `/v1/images`, `/v1/messages`, `/v1beta`, or to
  phase 1 passthrough.
- R9: Features that cannot be represented in Chat Completions fail **explicitly and early** with a
  clear message, rather than being silently dropped and producing a subtly wrong session.

## Constraints

- **Streaming fidelity is the failure mode that matters.** A malformed or incomplete `response.*`
  sequence makes Codex hang mid-session rather than error cleanly. Chat SSE is delta-centred
  (`choices[].delta`); Responses is item-centred with explicit lifecycle brackets
  (`output_item.added` → `content_part.added` → deltas → `.done` → `output_item.done`). The
  translator must synthesise those brackets and keep indices consistent.
- **Reasoning cannot round-trip.** Responses reasoning items carry `encrypted_content` that is
  meaningful only to the upstream that produced it. Chat Completions has no equivalent field.
- **IDs must be synthesised.** Codex expects `resp_*` / `item_*` / `call_*` identifiers with
  stable references inside one stream; chat gives only `chatcmpl-*` plus per-tool-call ids.
- Translation runs on the egress hot path in a Worker — no unbounded buffering of the stream.
- Dependency direction stays proxy → core; the translator lives in `packages/proxy`.

## Acceptance Criteria

- [ ] A model routed to a provider with **no** `responses` endpoint returns a valid Responses
      stream (previously: 502). The phase 1 502 remains only when translation itself is
      impossible.
- [ ] A model routed to a provider **with** a `responses` endpoint still byte-passes through;
      no behavioural diff versus `b80b1d8`.
- [ ] Mixed route group: passthrough-capable providers are tried before translation ones.
- [ ] Emitted event sequence for a text turn contains, in order: `response.created`,
      `response.output_item.added`, `response.content_part.added`,
      `response.output_text.delta`+, `response.output_text.done`, `response.content_part.done`,
      `response.output_item.done`, `response.completed` — and `response.completed.response.usage`
      is populated.
- [ ] A tool-call turn emits `response.function_call_arguments.delta`+ and a
      `function_call` output item with a `call_id` that Codex echoes back successfully on the
      next turn.
- [ ] A second turn carrying `function_call_output` items translates to chat `role:"tool"`
      messages and the upstream accepts it.
- [ ] `instructions` becomes a leading `role:"system"` message; it is still redacted out of
      `request_body` in the request log (phase 1's `responsesBodyRedactedForLog`).
- [ ] Usage recorded for a translated request matches what the same request logs on
      `/v1/chat/completions` (same tokens, same cost).
- [ ] Client abort mid-stream still records `cancelled` and drains for trailing usage.
- [ ] `previous_response_id` / `store:true` / hosted tools (`web_search`, `file_search`,
      `computer_use`) return an explicit 400 naming the unsupported field (R9), not a silent drop.
- [ ] proxy + core + admin `typecheck`, `test:unit`, admin `lint` green; `wrangler deploy
      --dry-run` builds.
- [ ] Codex CLI 0.144.6 completes a multi-turn session with tool calls against a chat-only relay.

## Out of scope

- Server-side conversation state (`previous_response_id`, `store:true`). Codex 0.144.6 is
  stateless — verified in the parent task — so this buys nothing for the stated goal.
- Hosted/built-in tools. They execute upstream; a chat-only relay has nowhere to run them.
- A dedicated `request_protocol` value for Responses traffic (deferred from phase 1; still
  logged as `'openai'`).
- Fixing the admin capability badge over-reporting for `base`-configured providers (phase 1
  decision #5, owner-accepted).
- Audio / image output items.

## Known verification blocker (must be resolved or explicitly accepted)

As of 2026-07-27 there is **no working chat-only upstream in this environment** to test against:

- `muyuan.do` is the only configured relay with live credentials, and it is a **native** Responses
  provider — it exercises passthrough, not translation.
- That relay is additionally returning `403 channel:client_restricted` (and Cloudflare challenge
  pages) for **every** User-Agent tried, on both `/chat/completions` and `/v1/responses`, for
  `gpt-5.6-sol`. Its other models return `503 model_not_found`. Its `/v1/models` returns an empty
  list with `200`.

So the final acceptance criterion (a real Codex session through translation) is **owner-run and
currently blocked on upstream access**. Everything above it is testable offline with recorded
fixtures and is where the implementation effort should go.
