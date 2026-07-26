import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	normalizeProviderKeyLimitConfigInput,
	parseProviderKeyLimitConfig,
} from './provider-key-limit-config';

describe('parseProviderKeyLimitConfig', () => {
	it('parses a full config', () => {
		assert.deepStrictEqual(parseProviderKeyLimitConfig('{"rpm":500,"tpm":200000,"max_concurrency":32}'), {
			rpm: 500,
			tpm: 200_000,
			maxConcurrency: 32,
		});
	});

	it('supports partial dimensions and defaults the rest to null', () => {
		assert.deepStrictEqual(parseProviderKeyLimitConfig('{"rpm":10}'), { rpm: 10, tpm: null, maxConcurrency: null });
	});

	it('ignores unknown fields (forward compatible)', () => {
		assert.deepStrictEqual(parseProviderKeyLimitConfig('{"rpm":10,"burst":99}'), {
			rpm: 10,
			tpm: null,
			maxConcurrency: null,
		});
	});

	it('returns null for empty / invalid / no-effective-field inputs', () => {
		assert.strictEqual(parseProviderKeyLimitConfig(null), null);
		assert.strictEqual(parseProviderKeyLimitConfig(''), null);
		assert.strictEqual(parseProviderKeyLimitConfig('not json'), null);
		assert.strictEqual(parseProviderKeyLimitConfig('[1,2]'), null);
		assert.strictEqual(parseProviderKeyLimitConfig('{"rpm":0}'), null);
		assert.strictEqual(parseProviderKeyLimitConfig('{"rpm":-5}'), null);
		assert.strictEqual(parseProviderKeyLimitConfig('{"rpm":"10"}'), null);
	});

	it('floors fractional values', () => {
		assert.deepStrictEqual(parseProviderKeyLimitConfig('{"rpm":10.9}'), { rpm: 10, tpm: null, maxConcurrency: null });
	});
});

describe('normalizeProviderKeyLimitConfigInput', () => {
	it('returns null for empty input (clear config)', () => {
		assert.strictEqual(normalizeProviderKeyLimitConfigInput(null), null);
		assert.strictEqual(normalizeProviderKeyLimitConfigInput(''), null);
		assert.strictEqual(normalizeProviderKeyLimitConfigInput('   '), null);
	});

	it('normalizes to only known fields', () => {
		assert.strictEqual(normalizeProviderKeyLimitConfigInput('{"rpm":500,"unknown":1}'), '{"rpm":500}');
	});

	it('throws for invalid JSON, non-objects, and configs without effective fields', () => {
		assert.throws(() => normalizeProviderKeyLimitConfigInput('nope'), /valid JSON/);
		assert.throws(() => normalizeProviderKeyLimitConfigInput('[1]'), /JSON object/);
		assert.throws(() => normalizeProviderKeyLimitConfigInput('{"rpm":0}'), /at least one/);
	});
});
