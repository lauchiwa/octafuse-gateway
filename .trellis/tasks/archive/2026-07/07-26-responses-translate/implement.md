# Implementation plan — phase 2 (translate Responses → Chat)

Read `prd.md` and `design.md` first. Every step below traces to a decision recorded there.

**Before starting, read the "Verification reality" section at the bottom.** There is no working
chat-only upstream in this environment today. That does not block the work, but it decides where
the effort goes: fixtures and unit tests carry the correctness burden, not live curls.

## Step 0 — pre-checks (before writing code)

**0a. Export gap: chat usage mapping.** `usageFromProvider` (`openai-driver.ts:100`) maps chat
`ProviderUsage` → `UsageFromStream` and is **not exported**; nor is the `ProviderUsage` type.
Phase 2 needs exactly this mapping (R6).

Do the phase 1 move: **add `export` to both, move nothing.** Phase 1's step 1 established this
pattern for `normalizeInputTokensFromPrompt` precisely because an earlier draft relocated the
function and broke the "chat path untouched" claim. One keyword each, zero logic movement.

Do **not** reimplement the mapping in the translator — a second copy of the cache-convention
reconciliation will drift from the chat path, and R6 is defined as "same numbers as chat".

**0b. Confirm the chat driver's stream shape is reusable as-is.** `dispatchOpenAiRoute` returns
`{response, usagePromise, upstreamRequestId}` with the chat SSE already line-reassembled and
`transformStreamUsageForClient` applied to the forwarded bytes. The translator must **not** sit
behind it — it needs the raw upstream stream, not the client-shaped one. Plan on a separate
dispatch function that fetches the chat endpoint itself (design.md "Where translation lives").

## Step 1 — request translation (pure, no I/O)

New `packages/proxy/src/services/translate/responses-to-chat-request.ts`.

Pure function: `translateResponsesRequestToChat(body) -> {chatBody} | {error}`. No fetch, no
stream, no route knowledge. That is what makes it exhaustively testable without an upstream.

Mapping per design.md's item table:
- `instructions` → leading `{role:'system'}` message
- `input` string → single `{role:'user'}` message
- `input` items → messages, by `type`:
  - `message` (+ `content[]` of `input_text` / `output_text`) → `{role, content}`
  - `function_call` → assistant message with `tool_calls[{id: call_id, function:{name, arguments}}]`
  - `function_call_output` → `{role:'tool', tool_call_id: call_id, content: output}`
  - `reasoning` → **dropped** (design.md: cannot round-trip; `encrypted_content` is
    upstream-private). Count drops and log once per request, do not log content.
- `tools[{type:'function', name, parameters}]` → `[{type:'function', function:{name, parameters}}]`
- `tool_choice`, `parallel_tool_calls`, `temperature`, `top_p` → passthrough
- `max_output_tokens` → `max_tokens`
- `stream` → passthrough; `store` / `previous_response_id` → see step 2

Consecutive `tool_calls` must be merged into **one** assistant message when Codex sends several
`function_call` items in a row — chat requires all parallel calls on a single assistant message,
and splitting them makes strict upstreams reject the follow-up turn. This is the single most
likely correctness bug in the step; test it explicitly.

Tests (create + register in `packages/proxy/package.json` `test:unit` **in this step**): each item
type; multi-turn transcript with a tool round trip; parallel tool calls merged; `instructions`
placement; reasoning dropped without corrupting neighbours; unknown item type handled per R9.

Gate: new test green, `typecheck -w @octafuse/proxy`.

## Step 2 — unsupported-feature rejection (R9)

Same module, checked **before** any dispatch so it returns a clean 400 from the route rather than
a mid-stream failure.

Reject with an explicit message naming the field:
- `previous_response_id` (server-side state; Codex 0.144.6 never sends it — verified in parent task)
- `store: true`
- any tool whose `type` is not `function` (`web_search`, `file_search`, `computer_use`, `mcp`)

Return the error to the **route**, which emits `400 {error: {message, param}}`. Do not throw from
the driver: phase 1 recorded that a throw inside dispatch is treated by `failover-dispatch` as a
fetch failure, retried across every key of the provider, and collapsed into a generic 502. That
finding (C-1/I8 lineage) applies verbatim here.

## Step 3 — response translation, non-streaming

New `packages/proxy/src/services/translate/chat-to-responses-response.ts`.

