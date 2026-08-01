# Design — phase 2: translate Responses ↔ Chat Completions

Read `prd.md` first. Parent: `07-26-responses-api`. Builds directly on phase 1
(`07-26-responses-passthrough`, shipped `b80b1d8`) — the ingress route, usage race, logging and
failover all already exist and are **not** re-implemented here.

## Shape

Phase 1 filters non-capable providers out of the route list. Phase 2 turns that filter into a
per-route **strategy choice**, made at the same point the filter used to run:

```
POST /v1/responses                       (routes/v1/responses.ts — mostly unchanged)
  ├─ auth / model resolution / budget    unchanged
  ├─ routes.filter(upstreamProtocol === 'openai')      unchanged
  ├─ NEW: partition instead of filter
  │     providerDeclaresResponsesEndpoint(r) ? 'passthrough' : 'translate'
  │     ordered: all passthrough routes first, then translate routes   (R2, AC3)
  └─ proxyResponses(...)
        └─ failoverDispatchWithKeyPool(… 'openai' …)    unchanged orchestration
              └─ DispatchFn picks per route:
                   passthrough → dispatchOpenAiResponsesRoute   (phase 1, untouched)
                   translate   → NEW dispatchResponsesViaChatRoute
```

The strategy decision is **per route, inside the dispatch closure**, not a route-level branch.
That matters for failover: a route group can mix a native provider and a chat-only one, and one
failing over to the other must keep working. `DispatchFn` receives the `RouteResult`, so the
closure can call `providerDeclaresResponsesEndpoint(route.providerEndpoints)` itself.

`failover-dispatch.ts` is **not modified** (same as phase 1).

## What Codex actually sends and accepts

Extracted from the installed native binary
(`node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex`, codex-cli 0.144.6)
plus the live captures recorded in phase 1's design.

Item types named in the binary's serde enums:

```
message, reasoning, local_shell_call, function_call, function_call_output,
custom_tool_call, custom_tool_call_output, tool_search_call, tool_search_output,
web_search_call, image_generation_call, compaction, other
```

Content item types: `output_text`, `input_text`, `input_image`, `summary_text`,
plus `commentary` / `final_answer` phase markers and `encrypted_content` on reasoning.

**Caveat on method, stated because it bounds confidence:** the Rust binary's string pool is
suffix-merged, so substring counts per event name are not a reliable inventory — I tried that and
the numbers were nonsense (`response.output_text.delta` "0 occurrences" while the event demonstrably
works). The event *sequence* below therefore comes from phase 1's **live capture**, which is
measurement, not from binary spelunking. Treat the item-type list above as "these names exist in
the binary", not as "these are all required".

Live-captured sequence for a trivial text turn (phase 1, `muyuan.do`, `gpt-5.6-sol`):

```
response.created → response.in_progress → response.output_item.added
→ response.content_part.added → response.output_text.delta …
→ response.output_text.done → response.content_part.done
→ response.output_item.done → response.completed
```

This is the sequence the translator reproduces. `response.in_progress` is included because it was
observed; it is cheap to emit and omitting it is an untested deviation.

## Where translation lives

Four new files in `packages/proxy/src/services/egress/`, split by direction so each is unit-testable
without a network:

| File | Responsibility |
|---|---|
| `responses-to-chat-request.ts` | Responses request body → chat request body (pure) |
| `chat-to-responses-stream.ts` | chat SSE → Responses SSE events (stateful, pure over strings) |
| `chat-to-responses-object.ts` | non-streaming chat body → Responses object (pure) |
| `openai-responses-chat-driver.ts` | `dispatchResponsesViaChatRoute` — fetch + wire the three above |

Rationale for keeping the driver separate from the three translators: the translators are pure and
get dense unit tests; the driver is the thin I/O shell that mirrors
`openai-responses-driver.ts`'s structure (drain, timing marks, `withClientIdentity`, no
`requestSignal` on `fetch`). Mixing them would make the translation logic only reachable through a
`fetch` mock.

## Request translation (R3)

`input` is an array of items (Codex is stateless and resends the whole history each turn).
Mapping, item type → chat message:

| Responses input item | Chat message |
|---|---|
| `{type:'message', role:'user'\|'assistant'\|'system', content:[…]}` | same role; content flattened |
| `{type:'function_call', name, arguments, call_id}` | `assistant` message with `tool_calls:[{id:call_id, type:'function', function:{name, arguments}}]` |
| `{type:'function_call_output', call_id, output}` | `{role:'tool', tool_call_id:call_id, content:<output>}` |
| `{type:'reasoning', …}` | **dropped** (see below) |
| plain string `input` | single `user` message |

