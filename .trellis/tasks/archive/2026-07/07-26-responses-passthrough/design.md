# Design — phase 1: `/v1/responses` ingress + native passthrough

Parent: `07-26-responses-api`. This phase makes Codex CLI work against upstreams that already speak the Responses API. Translation for chat-only relays is phase 2 (`07-26-responses-translate`).

## Shape

```
Codex CLI ──POST /v1/responses (SSE)──▶ proxy
                                        ├─ requireApiKey            (unchanged)
                                        ├─ model route resolution   (unchanged, filtered to openai)
                                        ├─ failover dispatch        (unchanged orchestration)
                                        │    └─ NEW dispatchOpenAiResponsesRoute
                                        │         └─ upstream POST <base>/responses
                                        └─ recordUsage              (new usage parser)
```

Everything except the two "NEW" boxes is existing machinery. The point of this phase is to add a protocol surface, not a parallel pipeline — auth, budget, rate limiting, sticky routing, failover, circuit breaking, logging and billing all come from the same code the chat path uses.

## Verified against a real upstream (2026-07-26)

Probed `https://muyuan.do/v1/responses` (a new-api style relay the owner already uses) with `gpt-5.6-sol`. These are measurements, not assumptions:

**Streaming works.** Full SSE sequence for a trivial turn:
```
response.created → response.in_progress → response.output_item.added
→ response.content_part.added → response.output_text.delta
→ response.output_text.done → response.content_part.done
→ response.output_item.done → response.completed
```

**Usage lives on `response.completed`** and is shaped differently from Chat Completions — different field names, with cache and reasoning nested:
```json
{"input_tokens":4388,
 "input_tokens_details":{"cache_write_tokens":0,"cached_tokens":3840},
 "output_tokens":5,
 "output_tokens_details":{"reasoning_tokens":0},
 "total_tokens":4393}
```
Note `prompt_tokens`/`completion_tokens` do not exist here; a dedicated parser is required (see Usage below).

### Two findings that change the design

**1. Client identity must be forwarded.** This relay gates on the caller: plain `curl` gets `403 channel:client_restricted`. It accepts either a `User-Agent` containing `codex_cli_rs` **or** an `originator: codex_cli_rs` header (OR, not AND). If the gateway replaces Codex's identity with its own, such providers reject the request.

The driver therefore must **not** overwrite `User-Agent`, and must forward `originator`.

**Precedence (owner requirement): a provider-configured `User-Agent` wins over the caller's.** Verified this needs no new machinery:

- `user-agent` and `originator` are **not** in `CUSTOM_HEADERS_DENYLIST` (`provider-custom-headers.ts:26-34` — only `authorization`, `x-api-key`, `anthropic-version`, `content-type`, `content-length`, `host`, `connection`), so both are already configurable per provider.
- No existing egress driver sets `User-Agent`, so there is no conflict to unwind.
- `mergeUpstreamHeaders(base, custom)` returns `{...custom, ...base}` — **base wins**. So the driver must put the *caller's* UA in `custom`-priority position, not `base`, or the provider override would be ignored.

Concretely, resolution order for `User-Agent` / `originator`:

1. provider `custom_headers` value, if configured → wins
2. otherwise the caller's (Codex's) header, forwarded as-is
3. otherwise absent — do not synthesise a gateway UA, which is what triggers `403 channel:client_restricted`

Implementation note: because `mergeUpstreamHeaders` lets `base` win, the forwarded caller identity must be seeded into the `custom` side (or merged before that call), never into `base`. Getting this backwards silently disables the provider override — cover it with a unit test asserting both directions.

**2. Passthrough is not merely simpler — it is required.** This relay **injects Codex's own system prompt server-side**: a request carrying only `input: "say ok"` came back with `instructions` set to the full "You are Codex, a coding agent based on GPT-5…" text, and `input_tokens` of 4388 for a two-word input. Any rewriting or protocol translation would corrupt that behaviour. Treat the body as opaque apart from the fields routing needs.

## Capability declaration: explicit only (no base derivation)

`'responses'` joins `ProviderEndpointCapability` and `OPENAI_ENDPOINT_CAPABILITIES`
(`packages/core/src/provider-endpoints.ts`).

**There is deliberately NO `${root}/responses` derivation from `base`.** Verified reason:
`listConfiguredCapabilities` returns *every* capability of a protocol as soon as `cfg.base`
is set:

```ts
const all = CAPABILITIES_BY_PROTOCOL[protocol];
if (cfg.base) return [...all];
```

