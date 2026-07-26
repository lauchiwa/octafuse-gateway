import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintProviderApiKey, maskProviderApiKeyForAdmin } from '../db/provider-key-utils';

describe('provider-key-utils', () => {
	it('fingerprintProviderApiKey masks short keys', () => {
		assert.strictEqual(fingerprintProviderApiKey('abc'), '***');
		assert.strictEqual(fingerprintProviderApiKey('sk-1234567890'), '…7890');
	});

	it('maskProviderApiKeyForAdmin shows prefix and suffix', () => {
		assert.strictEqual(maskProviderApiKeyForAdmin('sk-1234567890abcdef'), 'sk-…cdef');
		assert.strictEqual(maskProviderApiKeyForAdmin(''), '(empty)');
	});
});
