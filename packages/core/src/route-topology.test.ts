import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	GEMINI_GENERATE_OPERATION,
	canonicalizeRequestOperation,
	effectiveUpstreamOperation,
	isRequestOperationForProtocol,
	normalizeRouteOperation,
	requestOperationAliasRank,
} from './route-topology';

describe('route topology operations', () => {
	it('validates operations within their public protocol', () => {
		assert.equal(isRequestOperationForProtocol('openai', 'chat'), true);
		assert.equal(isRequestOperationForProtocol('openai', 'responses'), true);
		assert.equal(isRequestOperationForProtocol('anthropic', 'messages'), true);
		assert.equal(isRequestOperationForProtocol('gemini', GEMINI_GENERATE_OPERATION), true);
		assert.equal(isRequestOperationForProtocol('gemini', 'generateContent'), false);
		assert.equal(isRequestOperationForProtocol('gemini', 'streamGenerateContent'), false);
		assert.equal(isRequestOperationForProtocol('anthropic', 'chat'), false);
	});

	it('canonicalizes legacy Gemini operations to models.generate', () => {
		assert.equal(
			canonicalizeRequestOperation('gemini', 'generateContent'),
			GEMINI_GENERATE_OPERATION
		);
		assert.equal(
			canonicalizeRequestOperation('gemini', 'streamGenerateContent'),
			GEMINI_GENERATE_OPERATION
		);
		assert.equal(
			canonicalizeRequestOperation('gemini', GEMINI_GENERATE_OPERATION),
			GEMINI_GENERATE_OPERATION
		);
		assert.equal(canonicalizeRequestOperation('gemini', '*'), '*');
		assert.equal(canonicalizeRequestOperation('openai', 'generateContent'), 'generateContent');
	});

	it('ranks Gemini operation aliases with family highest', () => {
		assert.equal(requestOperationAliasRank(GEMINI_GENERATE_OPERATION), 2);
		assert.equal(requestOperationAliasRank('generateContent'), 1);
		assert.equal(requestOperationAliasRank('streamGenerateContent'), 0);
		assert.equal(requestOperationAliasRank('GENERATECONTENT'), 1);
		assert.equal(requestOperationAliasRank('chat'), -1);
	});

	it('keeps wildcard compatibility for migrated routes', () => {
		assert.equal(normalizeRouteOperation(undefined), '*');
		assert.equal(isRequestOperationForProtocol('openai', '*'), true);
		assert.equal(effectiveUpstreamOperation('*', 'images.generations'), 'images.generations');
		assert.equal(effectiveUpstreamOperation('chat', 'responses'), 'chat');
	});
});