**Verified count**: Ten of the 42 shipped presets in `packages/admin/lib/provider-import-presets.json` set
`openai.base` (Zhipu GLM, Z.AI GLM International, OpenAI, Google Gemini OpenAI-compat, xAI,
Together AI, Azure OpenAI, OpenRouter, ZenMux, SiliconFlow); the other 32 use per-capability
URLs. Several of those ten do not serve `/responses` at all — Azure requires an
`?api-version=` query, and the Gemini-compat and SiliconFlow surfaces have no such route.
With a `base` derivation all ten would be reported capable, the R5 gate could never fire,
and the user would get an opaque upstream 404 instead of a clear configuration error.

`resolveUpstreamEndpoint`'s switch ends in `const _exhaustive: never = capability`, so adding
the capability **forces** a case. That case throws:
`responses requires an explicit endpoints.openai.endpoints.responses URL`.

**Gate helper** — new exported function in `provider-endpoints.ts`, used by the route (R5) and
later by phase 2's passthrough-vs-translate decision. It must NOT go through
`listConfiguredCapabilities`:

```ts
export function providerDeclaresResponsesEndpoint(map: ProviderEndpointsMap): boolean {
	return Boolean(map.openai?.endpoints?.responses);
}
```

Consequence to accept and document: admin capability badges (which do use
`listConfiguredCapabilities`) will show `responses` for any `base`-configured provider. The
badge over-reports; the runtime gate is authoritative. Fixing the badge properly is out of scope (see below) here.


## Ingress route

`packages/proxy/src/routes/v1/responses.ts`, mounted at `/v1/responses` in `app.ts`, mirroring
`routes/v1/chat.ts`. The order below is not optional — **`providerEndpoints` does not exist until
`resolveRouteResultsFromRows` has run** (it is parsed there, `services/model-router.ts:71`, into the
field declared at `:27`). Filtering route *rows* on capability would always yield an empty list and
502 every request.

Exact sequence, copied from `chat.ts:104-134`:

1. `requireApiKey` middleware (already applied via `responsesRoutes.use('*', requireApiKey)`).
2. In-route budget check — `chat.ts:104-106`. Required because `/v1/responses` must be added to the
   exemption list in `middleware/auth.ts` (see the decision on budget exemption below).
3. Read `model` from the body; `resolveModelRouting` → `baseModelId`, route group.
4. `getActiveModelRouteRows(repos, baseModelId)` → raw rows.
5. `selectActiveRouteRows(rows, explicitGroup)` → still raw rows; empty ⇒ 400.
6. **`resolveRouteResultsFromRows(repos, selectedRows)` → `RouteResult[]`.** Only now is
   `providerEndpoints` populated.
7. `routes.filter((r) => r.upstreamProtocol === 'openai')` — same as `chat.ts:125`.
8. `routes.filter((r) => providerDeclaresResponsesEndpoint(r.providerEndpoints))`, logging each
   skip with `providerId` (mirroring `failover-dispatch.ts:237`). Empty ⇒ 502 naming the providers.
9. `buildStickyDispatchContext({ stickyConfigRaw, userId, baseModelId, routeGroup, protocol: 'openai' })`
   — **not automatic**; every other route builds it (`chat.ts:159`, `messages.ts:151`). Omitting it
   silently disables sticky routing and breaks R6. Note the consequence of `protocol: 'openai'`:
   Responses traffic shares sticky bindings with chat traffic on the same model × group.
10. `maybeBlockSensitiveContentCircuit` before dispatch and
    `maybeTriggerSensitiveContentCircuitFromUpstream` after (`chat.ts:146` and `:176`), passing
    `circuit_events` / `suppress_error_alert` into `recordUsage` (`chat.ts:267-268`).
11. `timing.markGatewayComplete()` immediately before the proxy call (`chat.ts:166`).
12. `proxyResponses(...)` → `failoverDispatchWithKeyPool` → new driver.
13. `materializeNonOkResponse`, then the `usageOrSafety` race and
    `scheduleBackgroundWork(c, ...)` tail, mirroring `chat.ts:194-276`.

`incomplete` is derived as `!hasUsage(usage)`. `hasUsage` is a module-local in `chat.ts:66-69` and is
**not exported** — reimplement the same predicate locally in the Responses route (input, output and
cache totals all zero ⇒ no usage). Getting this wrong makes R8 and the `incomplete`-after-timeout
criterion pass vacuously.

## New egress driver

`services/egress/openai-responses-driver.ts`, modelled on `openai-driver.ts` but **byte-passthrough** (see the SSE section).

