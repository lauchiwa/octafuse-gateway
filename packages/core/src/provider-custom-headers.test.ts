import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	CUSTOM_HEADERS_MAX_PER_PROTOCOL,
	parseProviderCustomHeaders,
	resolveCustomHeadersForProtocol,
	serializeProviderCustomHeaders,
	validateAndNormalizeProviderCustomHeaders,
} from './provider-custom-headers';

describe('parseProviderCustomHeaders', () => {
	it('parses a valid two-protocol map', () => {
		const map = parseProviderCustomHeaders({
			custom_headers: JSON.stringify({
				openai: { 'User-Agent': 'myapp/1.0' },
				anthropic: { 'User-Agent': 'myapp/anthropic' },
			}),
		});
		assert.equal(map.openai?.['User-Agent'], 'myapp/1.0');
		assert.equal(map.anthropic?.['User-Agent'], 'myapp/anthropic');
	});

	it('returns empty map for null / empty / invalid JSON', () => {
		assert.deepEqual(parseProviderCustomHeaders({ custom_headers: null }), {});
		assert.deepEqual(parseProviderCustomHeaders({ custom_headers: '' }), {});
		assert.deepEqual(parseProviderCustomHeaders({ custom_headers: 'not-json' }), {});
	});

	it('silently drops denied / illegal headers instead of throwing', () => {
		const map = parseProviderCustomHeaders({
			custom_headers: JSON.stringify({
				openai: {
					Authorization: 'Bearer leak',
					'Bad Name': 'x',
					'X-Ok': 'value',
				},
			}),
		});
		assert.deepEqual(map.openai, { 'X-Ok': 'value' });
	});

	it('drops unknown protocol keys', () => {
		const map = parseProviderCustomHeaders({
			custom_headers: JSON.stringify({ ftp: { 'X-A': '1' } }),
		});
		assert.deepEqual(map, {});
	});
});

describe('validateAndNormalizeProviderCustomHeaders', () => {
	it('accepts a valid map', () => {
		const res = validateAndNormalizeProviderCustomHeaders({
			openai: { 'User-Agent': 'myapp/1.0', 'X-Trace': 'abc' },
		});
		assert.equal(res.ok, true);
		if (res.ok) assert.equal(res.value.openai?.['User-Agent'], 'myapp/1.0');
	});

	it('accepts JSON string input and empty string', () => {
		const res = validateAndNormalizeProviderCustomHeaders('{"gemini":{"X-A":"1"}}');
		assert.equal(res.ok, true);
		const empty = validateAndNormalizeProviderCustomHeaders('');
		assert.equal(empty.ok, true);
		if (empty.ok) assert.deepEqual(empty.value, {});
	});

	it('rejects denylisted header names (case-insensitive)', () => {
		for (const name of ['authorization', 'Authorization', 'x-api-key', 'Content-Type', 'Host']) {
			const res = validateAndNormalizeProviderCustomHeaders({ openai: { [name]: 'x' } });
			assert.equal(res.ok, false, `${name} should be rejected`);
		}
	});

	it('rejects invalid HTTP token header names', () => {
		const res = validateAndNormalizeProviderCustomHeaders({ openai: { 'Bad Name': 'x' } });
		assert.equal(res.ok, false);
	});

	it('rejects CR/LF and control chars in values', () => {
		assert.equal(
			validateAndNormalizeProviderCustomHeaders({ openai: { 'X-A': 'a\r\nb' } }).ok,
			false
		);
		assert.equal(
			validateAndNormalizeProviderCustomHeaders({ openai: { 'X-A': 'a\x00b' } }).ok,
			false
		);
	});

	it('rejects non-string values', () => {
		const res = validateAndNormalizeProviderCustomHeaders({ openai: { 'X-A': 123 } });
		assert.equal(res.ok, false);
	});

	it('rejects unknown protocol', () => {
		const res = validateAndNormalizeProviderCustomHeaders({ ftp: { 'X-A': '1' } });
		assert.equal(res.ok, false);
	});

	it('rejects more than the per-protocol header limit', () => {
		const headers: Record<string, string> = {};
		for (let i = 0; i <= CUSTOM_HEADERS_MAX_PER_PROTOCOL; i++) headers[`X-H-${i}`] = 'v';
		const res = validateAndNormalizeProviderCustomHeaders({ openai: headers });
		assert.equal(res.ok, false);
	});

	it('rejects a protocol whose serialized size exceeds the byte cap', () => {
		const res = validateAndNormalizeProviderCustomHeaders({
			openai: { 'X-Big': 'v'.repeat(2000) },
		});
		assert.equal(res.ok, false);
	});
});

describe('serialize / resolve round-trip', () => {
	it('serializes to JSON and parses back identically', () => {
		const input = { openai: { 'User-Agent': 'ua' }, gemini: { 'X-A': '1' } };
		const json = serializeProviderCustomHeaders(input);
		assert.ok(json);
		const parsed = parseProviderCustomHeaders({ custom_headers: json });
		assert.deepEqual(parsed, input);
	});

	it('serializes an empty map to null', () => {
		assert.equal(serializeProviderCustomHeaders({}), null);
	});

	it('resolveCustomHeadersForProtocol returns {} for a missing protocol', () => {
		assert.deepEqual(resolveCustomHeadersForProtocol({ openai: { 'X-A': '1' } }, 'anthropic'), {});
		assert.deepEqual(resolveCustomHeadersForProtocol({ openai: { 'X-A': '1' } }, 'openai'), {
			'X-A': '1',
		});
	});
});