Pure: chat completion JSON → Responses response object. `output[]` from `choices[0].message`:
`content` → `{type:'message', content:[{type:'output_text', text}]}`; `tool_calls[]` → one
`{type:'function_call', call_id, name, arguments}` item each. `usage` mapped via the step-0
exported `usageFromProvider`, re-shaped to Responses field names for the client-facing body.

`status`: `stop` → `completed`, `length` → `incomplete`, `tool_calls` → `completed`.

Do this before streaming: it pins the target object shape that the streaming path must converge
on, and it is trivially testable.

## Step 4 — response translation, streaming (the hard part)

New `packages/proxy/src/services/translate/chat-to-responses-stream.ts`.

A stateful transformer: chat SSE lines in → Responses SSE events out. Design.md fixes the
contract; the implementation notes that matter:

- Emit `response.created` **immediately on upstream headers**, before the first chat delta.
  Codex waits for it.
- Track `output_index` / `content_index` and open lifecycle brackets lazily: the first text delta
  emits `output_item.added` + `content_part.added` before its own `output_text.delta`.
- A `tool_calls` delta opens a `function_call` item instead; `arguments` fragments arrive split
  across deltas and must be forwarded as `function_call_arguments.delta` without re-chunking.
- Switching from text to a tool call (or between tool calls) must close the previous item's
  brackets in order before opening the next.
- `finish_reason` closes all open brackets, then emits `response.completed` carrying the full
  accumulated response object **including `usage`**.
- If the upstream stream ends without `finish_reason` (relay truncation), still close brackets and
  emit a terminal event — an unterminated sequence hangs Codex, which is the failure mode the PRD
  calls out. Prefer `response.incomplete` so the wrongness is visible.
- `sequence_number` increments across every emitted event.

Synthesise ids once per stream: `resp_<uuid>`, `msg_<uuid>`, `fc_<uuid>`; `call_id` comes from the
upstream `tool_calls[].id` when present (Codex echoes it back next turn — do not regenerate it).

Tests: recorded chat SSE fixtures → assert the exact emitted event sequence and ordering. Cover
text-only, single tool call, parallel tool calls, text-then-tool, truncated stream, `[DONE]`
without usage, usage-bearing final chunk, and split-mid-JSON chunk boundaries. Fixture-driven, so
no upstream needed.

**Test the seam, not just the parts.** Phase 1's one real escaped bug was a double-strip of the
`data:` prefix that only appeared when two individually-correct functions were composed. Assert on
the bytes the client would actually receive, end to end through the transformer.

## Step 5 — egress driver

New `packages/proxy/src/services/egress/openai-responses-translate-driver.ts`, same signature as
`dispatchOpenAiResponsesRoute` so `proxyResponses` can pick between them.

- URL via `resolveUpstreamEndpoint('openai', 'chat', …)` — the capability the provider *does* have
- body: `{...buildRouteRequestBody(route, translated), model: route.providerModelName}`, matching
  phase 1's ordering so route `custom_params` still apply
- headers: base `Content-Type` + `Authorization`, custom side via phase 1's `withClientIdentity`
  (reuse it — the case-insensitive dedup fix lives there)
- **do not pass `requestSignal` to `fetch`** (phase 1 M3: kills the drain, loses trailing usage)
- streaming → step 4 transformer; `application/json` → step 3; non-OK → return untouched so the
  route's `materializeNonOkResponse` and today's 403 classifier still see the real body
- `POST_DISCONNECT_DRAIN_MS` drain + `cancelled` flag, mirroring phase 1

## Step 6 — route selection

`services/proxy.ts` `proxyResponses`: choose per route inside the dispatch closure —
`providerDeclaresResponsesEndpoint(route.providerEndpoints)` ? phase 1 driver : translate driver.
`failover-dispatch.ts` stays unmodified; `DispatchFn` is protocol-agnostic and already receives the
route.

`routes/v1/responses.ts`: **delete the capability filter and its 502** (`responses.ts:169-188`) —
that is the whole point of R1. Keep the `upstreamProtocol === 'openai'` filter. Add the step-2
validation before dispatch, returning 400.

Ordering (R2 / mixed-group criterion): sort passthrough-capable routes ahead of translate-only ones
while preserving relative order within each group, so a native provider is always tried first.

## Step 7 — docs + changeset