Responsibilities:
- Resolve URL via `resolveUpstreamEndpoint('openai', 'responses', …)`.
- Build the upstream body: `{...buildRouteRequestBody(route, body), model: route.providerModelName}` — **in the driver**, matching `openai-driver.ts:429-432` (NEW-3).
- Headers: `Content-Type` + `Authorization` as base; provider custom headers and forwarded client identity on the custom side (see Client identity).
- Do **not** pass `requestSignal` to `fetch` — the drain depends on the upstream staying readable after client disconnect (M3, matches `openai-driver.ts:434-444`).
- Timing: only the driver-owned marks (see Timing ownership).
- Parse usage from the terminal event and resolve `usagePromise`.

Non-streaming (`stream:false`) is handled for completeness but is **optional** — Codex always streams. It must not grow its own test matrix.

## Project conventions this must obey

From `.trellis/spec/proxy/backend/`:

**Runtime neutrality (hard rule).** No `process.env`, no `node:*`, no Worker-only globals outside `src/runtime/`. Config exclusively via `readProxyEnv(bindings, key)`. The same `src/` runs on Workers and Node.

**All upstream I/O in an egress driver.** No `fetch` to a provider from a route or service.

**Persistence only through core repositories** (`c.get('repositories')`).

**Timing.** See Timing ownership below — the driver marks a strict subset.

**Billing is background work.** `scheduleBackgroundWork(c, …)`, matching `routes/v1/chat.ts`.

**Logging.** Bracket-tag prefix (`[Gateway Responses]`), never log keys or prompt content. Redaction via a new Responses-shaped helper (I3).

**Colocated tests** registered into `test:unit` **in the same step that creates them** (M1 — two existing driver tests are unregistered and never run).

**Test runner is `node:test` via `tsx --test`.** Do not copy `gemini-driver.test.ts` — it imports `vitest` and does not run (NEW-7).

**Indentation: match the file being mirrored.** `routes/v1/chat.ts` and `services/egress/openai-driver.ts` use 2 spaces despite `.editorconfig`; `services/proxy.ts` and `failover-dispatch.ts` use tabs (M2).

## SSE forwarding: byte passthrough (C4, resolved)

**Decision: forward upstream bytes unchanged. No line reassembly, no re-serialisation.**

The chat pump (`openai-driver.ts:288-301`) decodes → splits on `\n` → rewrites each line → re-encodes, because it must strip mid-stream cumulative usage for SDKs that re-accumulate. Two reasons that is wrong here:

1. **No mid-stream usage to strip.** Measured: only `response.completed` carries usage (table below). `transformStreamUsageForClient` is chat-shaped and would corrupt Responses frames.
2. **Codex is frame-sensitive.** Reassembly mutates the tail (`.trim()` at `openai-driver.ts:271-276`) and changes framing for multi-line SSE. A malformed frame makes Codex hang rather than error.

Precedent exists: `anthropic-driver.ts:175` and `gemini-driver.ts` write raw `value` through.

**Therefore: do NOT extract a shared pump from `openai-driver.ts`.** That was an earlier decision in this plan and it is retracted. Rationale for the retraction:

- The chat pump's whole reason to exist is line-level rewriting; a byte-passthrough driver needs none of it.
- `POST_DISCONNECT_DRAIN_MS = 90_000` is already duplicated **three** times (`openai-driver.ts:37`, `anthropic-driver.ts:22`, `gemini-driver.ts:22`). Extracting would consolidate 2 of 4, not "the" pump.
- **No existing test exercises any pump** (grep for `pumpWithUsageTracking|streamResponseWithUsage` across `*.test.ts` → nothing). So "chat tests still green" is a near-vacuous safety gate for refactoring the chat hot path. Touching it risks the "no regression to `/v1/chat/completions`" constraint with no test to catch a break.

The new driver instead follows the **anthropic driver's** pump shape (byte passthrough + drain + terminal-event usage sniffing), which is the closer model. Accept a 4th copy of the drain constant; note it as known debt for a separate cleanup task.

The driver still needs to *observe* frames to find usage — it sniffs the decoded text for the terminal event while forwarding the original bytes, never rewriting what it forwards.

## Terminal event and usage location (I12)

Wire shape (measured):

```
event: response.completed
data: {"type":"response.completed","response":{ … ,"usage":{…}}}
```

Usage is at **`data.response.usage`**, not top level. The chat pattern (`parsed.usage`, `openai-driver.ts:178`) reads `undefined` on every Responses frame — every request would bill zero and log `incomplete`.

