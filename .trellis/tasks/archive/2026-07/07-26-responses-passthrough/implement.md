# Implementation plan — phase 1 (ingress + native passthrough)

Read `design.md` first. Every decision below traces to a finding recorded there;
do not re-litigate them mid-implementation.

## Step 0 — pre-checks (do these before writing code)

**0a. Mid-stream usage — DONE.** Measured against `muyuan.do`: only `response.completed`
carries usage, at `data.response.usage`. See design.md "Measured: mid-stream usage".
Evidence is single-relay; the parser contract is defensive by design.

**0b. Second-upstream confirmation — OPTIONAL, not a blocker.**
Nice to have: one streaming capture from OpenAI direct (reasoning model, one tool call)
to confirm the terminal-event shape and whether reasoning deltas appear as distinct events.
**If unobtainable, proceed** — the defensive parser (any-event scan, last-non-null-wins,
tolerant of unknown event types) is exactly the hedge for this. Record whatever you learn
back into design.md's measured table. Do NOT stall on credentials.

## Step 1 — export the input-token normaliser (one word, enables I5)

`normalizeInputTokensFromPrompt` (`services/egress/openai-driver.ts:69-98`) reconciles the two
upstream cache conventions. The Responses parser needs the same reconciliation (finding I5).

**Add the `export` keyword. Do NOT move the function** — an earlier draft relocated it to a new
`openai-usage-normalize.ts`, which contradicted the no-chat-regression claim (finding X-1). One
word, zero logic movement, zero risk to the chat path.

Then add a colocated test for the normaliser itself. This is the real gate for step 1 — no
registered proxy test exercises `openai-driver.ts` today, so `test:unit` passing proves nothing
about it. New file `services/egress/openai-usage-normalize.test.ts`, registered in
`packages/proxy/package.json` `test:unit` **in this step** (not deferred to a trailing chore —
11 of 17 proxy test files are currently unregistered and never run, and 10 of those import
`vitest`, which is not a dependency anywhere in this repo; use `node:test`).

Cases: prompt-includes-cache, prompt-excludes-cache, no cache, cache exceeding prompt.

Gate: new test green.
## Step 2 — core: declare the capability, no derivation

`packages/core/src/provider-endpoints.ts`:
- add `'responses'` to the `ProviderEndpointCapability` union and `OPENAI_ENDPOINT_CAPABILITIES`
- in `resolveUpstreamEndpoint`'s switch, the new case **throws**:
  `responses requires an explicit endpoints.openai.endpoints.responses URL (providerId=…)`.
  The switch ends in `const _exhaustive: never = capability`, so the case is compulsory —
  that guard is what makes "no silent base derivation" enforceable.
- add `providerDeclaresResponsesEndpoint(map)` reading `map.openai?.endpoints?.responses`.
  This — not `listConfiguredCapabilities` — is the gate used by the route and by phase 2.

`packages/core/src/provider-endpoints.test.ts` (already registered):
- **update the two existing assertions at :102 and :131** that hard-code
  `['chat','images.generations','images.edits']`. Adding the capability breaks them
  because `listConfiguredCapabilities` returns all capabilities when `base` is set (NEW-1).
- new cases: explicit template resolves; `base`-only throws; `providerDeclaresResponsesEndpoint`
  true only with an explicit template.

Gate: `npm run test:unit -w @octafuse/core` and `typecheck -w @octafuse/core` green.

## Step 3 — usage parser (in proxy, not core)

`packages/proxy/src/services/egress/openai-responses-usage.ts`.

**It must live in proxy** (NEW-2): it maps into `UsageFromStream`, declared in
`packages/proxy/src/services/proxy.ts:26`, and uses `normalizeUpstreamId` from
`services/egress/upstream-request-id.ts`. `packages/core` does not depend on
`@octafuse/proxy` and must not — dependency direction is proxy → core.

