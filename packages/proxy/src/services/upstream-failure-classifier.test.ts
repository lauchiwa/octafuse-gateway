import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	classifyUpstreamFetchFailure,
	classifyUpstreamHttpFailure,
	looksLikeClientIdentityRejection,
} from './upstream-failure-classifier';

describe('classifyUpstreamHttpFailure — status-only behaviour', () => {
	it('retries on 429 with rate_limit circuit kind', () => {
		assert.deepEqual(classifyUpstreamHttpFailure(429), {
			action: 'retry_key',
			failureKind: 'rate_limit',
		});
	});

	it('retries on ordinary 5xx with server circuit kind', () => {
		assert.deepEqual(classifyUpstreamHttpFailure(500), { action: 'retry_key', failureKind: 'server' });
		assert.deepEqual(classifyUpstreamHttpFailure(503), { action: 'retry_key', failureKind: 'server' });
	});

	it('retries 524 without cross-request circuit kind', () => {
		assert.deepEqual(classifyUpstreamHttpFailure(524), { action: 'retry_key' });
	});

	it('retries 401/403 with alert flag and auth kind', () => {
		assert.deepEqual(classifyUpstreamHttpFailure(401), {
			action: 'retry_key',
			alertOnKeySwitch: true,
			failureKind: 'auth',
		});
		assert.deepEqual(classifyUpstreamHttpFailure(403), {
			action: 'retry_key',
			alertOnKeySwitch: true,
			failureKind: 'auth',
		});
	});

	it('fails immediately on client errors', () => {
		assert.equal(classifyUpstreamHttpFailure(400).action, 'fail_immediately');
		assert.equal(classifyUpstreamHttpFailure(404).action, 'fail_immediately');
	});

	it('classifies fetch failures as retry_key without circuit kind', () => {
		assert.deepEqual(classifyUpstreamFetchFailure(), { action: 'retry_key' });
	});
});

describe('classifyUpstreamHttpFailure — client-identity rejection', () => {
	it('treats new-api channel:client_restricted as fail_immediately without circuit', () => {
		const result = classifyUpstreamHttpFailure(
			403,
			'{"error":{"code":"channel:client_restricted","message":"channel does not allow the current client"}}'
		);
		assert.deepEqual(result, { action: 'fail_immediately', clientIdentityRejected: true });
		assert.equal(result.failureKind, undefined);
		assert.equal(result.alertOnKeySwitch, undefined);
	});

	it('treats a Cloudflare challenge page as fail_immediately without circuit', () => {
		const result = classifyUpstreamHttpFailure(
			403,
			'<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>'
		);
		assert.deepEqual(result, { action: 'fail_immediately', clientIdentityRejected: true });
	});

	it('still trips the auth circuit for a genuine credential 403', () => {
		assert.deepEqual(
			classifyUpstreamHttpFailure(403, '{"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}'),
			{ action: 'retry_key', alertOnKeySwitch: true, failureKind: 'auth' }
		);
	});

	it('still trips the auth circuit for a 401 with an unrelated body', () => {
		assert.deepEqual(classifyUpstreamHttpFailure(401, '{"error":{"message":"Unauthorized"}}'), {
			action: 'retry_key',
			alertOnKeySwitch: true,
			failureKind: 'auth',
		});
	});

	it('keeps 401 on the auth path even when the body matches a client-restriction signature', () => {
		// 401 是明确的认证失败；只有 403（「已认证但被拒绝」）语义上模糊。
		assert.deepEqual(
			classifyUpstreamHttpFailure(401, '{"error":{"code":"channel:client_restricted"}}'),
			{ action: 'retry_key', alertOnKeySwitch: true, failureKind: 'auth' }
		);
	});

	it('falls back to auth behaviour when the body is unavailable', () => {
		for (const body of [null, undefined, '']) {
			assert.deepEqual(classifyUpstreamHttpFailure(403, body), {
				action: 'retry_key',
				alertOnKeySwitch: true,
				failureKind: 'auth',
			});
		}
	});

	it('does not sniff bodies for statuses other than 403', () => {
		const body = '{"error":{"code":"channel:client_restricted"}}';
		assert.deepEqual(classifyUpstreamHttpFailure(429, body), {
			action: 'retry_key',
			failureKind: 'rate_limit',
		});
		assert.deepEqual(classifyUpstreamHttpFailure(500, body), {
			action: 'retry_key',
			failureKind: 'server',
		});
		assert.deepEqual(classifyUpstreamHttpFailure(400, body), { action: 'fail_immediately' });
	});
});

describe('looksLikeClientIdentityRejection', () => {
	it('matches known signatures case-insensitively', () => {
		assert.equal(looksLikeClientIdentityRejection('CHANNEL:CLIENT_RESTRICTED'), true);
		assert.equal(looksLikeClientIdentityRejection('This Channel Does Not Allow The Current Client'), true);
		assert.equal(looksLikeClientIdentityRejection('You Have Been Blocked'), true);
	});

	it('does not match ordinary credential errors', () => {
		assert.equal(looksLikeClientIdentityRejection('{"error":{"message":"invalid api key"}}'), false);
		assert.equal(looksLikeClientIdentityRejection('rate limit exceeded'), false);
		assert.equal(looksLikeClientIdentityRejection(null), false);
	});

	it('requires both html and cloudflare markers before treating a page as a WAF block', () => {
		assert.equal(looksLikeClientIdentityRejection('<!doctype html><p>upstream error</p>'), false);
		assert.equal(looksLikeClientIdentityRejection('served by cloudflare'), false);
	});

	it('only scans the first 4KB so a huge body cannot hide the signature cost', () => {
		assert.equal(looksLikeClientIdentityRejection(`${'x'.repeat(5000)}client_restricted`), false);
		assert.equal(looksLikeClientIdentityRejection(`${'x'.repeat(4000)}client_restricted`), true);
	});
});