Parser contract (`services/egress/openai-responses-usage.ts`):
- On any `data:` line, `JSON.parse` defensively (ignore parse failures — partial frames are normal).
- Read `data.response.usage`; ignore null.
- **Last non-null wins** (defensive: tolerates an upstream that emits cumulative usage mid-stream even though the measured one does not).
- Terminal types: `response.completed` | `response.incomplete` | `response.failed`. Treat `response.error` as terminal-failed. `response.queued` / `response.in_progress` are not terminal.
- `upstream_message_id` from `data.response.id` (`resp_*`) via `normalizeUpstreamId` (I11).
- Stream ends with no usage → route records `incomplete` through the existing safety path, never silently bills zero.

## Billing correctness (I5 + I6)

**Retraction (I6).** An earlier draft of this plan said mis-parsing `reasoning_tokens` under-bills. **That is false.** `computeMeteredCost` (`services/usage-tracker.ts:42-73`) takes only `input_tokens`, `cache_read_tokens`, `cache_write_tokens`, `output_tokens`. `reasoning_tokens` is persisted for reporting only. An implementer acting on the wrong claim might add reasoning into output and **double-bill**.

**The real risk (I5): cache-inclusive vs cache-exclusive input tokens.**

`usage-tracker.ts:53` computes `regularInput = input_tokens - cache_read_tokens - cache_write_tokens`. The chat path survives only because `normalizeInputTokensFromPrompt` (`openai-driver.ts:69-98`) reconciles the two upstream conventions first.

Measured sample: `input_tokens: 4388`, `cached_tokens: 3840`. If that 4388 is cache-**exclusive** and we pass it through, billing computes `4388 − 3840 = 548` — **87% under-billed**.

Required: reuse the same normaliser rather than re-deriving it. Extract `normalizeInputTokensFromPrompt` into `services/egress/openai-usage-normalize.ts` (a small, test-covered pure function — unlike the pump, this extraction is low-risk) and unit-test **both** conventions against the measured numbers.

Field mapping: Responses nests cache under `input_tokens_details.{cached_tokens,cache_write_tokens}` and reasoning under `output_tokens_details.reasoning_tokens` — different names from chat's `prompt_tokens_details`, so the mapping is genuinely new code even though the normaliser is shared.

## Route-level gating, not driver-level throwing (I7 + I8)

**I7 — filter, don't reject.** A model may have several routes where only some providers declare `responses`. Rejecting on the first incapable route would kill the whole model and disable failover. Filter incapable routes out (log the skip with `providerId`, mirroring `failover-dispatch.ts:237`) and return 502 only when the filtered list is empty.

This must happen **in the route**. If `resolveUpstreamEndpoint` throws inside the driver, `failover-dispatch.ts:346` catches it as a fetch failure, burns one attempt per key of that provider, and returns a generic `{"error":"Upstream request failed"}` — the opposite of R5's clear error.

**I8 — a UA-gated 403 trips circuit breakers on every key.** `upstream-failure-classifier.ts:34` maps 401/403 to `{action:'retry_key', alertOnKeySwitch:true, failureKind:'auth'}`. So one UA-misconfigured request walks every key of the provider, opens an `auth` circuit on each, and fires an error webhook per key — a request-identity fault charged to the keys.

Phase 1 does **not** change the classifier (that would affect all protocols). Accepted as a known deviation, with a PRD acceptance criterion that the no-capability path is gated *before* dispatch so the common misconfiguration cannot reach the classifier at all.

## Request-log redaction: new helper required (I3)

`openAiBodyRedactedForLog` (`routes/v1/chat.ts:37-53`) drops `messages`/`input`/`prompt`/`data`. On a Responses body that leaves **`instructions` intact** — for Codex, the entire system prompt — violating `logging-guidelines.md` ("never log request bodies with prompt content"), and `_messages_count` is never emitted.

New `responsesBodyRedactedForLog`: drop `input`, `instructions`, `prompt`; emit `_input_count`; and route `tools` through
`summarizeOpenAiToolsForLog` exactly as `chat.ts:43-46` does from `body.input.length` when it is an array.

`summarizeOpenAiToolsForLog` **is** safe to reuse — its `typeof t.name === 'string'` fallback already handles the flattened Responses tool shape.

`upstream_request_body` must serialise what the driver actually sends (post-`buildRouteRequestBody`, post-model-mapping), mirroring `openAiUpstreamWireBodyForLog` — otherwise the log lies (I10).

## Timing ownership (I1)

The driver marks **only**: `markAttemptHeaders`, `markFirstByte`, `markFirstEvent`, `markFirstReasoningToken`, `markFirstToken`, `markStreamComplete`.

`failover-dispatch.ts` owns `markUpstreamDispatchStart` (:234), `markAttemptError` (:347), `markAttemptFailover` (:348, :421), `markFinalAttempt` (:362, :388, :438). A driver that also calls these **double-counts `upstreamFailoverCount` and mis-sets `selected`**.