Contract per design.md "Terminal event and usage location":
- scan `data:` lines, parse defensively, read `data.response.usage`, ignore null, last non-null wins
- terminal: `response.completed` | `response.incomplete` | `response.failed` | `response.error`
- map `input_tokens_details.{cached_tokens,cache_write_tokens}` and
  `output_tokens_details.reasoning_tokens`
- run input tokens through the step-1 normaliser
- `upstream_message_id` from `data.response.id`

Tests (create + register in the same step): terminal event yields totals; non-terminal
frames yield nothing; truncated/garbage JSON is ignored; both cache conventions normalise
correctly; `resp_*` id extracted.

## Step 4 — egress driver (byte passthrough)

`packages/proxy/src/services/egress/openai-responses-driver.ts`.

Model it on **`anthropic-driver.ts`** (byte passthrough + drain), not `openai-driver.ts`
(line reassembly). Per design.md:

- URL via `resolveUpstreamEndpoint('openai','responses',…)`
- **body built here**: `{...buildRouteRequestBody(route, body), model: route.providerModelName}` (NEW-3)
- headers: base `Content-Type` + `Authorization`; custom side via `withClientIdentity(...)` (C3)
- **do not pass `requestSignal` to `fetch`** (M3) — the drain needs the upstream readable after disconnect
- forward raw `value` bytes; sniff decoded text only to detect the terminal event
- `POST_DISCONNECT_DRAIN_MS = 90_000` (4th copy; noted as debt in design.md)
- timing: `markAttemptHeaders`, `markFirstByte`, `markFirstEvent`, `markFirstToken`,
  `markFirstReasoningToken`, `markStreamComplete` — **nothing else** (I1)

Non-streaming branch: minimal, optional, no dedicated test matrix.

## Step 5 — `proxyResponses` wrapper

`services/proxy.ts`, mirroring `proxyChatCompletions`. Closes over **both** the body and
the client-identity headers, then calls `failoverDispatchWithKeyPool` with
`expectedProtocol: 'openai'`.

`failover-dispatch.ts` is **not modified** — `DispatchFn` is protocol-agnostic.

## Step 6 — ingress route

New `routes/v1/responses.ts`, mirroring `routes/v1/chat.ts`. **Route resolution is four calls,
not two** — an earlier draft named only two, and `providerEndpoints` does not exist until the
third, so the capability filter would have emptied every list and 502'd every request (C-1):

```
getActiveModelRouteRows(repos, baseModelId)      -> rows
selectActiveRouteRows(rows, explicitGroup)       -> rows (400 if empty)
resolveRouteResultsFromRows(repos, selectedRows) -> RouteResult[]   <- providerEndpoints appears here
routes.filter(r => r.upstreamProtocol === 'openai')
routes.filter(r => providerDeclaresResponsesEndpoint(r.providerEndpoints))  <- new gate
```

Full parity checklist with `chat.ts` — each item is load-bearing, verified present in every other
protocol route:

- [ ] `requireApiKey` + in-route budget check after model resolution, and `/v1/responses` added to
      the exemption list in `middleware/auth.ts:88-104` (I9) so an unknown model 404s rather
      than 403s.
- [ ] `timing.markGatewayComplete()` immediately before the proxy call (`chat.ts:166`) — without
      it `gatewayOverheadMs` is null (I2).
- [ ] `buildStickyDispatchContext({... protocol: 'openai'})` passed as `options.sticky`
      (`chat.ts:159`). **Not automatic** — `failover-dispatch` only honours what the route
      constructs, so omitting this silently disables sticky routing for Responses (I-1).
- [ ] `maybeBlockSensitiveContentCircuit` before dispatch and
      `maybeTriggerSensitiveContentCircuitFromUpstream` after (`chat.ts:146`, `:176`), with
      `circuit_events` / `suppress_error_alert` threaded into `recordUsage` (`chat.ts:267-268`).
      Every other protocol route does both (I-2).
- [ ] `materializeNonOkResponse` for non-OK upstream bodies.
- [ ] `usageOrSafety` race with `USAGE_SAFETY_TIMEOUT_MS`, then `computeRequestLogStatus`. The
      `incomplete` input is `!hasUsage(u)` — `hasUsage` is module-local in `chat.ts:66-69` and
      **not exported**, so copy the three-line predicate rather than importing it (I-4).