`docs/developers/api/user.md` (translation behaviour + which providers get it),
`docs/users/connect-clients.md` (chat-only relay now works from Codex),
`.trellis/spec/proxy/backend/directory-structure.md` (new `services/translate/` dir).
Changeset required — repo runs `verify:package-versions` in CI.

## Validation

Automated, and these are the real gate given the upstream situation:
- `typecheck` + `test:unit` for core / proxy / admin, all green, **new tests registered**
- `lint -w @octafuse/admin` — no new errors
- `wrangler deploy --dry-run` for proxy — only check that the Worker bundle builds
- fixture-driven event-sequence assertions from steps 3–5

Owner-run, blocked on upstream access:
- a real Codex session with tool calls against a chat-only relay
- request-log row inspection: tokens equal to the chat path, no `instructions` in `request_body`

## Verification reality (read before starting)

Measured 2026-07-27, this environment:

| Probe | Result |
|---|---|
| `muyuan.do` `/v1/models` | `200`, empty `data[]` |
| `muyuan.do` `/v1/chat/completions`, `gpt-5.6-sol`, 4 different UAs | `403 channel:client_restricted` on all |
| `muyuan.do` `/v1/responses`, same 4 UAs | `403 channel:client_restricted` on all |
| `muyuan.do` chat, 4 other model ids | `503 model_not_found` |
| via prod gateway, `/v1/responses` | `403` + Cloudflare challenge page, twice in a row |

Two consequences:

1. **The only configured relay is a native Responses provider anyway** — it exercises phase 1
   passthrough, not phase 2 translation. Even with credentials restored it is the wrong test
   subject. A chat-only upstream must be configured before the last acceptance criterion can pass.
2. **Do not treat a live 403 as a phase 2 defect.** It is upstream-side and, as of today's
   `215b5e5`, correctly classified: the two consecutive 403s above prove the provider key is no
   longer circuit-broken (pre-fix, the second would have been a local
   `429 … retry after 600 seconds`).

So: build steps 1–6 against fixtures, land them green, and hand the owner a deployable build plus
the exact Codex config to point at a chat-only relay of their choosing. Do not stall waiting for
upstream access, and do not fake a passing end-to-end criterion.

---

# Outcome (2026-07-28, commit `025a542`)

## What shipped

1. [x] `services/egress/responses-to-chat-request.ts` (326 lines) — pure Responses→chat request
   translation. Items→messages, `instructions`→leading system message, tools un-nesting,
   `max_output_tokens`→`max_tokens`, R9 rejections. Consecutive `function_call` items merge into
   ONE assistant message (parallel calls must share a message or strict upstreams reject the
   follow-up turn).
2. [x] `services/egress/chat-to-responses-object.ts` (227 lines) — non-streaming chat body →
   Responses object, plus the envelope builder / id synthesiser / status mapper that the streaming
   path reuses so both converge on one shape.
3. [x] `services/egress/chat-to-responses-stream.ts` (414 lines) — `ChatToResponsesStreamTranslator`.
   Delta-centred chat SSE → item-centred Responses events with synthesised lifecycle brackets,
   monotonic `output_index`, per-item `content_index`, global `sequence_number`.
4. [x] `services/egress/openai-responses-chat-driver.ts` (354 lines) —
   `dispatchResponsesViaChatRoute`, same signature as the phase 1 passthrough driver. Drain,
   `withClientIdentity` reuse, no `requestSignal` on `fetch`, non-OK passed through untouched.
5. [x] `services/proxy.ts` — `proxyResponses` picks strategy **per route inside the dispatch
   closure** via `providerDeclaresResponsesEndpoint`, so mixed route groups fail over between
   strategies. `failover-dispatch.ts` unmodified.
6. [x] `routes/v1/responses.ts` — phase 1's capability filter + 502 replaced by a
   passthrough-first partition; R9 precheck returns 400 before dispatch.
7. [x] `openai-driver.ts` — `export` added to `ProviderUsage` and `usageFromProvider`. Two
   keywords + comments, zero logic movement (phase 1 step-1 pattern), so the translated path bills
   through the exact same mapping as chat (R6).
8. [x] `scripts/smoke/fake-chat-only-upstream.ts` (190 lines) — local chat-only relay implementing
   ONLY `/v1/chat/completions`; everything else 404s. This is what made the E2E criteria testable
   without the unavailable upstream.
