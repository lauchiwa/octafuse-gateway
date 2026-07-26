import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	applyGeminiStreamQueryParams,
	buildGeminiUpstreamActionUrl,
	normalizeGeminiUpstreamBaseForAuthMatch,
	prepareGeminiUpstreamFetch,
	resolveGeminiUpstreamAuth,
} from './gemini-upstream-url';

describe('buildGeminiUpstreamActionUrl', () => {
	it('rejects empty base URL', () => {
		assert.throws(() =>
			buildGeminiUpstreamActionUrl('', 'gemini-2.5-pro', 'generateContent')
		, /base URL is empty/);
		assert.throws(() =>
			buildGeminiUpstreamActionUrl('   ', 'gemini-2.5-pro', 'generateContent')
		, /base URL is empty/);
	});

	it('rejects bare host without path prefix', () => {
		assert.throws(() =>
			buildGeminiUpstreamActionUrl(
				'https://generativelanguage.googleapis.com',
				'gemini-2.5-pro',
				'streamGenerateContent'
			)
		, /must include path prefix/);
		assert.throws(() =>
			buildGeminiUpstreamActionUrl(
				'https://generativelanguage.googleapis.com/',
				'gemini-2.5-pro',
				'streamGenerateContent'
			)
		, /must include path prefix/);
	});

	it('developer API full prefix', () => {
		assert.strictEqual(
			buildGeminiUpstreamActionUrl(
				'https://generativelanguage.googleapis.com/v1beta/models',
				'gemini-2.5-flash',
				'generateContent'
			)
		, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
	});

	it('vertex express prefix', () => {
		assert.strictEqual(
			buildGeminiUpstreamActionUrl(
				'https://aiplatform.googleapis.com/v1/publishers/google/models',
				'gemini-2.5-flash',
				'streamGenerateContent'
			)
		, 'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:streamGenerateContent');
	});

	it('trims trailing slash from base URL', () => {
		assert.strictEqual(
			buildGeminiUpstreamActionUrl(
				'https://generativelanguage.googleapis.com/v1beta/models/',
				'gemini-2.5-flash',
				'generateContent'
			)
		, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
	});

	it('encodes model name', () => {
		assert.ok(
			buildGeminiUpstreamActionUrl(
				'https://generativelanguage.googleapis.com/v1beta/models',
				'model/with/slash',
				'generateContent'
			).includes('model%2Fwith%2Fslash')
		);
	});

	it('collapses duplicate slashes in base path (qnaigc bypass/vertex)', () => {
		assert.strictEqual(
			buildGeminiUpstreamActionUrl(
				'https://api.qnaigc.com//bypass/vertex/v1/models',
				'gemini-3.1-flash-lite-preview',
				'streamGenerateContent'
			)
		, 'https://api.qnaigc.com/bypass/vertex/v1/models/gemini-3.1-flash-lite-preview:streamGenerateContent');
	});
});

describe('applyGeminiStreamQueryParams', () => {
	it('sets alt=sse for streamGenerateContent', () => {
		const u = new URL(
			'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:streamGenerateContent?key=test'
		);
		applyGeminiStreamQueryParams(u, 'streamGenerateContent');
		assert.strictEqual(u.searchParams.get('alt'), 'sse');
	});

	it('overrides existing alt for streamGenerateContent', () => {
		const u = new URL(
			'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=json'
		);
		applyGeminiStreamQueryParams(u, 'streamGenerateContent');
		assert.strictEqual(u.searchParams.get('alt'), 'sse');
	});

	it('does not set alt for generateContent', () => {
		const u = new URL(
			'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=test'
		);
		applyGeminiStreamQueryParams(u, 'generateContent');
		assert.strictEqual(u.searchParams.has('alt'), false);
	});
});

describe('resolveGeminiUpstreamAuth', () => {
	it('returns query-key for official Google Gemini base URLs', () => {
		assert.strictEqual(
			resolveGeminiUpstreamAuth('https://generativelanguage.googleapis.com/v1beta/models')
		, 'query-key');
		assert.strictEqual(
			resolveGeminiUpstreamAuth('https://aiplatform.googleapis.com/v1/publishers/google/models')
		, 'query-key');
	});

	it('returns bearer for bypass/vertex compatible providers', () => {
		assert.strictEqual(resolveGeminiUpstreamAuth('https://api.qnaigc.com/bypass/vertex/v1/models'), 'bearer');
		assert.strictEqual(resolveGeminiUpstreamAuth('https://api.modelink.ai/bypass/vertex/v1/models'), 'bearer');
	});

	it('normalizes trailing slash, host case, and duplicate slashes', () => {
		assert.strictEqual(
			resolveGeminiUpstreamAuth('https://API.QNAIGC.COM//bypass/vertex/v1/models/')
		, 'bearer');
		assert.strictEqual(
			normalizeGeminiUpstreamBaseForAuthMatch(
				'https://api.qnaigc.com//bypass/vertex/v1/models/'
			)
		, 'https://api.qnaigc.com/bypass/vertex/v1/models');
	});
});

describe('prepareGeminiUpstreamFetch', () => {
	it('uses query key for official Gemini upstream', () => {
		const { url, headers } = prepareGeminiUpstreamFetch({
			baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
			modelName: 'gemini-2.5-flash',
			action: 'generateContent',
			apiKey: 'provider-key',
		});
		assert.strictEqual(url.searchParams.get('key'), 'provider-key');
		assert.strictEqual(headers.Authorization, undefined);
	});

	it('uses Authorization Bearer for bypass/vertex upstream', () => {
		const { url, headers } = prepareGeminiUpstreamFetch({
			baseUrl: 'https://api.modelink.ai/bypass/vertex/v1/models',
			modelName: 'gemini-2.5-flash',
			action: 'generateContent',
			apiKey: 'provider-token',
		});
		assert.strictEqual(url.searchParams.has('key'), false);
		assert.strictEqual(headers.Authorization, 'Bearer provider-token');
	});

	it('sets alt=sse for streamGenerateContent on bearer upstream', () => {
		const { url } = prepareGeminiUpstreamFetch({
			baseUrl: 'https://api.qnaigc.com/bypass/vertex/v1/models',
			modelName: 'gemini-2.5-flash',
			action: 'streamGenerateContent',
			apiKey: 'provider-token',
		});
		assert.strictEqual(url.searchParams.get('alt'), 'sse');
		assert.strictEqual(url.searchParams.has('key'), false);
	});
});