- [ ] `scheduleBackgroundWork(c, ...)` for the usage tail — never awaited before responding.
- [ ] `responsesBodyRedactedForLog` for `request_body`; `summarizeOpenAiToolsForLog(body.tools)`
      for the tools column — the redactor drops `input`/`instructions`/`prompt` but must still
      route `tools` through the summariser, or full Codex tool schemas land in the log (I-3).
- [ ] The Responses equivalent of `openAiUpstreamWireBodyForLog` (`chat.ts:60-64`) serialising
      what the driver actually sent, including `model: route.providerModelName`.
- [ ] Client identity extracted here (`c.req.header('user-agent')`, `c.req.header('originator')`)
      and passed to `proxyResponses` — the driver cannot read the request (C2).

Mount in `app.ts` next to the other `/v1` routes.

Gate: `npm run typecheck -w @octafuse/proxy`.
## Step 7 — admin UI + i18n

- `app/gateway/providers/types.ts`: `ProviderCapabilityBadge`, `ProtocolEndpointForm`, `EMPTY_PROTOCOL_FORM`
- `app/gateway/providers/provider-utils.ts`: `protocolFormFromConfig`, `configFromProtocolForm`;
  derive the `responses` badge from `endpoints.responses != null`, **not** from
  `listConfiguredCapabilities` (NEW-6 — otherwise every `base`-configured provider over-reports)
- `components/provider-modal.tsx`: endpoint field + `capLabels`
- **`messages/{en,zh,ja,ko}.json` — two namespaces** (NEW-6):
  `providers.modal.capResponses` AND `providers.card.cap.responses`.
  The card renders via `t('cap.' + badge)`; a missing key renders the raw key in the UI.

## Step 8 — docs

`docs/developers/api/user.md` (endpoint list + budget-403 rule), `docs/users/connect-clients.md`
(Codex `config.toml` snippet), `.trellis/spec/proxy/backend/directory-structure.md`
(new route + driver files). Add a changeset (repo uses changesets + `verify:package-versions` in CI).

## Validation

Automated (I run these):
- `npm run typecheck` for core, proxy, admin
- `npm run test:unit` for core, proxy, admin — all green, new tests registered and actually running
- `npm run lint -w @octafuse/admin` — no new errors
- `npx wrangler deploy --dry-run` for proxy — the only check that the Worker bundle builds
  (M6: `test:unit` is Node-only and `build:cf` is admin-only, so neither covers runtime neutrality)
- curl against the deployed gateway: streaming request returns the full `response.*` sequence;
  a provider without the capability returns the 502 naming it

Owner-run (I cannot do these):
- **a real Codex CLI session with tool calls and a mid-turn cancel** — the only meaningful
  test of SSE fidelity and the drain path
- verify the request log row: non-null TTFT/timing fields, correct token counts,
  no `instructions` content in `request_body`

Codex config for the owner test:

```toml
model = "gpt-5.6-sol"
model_provider = "octafuse"

[model_providers.octafuse]
name = "OctaFuse Gateway"
base_url = "https://my-octafuse-prod-proxy.chiwalau.workers.dev/v1"
env_key = "OCTAFUSE_API_KEY"
wire_api = "responses"
```

Deploy (owner triggers; needs `CLOUDFLARE_API_TOKEN`):
`npm run deploy:cloudflare -- production --proxy-only` then `--admin-only` for the UI change.

## Ordering rationale

Step 1 first because the normaliser is needed by step 3 and its extraction must prove
chat is unaffected before anything else lands. Step 2 before 3 because the parser's tests
reference the capability. Steps 4–6 bottom-up so each layer is typecheck-clean as it lands.
Step 7 is independent of 1–6 and could ship separately. Every test is registered in the
step that creates it (M1 — two existing driver tests are unregistered and silently never run).