The route calls `markGatewayComplete()` immediately before dispatch (I2) — without it `gatewayOverheadMs` is null.

For Responses, `markFirstEvent` fires on the first `response.*` frame; `markFirstToken` on the first `response.output_text.delta`; `markFirstReasoningToken` on the first reasoning-item delta if the upstream emits one.

## Decisions recorded

**`request_protocol` = `'openai'`** (I4). Adding a new value would touch `UpstreamProtocol` (`packages/core/src/upstream-protocol.ts:5`), which drives route filtering — too invasive for phase 1. All three schemas store it as free text, so no migration either way. **Cost, accepted:** Responses traffic is indistinguishable from chat in admin analytics filters. Revisit in phase 2 with a dedicated field.

**Budget-exceeded behaviour** (I9). `middleware/auth.ts:92-105` exempts `/me`, `/models`, `/chat/completions`, `/images/*` from the up-front 403. `/v1/responses` is **not** added to that list in phase 1 — a budget-exceeded key gets 403 before model resolution. Consequence, accepted: an unknown model returns 403 where chat returns 404. No redundant in-route check.

**Route `custom_params` apply** (I10). `buildRouteRequestBody(route, body)` runs, so admin per-route default params work for Responses as they do for chat. R2's "verbatim" means "no protocol translation or prompt rewriting", not "no route defaults".

**Usage parser lives in proxy, not core** (NEW-2). It maps into `UsageFromStream`, declared in `packages/proxy/src/services/proxy.ts:26`, and uses `normalizeUpstreamId` from `packages/proxy/src/services/egress/`. `packages/core` does not (and must not) depend on `@octafuse/proxy` — dependency direction is proxy → core.

## Route parity checklist (C-1, I-1, I-2, I-4)

The route must mirror `routes/v1/chat.ts` step for step. Deviating silently disables a feature.
Verified call order in `chat.ts:104-176`:

| # | Call | Why it matters here |
|---|---|---|
| 1 | budget check (`apiKey.budgetMax`) | `/v1/responses` is NOT in the `middleware/auth.ts` exemption list, so decide: add it there and check in-route (chat parity), or accept a pre-resolution 403. Recorded decision: **add to the exemption list**, check in-route, so an unknown model returns 404 not 403. |
| 2 | `getActiveModelRouteRows(repos, baseModelId)` | **Omitted in an earlier draft.** |
| 3 | `selectActiveRouteRows(rows, explicitGroup)` | returns raw rows — `providerEndpoints` does NOT exist yet |
| 4 | `resolveRouteResultsFromRows(repos, selectedRows)` | **this** is where `parseProviderEndpoints` runs (`model-router.ts:71`) and populates `RouteResult.providerEndpoints` (`:27`) |
| 5 | `.filter(r => r.upstreamProtocol === 'openai')` | chat parity |
| 6 | `.filter(providerDeclaresResponsesEndpoint)` | **new gate — must run here, on `RouteResult[]`, never on rows** |
| 7 | `buildStickyDispatchContext({... protocol:'openai'})` | **not automatic.** `failover-dispatch.ts:272` only honours `options.sticky`; every other route builds it (`chat.ts:159`). Omit it and R6's "sticky reused" is false. Note: `protocol:'openai'` means Responses shares sticky bindings with chat on the same model × group. |
| 8 | `maybeBlockSensitiveContentCircuit` | see I-2 section |
| 9 | `timing.markGatewayComplete()` | `chat.ts:166` — without it `gatewayOverheadMs` is null |
| 10 | `proxyResponses(...)` | |
| 11 | `maybeTriggerSensitiveContentCircuitFromUpstream` | see I-2 section |
| 12 | `materializeNonOkResponse` → `usageOrSafety` race → `scheduleBackgroundWork(recordUsage)` | mirror `chat.ts:194-276`, including `circuit_events` and `suppress_error_alert` |

**Gate order matters (C-1).** Running the capability filter before step 4 filters objects whose
`providerEndpoints` is undefined → the list always empties → **every request 502s**. This was the
single most likely way to ship a completely non-functional route.

**`incomplete` derivation (I-4).** `chat.ts:66-69` defines a module-local `hasUsage(u)` — it is
**not exported**. The Responses route needs its own equivalent (usage is `incomplete` when neither
`input_tokens` nor `output_tokens` was observed) and passes `incomplete: !hasUsage(u)` into
`computeRequestLogStatus`. Getting this wrong silently breaks R8 and the timeout criterion.

## Files