9. [x] Docs: `docs/developers/api/user.md` + `docs/users/connect-clients.md` gained the
   `/v1/responses` sections — **phase 1's docs step never landed**, so both phases are documented
   here. Plus `.trellis/spec/proxy/backend/directory-structure.md` and a changeset.

18 files, +3450/-30.

## Verification (all run)

| Check | Result |
|---|---|
| core `typecheck` + `test:unit` | 164 pass / 0 fail |
| proxy `typecheck` | clean |
| proxy `test:unit` | 173 pass / 0 fail (112 new across 4 files, all registered) |
| admin `typecheck` + `test:unit` | 96 pass / 0 fail |
| admin `lint` | 0 errors (7 pre-existing warnings, unrelated) |
| proxy `wrangler deploy --dry-run` | bundle builds (1199.80 KiB) |

New test counts: request 40, object 25, stream 28, driver seam 19.

### Mutation-tested (tests proven to catch real bugs)

Each of the three highest-risk lines was deliberately broken; the named tests failed for the right
reason, then the code was restored:

| Mutation | Caught by |
|---|---|
| drop `stream_options.include_usage` | 2 tests (translator + driver) |
| `finish()` stops closing open brackets | 17 tests across 4 suites |
| break the parallel-`function_call` merge | 1 test (the exact invariant) |

### E2E through the real gateway (local proxy + fake chat-only relay)

| Path | Result |
|---|---|
| streaming, chat-only provider (`openai.base` only) | full sequence, `sequence_number` 1–14 contiguous; **was 502 before phase 2** |
| non-streaming | valid Responses object; usage `input_tokens:41 cached:8 reasoning:2` |
| tool call turn 1 | `function_call` item, upstream `call_id` preserved, fragments → `{"location":"Paris"}` |
| tool call turn 2 (`function_call_output` back) | `status: completed` |
| mixed group (native prio 99 + chat-only prio 10) | request log shows `p-native` dispatched first — passthrough-first ordering holds |
| R9 `previous_response_id` | `400`, `param: previous_response_id`, no upstream call |
| R9 hosted tool (`web_search`) | `400`, `param: tools` |

Re-run 2026-07-28 on `6c2d63d`: all rows above reproduce. The non-streaming usage row originally
recorded `input_tokens:33`, which was wrong — 33 is the pre-normalisation value. The fixture sends
`prompt_tokens:41` with `cached_tokens:8`, and `normalizeInputTokensFromPrompt` keeps the OpenAI
convention (prompt already includes cache), so `input_tokens` is 41. Confirmed R6 by hitting
`/v1/chat/completions` and `/v1/responses` on the same fixture: both report 41 / 8 / 7 / 2.

## NOT verified

- **A real Codex CLI session against a real chat-only relay** (the last acceptance criterion).
  No chat-only upstream exists in this environment; `muyuan.do` is native-Responses and was 403ing
  every UA. Owner-run once such a relay is configured. Not faked, not claimed.
- Request-log row inspection for a translated request against a real relay.

## Decisions needing owner review (unchanged from design.md)

1. **Reasoning items dropped, not rejected.** `encrypted_content` is upstream-private and chat has
   no field for it. Rejecting would fail every turn after the first — the feature would not work at
   all. Cost: degraded multi-turn reasoning quality on chat-only relays.
2. **`stream_options:{include_usage:true}` injected** into every translated streaming request.
   Without it most OpenAI-compatible relays omit stream usage entirely and every translated request
   bills zero and logs `incomplete` — the most likely silent-billing bug in the task. A strict relay
   could reject the unknown field.
3. **Passthrough-first ordering overrides admin route weights** when a group mixes strategies.
4. **`reasoning.effort` dropped rather than rejected.**

## Deviation from this plan

The plan named `services/translate/` for the three translators (design.md said
`services/egress/`). Shipped in `services/egress/` to match the existing one-driver-per-file
convention; the spec doc was updated to match. No `services/translate/` directory exists.

## Deploy

Proxy-only, no migration:

```bash
CLOUDFLARE_API_TOKEN=... npm run deploy:cloudflare -- production --proxy-only
npm run gen:wrangler   # switch local wrangler config back to local D1
```

Then point Codex at a chat-only relay — see `docs/users/connect-clients.md`.

## Rollback

Revert `025a542`. No schema change, no config change, no secret. Phase 1 passthrough is untouched
by design: providers declaring `endpoints.openai.endpoints.responses` take the same code path as
before this commit.
