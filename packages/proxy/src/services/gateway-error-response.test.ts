import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { GATEWAY_ERROR_CODE_HEADER, GatewayErrorCode } from './gateway-error-codes';
import {
	classifyUpstreamErrorCode,
	gatewayErrorJson,
	gatewayErrorResponse,
	withUpstreamErrorCodeHeader,
} from './gateway-error-response';

describe('gateway-error-response', () => {
	it('keeps flat error string for Agent compatibility and adds top-level code + header', async () => {
		const app = new Hono();
		app.get('/x', (c) =>
			gatewayErrorJson(c, {
				status: 403,
				code: GatewayErrorCode.budgetExceeded,
				message: 'Budget exceeded',
			})
		);
		const res = await app.request('/x');
		assert.equal(res.status, 403);
		assert.equal(res.headers.get(GATEWAY_ERROR_CODE_HEADER), GatewayErrorCode.budgetExceeded);
		const body = (await res.json()) as { error: unknown; code: string };
		assert.equal(typeof body.error, 'string');
		assert.equal(body.error, 'Budget exceeded');
		assert.equal(body.code, GatewayErrorCode.budgetExceeded);
	});

	it('gatewayErrorResponse mirrors flat shape', async () => {
		const res = gatewayErrorResponse({
			status: 401,
			code: GatewayErrorCode.authFailed,
			message: 'Invalid API key',
		});
		const body = (await res.json()) as { error: string; code: string };
		assert.equal(body.error, 'Invalid API key');
		assert.equal(body.code, GatewayErrorCode.authFailed);
		assert.equal(res.headers.get(GATEWAY_ERROR_CODE_HEADER), GatewayErrorCode.authFailed);
	});

	it('classifies upstream 400 as content_filter vs invalid_request', () => {
		assert.equal(
			classifyUpstreamErrorCode(
				400,
				'application/json',
				JSON.stringify({ error: { message: 'sensitive content blocked' } })
			),
			GatewayErrorCode.upstreamContentFilter
		);
		assert.equal(
			classifyUpstreamErrorCode(400, 'application/json', JSON.stringify({ error: { message: 'bad param' } })),
			GatewayErrorCode.upstreamInvalidRequest
		);
	});

	it('withUpstreamErrorCodeHeader does not alter body', async () => {
		const raw = JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit' } });
		const res = withUpstreamErrorCodeHeader(new Response(raw, { status: 429 }), raw);
		assert.equal(res.status, 429);
		assert.equal(res.headers.get(GATEWAY_ERROR_CODE_HEADER), GatewayErrorCode.upstreamRateLimited);
		assert.equal(await res.text(), raw);
	});
});