| File | Change |
|---|---|
| `packages/proxy/src/services/egress/openai-driver.ts` | **one-word change**: `export` on `normalizeInputTokensFromPrompt`. No logic moves. |
| `packages/proxy/src/middleware/auth.ts` | add `/v1/responses` to the budget-exemption list (route checks budget itself) |
| `packages/core/src/provider-endpoints.ts` | add `'responses'` to the capability union + `OPENAI_ENDPOINT_CAPABILITIES`; **throw** in the `resolveUpstreamEndpoint` switch (no base derivation); add `providerDeclaresResponsesEndpoint(map)` |
| `packages/core/src/provider-endpoints.test.ts` | **update two existing assertions** at :102 and :131 that hard-code the three-capability list (NEW-1), plus new cases |
| `packages/proxy/src/routes/v1/responses.ts` | **new** ingress route + `responsesBodyRedactedForLog` |
| `packages/proxy/src/app.ts` | mount `/v1/responses` |
| `packages/proxy/src/services/proxy.ts` | `proxyResponses` wrapper, closing over body **and** client-identity headers |
| `packages/proxy/src/services/egress/openai-responses-driver.ts` | **new** byte-passthrough driver |
| `packages/proxy/src/services/egress/openai-responses-usage.ts` (+ test) | **new** terminal-event usage parser |
| `packages/proxy/package.json` | register both new tests in `test:unit` |
| `packages/admin/app/gateway/providers/types.ts` | `ProviderCapabilityBadge`, `ProtocolEndpointForm`, `EMPTY_PROTOCOL_FORM` |
| `packages/admin/app/gateway/providers/provider-utils.ts` | `capabilityDisplayBadges`, `protocolFormFromConfig`, `configFromProtocolForm` |
| `packages/admin/app/gateway/providers/components/provider-modal.tsx` | endpoint field + `capLabels` |
| `packages/admin/messages/{en,zh,ja,ko}.json` | **two** namespaces: `providers.modal.capResponses` *and* `providers.card.cap.responses` (NEW-6) — a missing key renders raw |

Explicitly **not** changed: `failover-dispatch.ts` (`DispatchFn` is protocol-agnostic, `expectedProtocol:'openai'` already matches), `openai-driver.ts` pump, `upstream-failure-classifier.ts`, any migration.

**Admin badge derivation (NEW-6).** `capabilityDisplayBadges` is an allowlist, so today an unmapped capability renders nothing. Adding `responses` to it is what would create over-reporting for `base`-configured providers. Therefore derive the `responses` badge from `endpoints.responses != null`, not from `listConfiguredCapabilities` — one line, in scope, keeps the badge honest.

## Client identity plumbing (C2 + C3)

**The driver cannot read the request.** `DispatchFn` (`failover-dispatch.ts:101-106`) is `(route, requestSignal?, timing?, attempt?)` — no Context, no headers. Reading `c.req.raw.headers` from `services/egress/` would break the layering `directory-structure.md` mandates.

**Plumbing:** the route extracts identity headers and passes them to `proxyResponses`, which closes over them exactly as it closes over `body`:

```ts
// route
const clientIdentity: Record<string, string> = {};
const ua = c.req.header('user-agent');
if (ua) clientIdentity['user-agent'] = ua;
const originator = c.req.header('originator');
if (originator) clientIdentity.originator = originator;
```

**Case collision makes naive merging silently wrong.** Provider custom headers keep admin-typed casing (`User-Agent`); `c.req.header()` yields lowercase (`user-agent`). Both survive `{...custom, ...base}` as distinct object keys, and `new Headers(record)` **appends**:

```
new Headers({'user-agent':'codex_cli_rs/0.144.6','User-Agent':'myprovider/1.0'}).get('user-agent')
→ "codex_cli_rs/0.144.6, myprovider/1.0"     // measured
```

So the provider override does not win — it concatenates, and a UA-gated relay may reject the combined value. A unit test on `mergeUpstreamHeaders`'s plain object cannot see this.

**Required:** drop any forwarded identity key whose lowercase form already exists in `route.providerCustomHeaders` (case-insensitive), then merge:

```ts
function withClientIdentity(
  custom: Record<string, string> | null | undefined,
  identity: Record<string, string>
): Record<string, string> {
  const taken = new Set(Object.keys(custom ?? {}).map((k) => k.toLowerCase()));
  const out: Record<string, string> = { ...(custom ?? {}) };
  for (const [k, v] of Object.entries(identity)) {
    if (!taken.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}
```

Then `mergeUpstreamHeaders(base, withClientIdentity(route.providerCustomHeaders, clientIdentity))`.