Content flattening: `input_text` / `output_text` → text; `input_image` → chat
`{type:'image_url', image_url:{url, detail}}`. A content array with a single text part collapses to
a plain string, because some relays reject the array form on `role:'system'`.

`instructions` → leading `{role:'system'}` message, before all translated items. Codex's
`instructions` is its full agent prompt; phase 1 already keeps it out of the request log and that
redaction is unchanged.

Parameter mapping:

```
max_output_tokens → max_tokens
tools[{type:'function', name, parameters, description}]
                  → tools[{type:'function', function:{name, parameters, description}}]
tool_choice       → tool_choice   ('auto'|'none'|'required'; {type:'function',name} → {type:'function',function:{name}})
parallel_tool_calls, temperature, top_p → unchanged
stream            → unchanged; when true also set stream_options:{include_usage:true}
store, previous_response_id, include, reasoning, text.format, truncation → see R9 below
```

`stream_options:{include_usage:true}` is **required**, not optional: without it most
OpenAI-compatible relays omit `usage` from the stream entirely and every translated request would
record as `incomplete` with zero tokens. This is the single most likely silent-billing-bug in the
whole task.

### Reasoning items are dropped, deliberately (R9 tension)

Codex sends back `reasoning` items with `encrypted_content` from the previous turn. Chat
Completions has no field for them. Options considered:

1. Drop them silently.
2. Reject the request (strict R9).
3. Convert to an assistant text message.

**Chosen: drop, and log once per request.** Option 2 would make translation fail on *every* turn
after the first, i.e. the feature would not work at all — R9's purpose is to prevent silently-wrong
sessions, and dropping reasoning degrades quality without corrupting the conversation. Option 3 is
worse than dropping: it feeds the model its own encrypted blob as if it were prose. R9 is
therefore applied to *request-level* features that change semantics (`previous_response_id`,
`store:true`, hosted tools), not to reasoning items.

This is a judgement call and the one most worth the owner's review.

### Explicit rejections (R9)

Return `400` naming the field, before any upstream call, when translating:

- `previous_response_id` present → server-side state cannot be honoured by a chat relay.
- `store: true` → same.
- `tools[]` containing a non-`function` type (`web_search`, `file_search`, `computer_use`, `mcp`)
  → executes upstream; nowhere to run.

`include`, `truncation`, `text.format` and `reasoning.effort` are dropped with a log line rather
than rejected — they are hints, not semantics. (`reasoning.effort` is arguably semantic; it is
dropped because no chat-only relay accepts it and rejecting would block all reasoning models.)

Rejections happen in the **translator**, surfaced as a typed error the driver converts to a 400
Response — not thrown raw, because `failover-dispatch` treats a driver throw as a fetch failure and
would retry every key before returning a generic 502 (phase 1 finding C-1, same trap).

## Response translation, streaming (R4, R5)

Stateful line-oriented transform. Chat SSE in, Responses SSE out. Unlike phase 1 this **cannot**
be byte passthrough — the event vocabulary is different — so this driver reassembles lines like
`openai-driver.ts` does.

Synthesised ids, stable within one stream: `resp_<random>` for the response,
`msg_<random>` / `fc_<random>` per output item. Tool-call ids reuse the upstream's
`tool_calls[].id` as `call_id` when present (Codex echoes it back next turn and the relay must
recognise it), falling back to a synthesised `call_<random>`.

State machine per stream:

```
on first chunk            → response.created, response.in_progress
first text delta          → output_item.added(message), content_part.added(output_text)
each text delta           → response.output_text.delta
first tool_call delta     → (close any open text item) output_item.added(function_call)
each tool_call arg delta  → response.function_call_arguments.delta
tool_call index changes   → close current function_call item, open the next
finish_reason present     → close open item(s): output_text.done → content_part.done
                            → output_item.done  (or function_call_arguments.done)
usage seen / stream end   → response.completed  with the full response object incl. usage
upstream error mid-stream → response.failed
```

Invariants the tests must pin:

- every `output_item.added` has a matching `output_item.done`
- `output_index` increases monotonically from 0; `content_index` resets per item
- `sequence_number` increments across every emitted event
- `response.completed` is emitted exactly once and always last
- a stream that ends without `finish_reason` still gets its open items closed and a terminal event
  (otherwise Codex hangs — the failure mode named in the PRD)

