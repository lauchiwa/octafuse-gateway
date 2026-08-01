# Error Handling — Admin Backend (BFF)

> The `{ success, data?, message? }` contract and the centralized 500 handler.

---

## Overview

The Admin API mirrors the gateway admin API contract: every response is `{ success, data?, message?, ... }`. Errors never leak stack traces to the client; a `requestId` is returned so the caller can correlate with server logs.

---

## Error Types

- No custom error-class hierarchy. Failures are ordinary `Error` (or unknown throwables) caught at the BFF boundary.
- `lib/api-error.ts` normalizes any thrown value into a serializable log field via `toErrorDetails(error)`.

---

## Error Handling Patterns

Wrap route logic and route unexpected failures through `handleGatewayApiError`:

```ts
// lib/api-error.ts
export function handleGatewayApiError({ route, error, context }: GatewayApiErrorOptions) {
	const requestId = crypto.randomUUID();
	const details = toErrorDetails(error);
	console.error('Gateway API error', { requestId, route, error: details, ...(context ? { context } : {}) });
	return Response.json(
		{ success: false, message: 'Internal server error', error: { requestId } },
		{ status: 500 },
	);
}
```

- `route` is a stable label for log lookup, e.g. `gateway.keys.GET`.
- **Expected, user-actionable failures** (validation, not-found) return `{ success: false, message }` with an appropriate status — they are not 500s and should carry a human-readable `message`.
- **Unexpected failures** go through `handleGatewayApiError` → generic 500 with `requestId` only.

---

## API Error Responses

- Session-expired: the catch-all returns `401` for `/api/admin/*`; the client (`readApiJson`) detects this and fires `notifyAdminSessionExpired()`.
- Success: `{ success: true, data }`.
- Client-visible failure: `{ success: false, message }` — the UI displays `message` **as-is** (these strings are intentionally not i18n'd; see admin frontend index).
- Internal error: `{ success: false, message: 'Internal server error', error: { requestId } }`, status 500.

---

## Common Mistakes

- **Returning the raw error/stack to the client.** Only `requestId` is exposed; details go to `console.error`.
- **Throwing for expected validation failures** instead of returning `{ success: false, message }` with a 4xx status.
- **Inconsistent envelope.** Every admin endpoint must return the `{ success, … }` shape so `readApiJson<T>` can type it.