**Precedence:** provider custom header > forwarded caller header > absent. Never synthesise a gateway UA — that is what triggers the 403.

**Tests must assert through `Headers`**, not the record: `new Headers(merged).get('user-agent')`. Include the mixed-case case (provider `User-Agent`, caller `user-agent`).

## Streaming and billing mechanics (from `error-handling.md`)

The route mirrors `routes/v1/chat.ts` (the `materializeNonOkResponse` → `usageOrSafety` → `scheduleBackgroundWork` region):

- `USAGE_SAFETY_TIMEOUT_MS` (5 min) bounds the wait when a stream never yields usage; on timeout record `incomplete` and `timing.markStreamComplete()`.
- `POST_DISCONNECT_DRAIN_MS` (90 s) keeps draining upstream after client disconnect to capture trailing usage. **Codex cancels mid-turn often**, so this path is hot, not exotic.
- Classify non-OK upstream responses via `upstream-failure-classifier.ts` — never treat every non-200 as fatal.
- `computeRequestLogStatus({cancelled, responseOk, incomplete})` for the final status; `materializeNonOkResponse` to capture an error body for the log.

## Measured: mid-stream usage (pre-check, resolved)

`muyuan.do`, `gpt-5.6-sol`, streaming, 12 events, no tools:

| event | top-level `usage` | `response.usage` |
|---|---|---|
| `response.created` | null | null |
| `response.in_progress` | null | null |
| `response.output_item.added` | null | null |
| `response.content_part.added` | null | null |
| `response.output_text.delta` ×5 | null | null |
| `response.output_text.done` | null | null |
| `response.content_part.done` | null | null |
| `response.output_item.done` | null | null |
| **`response.completed`** | null | **totals** |

**Evidence boundary — do not over-generalise.** One relay, one model, one tool-free turn. Not verified: OpenAI direct, reasoning-heavy turns, tool-call turns, `response.incomplete`/`failed`. The parser contract above is deliberately defensive (last-non-null-wins, any-event scan) so a different upstream needs no rework.

### Second capture: WITH a tool call (2026-07-26, same relay)

A tool-calling turn produces a **completely different event set** — no `output_text.*` at all:

| event | count | usage |
|---|---|---|
| `response.created` | 1 | null |
| `response.in_progress` | 1 | null |
| `response.output_item.added` | 1 | null |
| `response.function_call_arguments.delta` | 5 | null |
| `response.function_call_arguments.done` | 1 | null |
| `response.output_item.done` | 1 | null |
| `response.completed` | 1 | **`data.response.usage`** |

Two conclusions that validate the parser contract:

1. **Event-type sets vary by turn kind.** A parser keyed on `output_text.delta` (or on any
   fixed event list) would silently collect nothing on tool-calling turns — which is *most*
   Codex traffic. The settled contract (scan every event for `data.response.usage`, ignore
   null, last non-null wins, tolerate unknown types) handles both captures unchanged.
2. **`markFirstToken` cannot key on `output_text.delta` alone.** On a tool-only turn the
   first content signal is `response.function_call_arguments.delta`. Treat any
   `response.*.delta` as the first-token signal, otherwise TTFT is null for tool turns
   (which would fail the timing acceptance criterion on exactly the traffic that matters).

`0b` (OpenAI-direct capture) was not obtainable — no OpenAI-direct key is configured on this
instance, and the plan marks it non-blocking. This tool-call capture is the substituted
evidence: it varies the dimension that actually mattered (event-type set), not the vendor.

## Risks

**SSE fidelity is the top risk and cannot be unit-tested.** Codex is an interactive client; a subtly wrong frame makes it hang rather than error. Byte passthrough minimises the surface, but the real gate is a live Codex session with tool calls (owner-run).

**Under-billing via cache-token convention (I5).** Mitigated by reusing the normaliser and testing both conventions.

**UA-gated 403 blast radius (I8).** Documented above; mitigated by pre-dispatch gating.

**Evidence is single-source.** All wire measurements come from one relay. Anything OpenAI-direct-specific may still surprise us; the defensive parser is the hedge.

## Rollout

Nothing changes for existing traffic until a provider gets an explicit `endpoints.openai.endpoints.responses` value. `/v1/responses` returns a clear 502 until then. Chat, messages, gemini and images paths are untouched **behaviourally**. Precise claim about
`openai-driver.ts` (finding X-1 caught an overstatement here): its only change is adding the
`export` keyword to the existing `normalizeInputTokensFromPrompt` (:69-98). No logic moves, no
line inside it changes, and the chat pump/dispatch path is not touched. Do NOT restate this as
"`openai-driver.ts` is not modified at all" — that was false while step 1 relocated the function.

