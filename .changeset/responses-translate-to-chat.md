---
"@octafuse/proxy": minor
---

Serve `/v1/responses` on providers that only speak `/chat/completions`.

Phase 1 only forwarded to upstreams exposing a native Responses endpoint; every other
provider was filtered out and the request returned 502. That capability check is now a
per-route strategy choice: providers declaring `endpoints.openai.endpoints.responses` keep
byte passthrough, and the rest are served by translating Responses ↔ Chat Completions.

- Request translation covers Codex's item-centred `input` (`message`, `function_call`,
  `function_call_output`), `instructions`, function tools, and the parameter renames
  (`max_output_tokens` → `max_tokens`). Consecutive `function_call` items merge into one
  assistant message, as the Chat protocol requires for parallel calls.
- Streaming translation synthesises the Responses lifecycle events chat SSE lacks
  (`output_item.added` / `content_part.added` / `*.done`), and always emits a terminal
  event — including when the upstream truncates, since an unterminated sequence hangs
  Codex instead of failing cleanly.
- `stream_options.include_usage` is requested on every translated streaming call;
  without it most OpenAI-compatible relays omit `usage` and requests would bill zero.
- Features that cannot be represented in Chat Completions (`previous_response_id`,
  `store:true`, hosted tools) return 400 naming the field rather than being dropped
  silently. Reasoning items are dropped, which is lossy but keeps multi-turn working.
- Route ordering puts passthrough-capable providers first, so translation is a fallback.