Parallel tool calls: chat sends `tool_calls[]` with an `index`; each distinct index becomes its own
`function_call` output item, arguments accumulated per index.

## Usage and billing (R6)

Reuses the chat-side reconciliation rather than re-deriving it:

```
prompt_tokens, completion_tokens,
prompt_tokens_details.cached_tokens, .cache_creation_tokens,
completion_tokens_details.reasoning_tokens
   → normalizeInputTokensFromPrompt(...)   (already exported, phase 1 step 1)
   → UsageFromStream
```

`upstreamMessageId` ← the chat `id` (`chatcmpl-*`) via `normalizeUpstreamId`, same as the chat
driver. The synthesised `resp_*` id is **not** logged as the upstream message id — it is a gateway
invention and logging it would make request logs untraceable against the relay.

The `response.completed` event carries the usage in **Responses** shape (`input_tokens` /
`output_tokens` / `input_tokens_details.cached_tokens` / `output_tokens_details.reasoning_tokens`)
because that is what Codex reads; the gateway's internal `UsageFromStream` is populated in
parallel from the chat shape. Two different shapes from one source — a place where a single mapping
bug produces correct billing but a confused client, or vice versa, so both get asserted in tests.

## Route ordering (AC3)

`routes` is partitioned, passthrough first:

```ts
const passthrough = routes.filter(r => providerDeclaresResponsesEndpoint(r.providerEndpoints));
const translate   = routes.filter(r => !providerDeclaresResponsesEndpoint(r.providerEndpoints));
routes = [...passthrough, ...translate];
```

This preserves phase 1 behaviour whenever a native provider exists, and only reaches translation
as a fallback. Consequence to accept: it **overrides the admin-configured route weight/priority
order** within a group when strategies are mixed. The alternative (respect configured order, mix
strategies freely) makes behaviour depend on weights in a way the owner cannot see. Recorded as a
decision, not an oversight.

Phase 1's 502 no longer fires for "no provider declares responses" — every openai route is now
serviceable. It remains for "no openai route at all".

## Sticky routing

`buildStickyDispatchContext({… protocol:'openai'})` is unchanged from phase 1. Note that sticky
binding is keyed on user+model+routeGroup+protocol, so a user can be pinned to a *translate* route
even when a passthrough route exists. That is consistent with how sticky already overrides
ordering for chat, so no special-casing.

## Testing strategy

The PRD records a hard blocker: **no working chat-only upstream exists in this environment**
(`muyuan.do` is native-Responses and is currently 403ing every UA on both endpoints; its other
models 503). So the plan deliberately front-loads offline testing:

1. **Pure-function unit tests** for all three translators — the bulk of the work. Fixtures:
   real Codex request bodies (capturable from a local Codex run against the gateway, which works
   even if the upstream then fails) and real chat SSE captures (already available from the existing
   chat path against any working relay).
2. **Sequence-invariant tests** — feed a chat SSE fixture through the transform and assert the
   invariants listed above structurally, not by golden-string comparison. Golden strings would pass
   while emitting a sequence Codex rejects; invariants catch reordering.
3. **A local fake chat-only upstream** for an end-to-end run: a tiny Node server that speaks
   `/chat/completions` SSE, registered as a provider with `openai.base` only. This is what makes
   AC1/AC5/AC6/AC10 verifiable without the relay. It is the highest-value item in the plan and
   should not be cut.
4. **Owner-run, blocked:** the real Codex-against-a-real-chat-relay criterion. Cannot be faked;
   state it as outstanding rather than claiming it.

Every new test file gets registered in `packages/proxy/package.json` `test:unit` in the same step
that creates it — 10 of this repo's proxy test files import `vitest`, which is not a dependency
anywhere, and never ran; one of them (`upstream-failure-classifier.test.ts`) was only discovered
and fixed today in `07-27-upstream-403-classify`.

## Out of scope

As `prd.md`. Plus: no attempt to make reasoning survive translation, and no dedicated
`request_protocol` value (still `'openai'`, deferred from phase 1).

## Decisions needing owner review

1. **Reasoning items dropped, not rejected** — degrades multi-turn reasoning quality on chat-only
   relays. The alternative is the feature not working at all.
2. **Passthrough-first ordering overrides configured route order** when a group mixes strategies.
3. **`reasoning.effort` dropped rather than rejected** — reasoning models will run at the relay's
   default effort.
4. **`stream_options:{include_usage:true}` injected** into every translated streaming request.
   Harmless on compliant relays; a strict one could reject an unknown field.