## Out of scope (phase 2)

Responses ↔ Chat translation for relays that only speak `/chat/completions`; `previous_response_id` / server-side state; hosted tools (`web_search`, `file_search`, `computer_use`); MCP passthrough; a dedicated `request_protocol` value.

### Why `tools` needs explicit handling

`chat.ts:43-46` deliberately routes `tools` through `summarizeOpenAiToolsForLog` so full JSON
schemas stay out of `api_key_request_logs`. A redactor that only drops `input`/`instructions`/
`prompt` writes **every Codex tool schema** into the log — and the acceptance criterion as first
written (no `input`/`instructions`/`prompt`) would not catch it. The criterion now names `tools`.

## Sensitive-content circuit (I-2): included, not skipped

Every other protocol route wires both halves and passes the events into `recordUsage`:
`chat.ts:146` (`maybeBlockSensitiveContentCircuit`, before dispatch) + `chat.ts:176`
(`maybeTriggerSensitiveContentCircuitFromUpstream`, after) + `chat.ts:267-268`
(`circuit_events`, `suppress_error_alert` into the usage row).

An earlier draft of this plan silently omitted it. That would have been a real behavioural gap,
not a simplification: a route pre-blocked for sensitive content would still be dispatched for
Responses traffic. **Include both halves and both `recordUsage` fields**, mirroring chat.

## Usage parsing contract — settles C-2 / C-3 / C-4

Three artefacts previously disagreed. One contract, stated once, wins:

### Streaming

Scan **every** `data:` line. For each, `JSON.parse` and read `data.response.usage`.
Ignore `null`/absent. **Last non-null wins.** Same for `data.response.id` → `upstream_message_id`.

Do **not** gate parsing on the event type. The measured capture (12 events) had usage only on
`response.completed`, but the parser must not depend on that: an upstream that also reports on
`response.incomplete` / `response.failed` must still bill. "Last non-null wins" handles all of
these with no type list.

**The terminal-event type list is therefore dead logic and is removed** (C-3). Nothing in this
task branches on event type. `usagePromise` resolves in the pump's `finally`
(`anthropic-driver.ts:194-195`), exactly as the other drivers do — not on a sniffed terminal frame.
This also means no text sniffing is needed in the forward path, which keeps byte passthrough clean.

### Non-streaming (`stream:false`)

**Different JSON path.** The body *is* the response object:

| | streaming | non-streaming |
|---|---|---|
| usage | `data.response.usage` | `body.usage` |
| id | `data.response.id` | `body.id` |

Reusing the streaming path here yields zero usage and a null id (C-4). The parser therefore
exposes two entry points over one shared field-mapping core:
`parseResponsesUsageFromStreamLine(line)` and `parseResponsesUsageFromBody(body)`.

Non-streaming is **not** optional — the PRD's first acceptance criterion tests it. Both entry
points get unit tests.

### No mid-stream stripping (settles R10)

Byte passthrough means nothing is ever rewritten, so there is no strip step and
`transformStreamUsageForClient` is not reused. R10's original wording ("stripped as the chat path
does") was written before the passthrough decision and is **retracted**.

What replaces it: the measured Responses upstream emits usage only on the terminal frame, so
there is nothing cumulative for a client SDK to double-count. If a future upstream *does* emit
cumulative usage mid-stream, byte passthrough forwards it verbatim and the client SDK sees exactly
what the upstream sent — which is the correct behaviour for a transparent proxy, and is what
Codex expects. Gateway-side billing is unaffected either way because last-non-null-wins converges
on the final total.

## Admin badge over-reporting (I-5): not a one-line fix, deferred deliberately

An earlier draft called this "one line, in scope". It is not.
`capabilityDisplayBadges` (`provider-utils.ts:24-35`) takes only
`readonly ProviderEndpointCapability[]` — it cannot see the endpoints map. Deriving the badge from
`endpoints.responses != null` needs a signature change plus all three call sites
(`provider-utils.ts:202`, `:219`, `:236`).

And even then it is incomplete: `ProviderProtocolSummary.capabilities` (`types.ts:47`) still comes
from `listConfiguredCapabilities` and renders as a raw joined string at `provider-card.tsx:127-130`
and `provider-import-modal.tsx:211-212`, so `responses` would still over-report there for every
`base`-configured provider.

**Decision:** accept the cosmetic over-report for the 10 `base`-configured presets. It is display
only — the functional gate is `providerDeclaresResponsesEndpoint`, which reads
`endpoints.responses` and is unaffected. Note it in the task's follow-ups rather than half-fixing
two of three surfaces here.
