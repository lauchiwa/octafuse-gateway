import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	formDataToCustomHeadersMap,
	formDataToEndpointsMap,
	protocolFormHasCustomHeaders,
	providerToFormData,
	tryCollapseGeminiLegacyEndpoints,
} from './provider-utils';
import { EMPTY_PROVIDER_FORM, emptyProtocolForm, type ProviderFormData } from './types';
import type { GatewayProvider } from '@/lib/types';

function formWith(overrides: Partial<ProviderFormData>): ProviderFormData {
	return {
		...EMPTY_PROVIDER_FORM,
		openai: emptyProtocolForm(),
		anthropic: emptyProtocolForm(),
		gemini: emptyProtocolForm(),
		...overrides,
	};
}


function providerWithEndpoints(endpoints: unknown): GatewayProvider {
	return {
		id: 'p1',
		name: 'P1',
		status: 'active',
		endpoints: JSON.stringify(endpoints),
		description: null,
		created_at: null,
		// created_at 在 GatewayProvider 中为 string，此处用 null 占位；
		// 上游不对 test 文件 typecheck，故未暴露 TS2352。
	} as unknown as GatewayProvider;
}

describe('tryCollapseGeminiLegacyEndpoints', () => {
	it('collapses URLs that differ only by trailing action', () => {
		assert.equal(
			tryCollapseGeminiLegacyEndpoints(
				'https://x.example/models/{model}:generateContent',
				'https://x.example/models/{model}:streamGenerateContent'
			),
			'https://x.example/models/{model}:{action}'
		);
	});

	it('returns null when hosts differ', () => {
		assert.equal(
			tryCollapseGeminiLegacyEndpoints(
				'https://a.example/models/{model}:generateContent',
				'https://b.example/models/{model}:streamGenerateContent'
			),
			null
		);
	});
});

describe('provider gemini form fold / round-trip', () => {
	it('folds compatible legacy keys into modelsGenerate', () => {
		const form = providerToFormData(
			providerWithEndpoints({
				gemini: {
					endpoints: {
						generateContent: 'https://x.example/models/{model}:generateContent',
						streamGenerateContent: 'https://x.example/models/{model}:streamGenerateContent',
					},
				},
			})
		);
		assert.equal(form.gemini.modelsGenerate, 'https://x.example/models/{model}:{action}');
		assert.equal(form.gemini.legacyPerAction, null);
		const map = formDataToEndpointsMap({ ...EMPTY_PROVIDER_FORM, ...form, id: 'p1', name: 'P1', description: '' });
		assert.equal(map.gemini?.endpoints?.['models.generate'], 'https://x.example/models/{model}:{action}');
		assert.equal(map.gemini?.endpoints?.generateContent, undefined);
	});

	it('preserves incompatible legacy per-action URLs on save', () => {
		const form = providerToFormData(
			providerWithEndpoints({
				gemini: {
					endpoints: {
						generateContent: 'https://a.example/models/{model}:generateContent',
						streamGenerateContent: 'https://b.example/models/{model}:streamGenerateContent',
					},
				},
			})
		);
		assert.ok(form.gemini.legacyPerAction);
		const map = formDataToEndpointsMap({ ...EMPTY_PROVIDER_FORM, ...form, id: 'p1', name: 'P1', description: '' });
		assert.equal(map.gemini?.endpoints?.generateContent, 'https://a.example/models/{model}:generateContent');
		assert.equal(
			map.gemini?.endpoints?.streamGenerateContent,
			'https://b.example/models/{model}:streamGenerateContent'
		);
		assert.equal(map.gemini?.endpoints?.['models.generate'], undefined);
	});
});

test('formDataToCustomHeadersMap collects non-empty headers per protocol', () => {
	const form = formWith({
		openai: { ...emptyProtocolForm(), customHeaders: [{ name: 'User-Agent', value: 'myapp/1.0' }] },
		gemini: { ...emptyProtocolForm(), customHeaders: [{ name: 'X-A', value: '1' }] },
	});
	const map = formDataToCustomHeadersMap(form);
	assert.deepEqual(map, {
		openai: { 'User-Agent': 'myapp/1.0' },
		gemini: { 'X-A': '1' },
	});
});

test('formDataToCustomHeadersMap trims names, drops empty rows, later dup wins', () => {
	const form = formWith({
		openai: {
			...emptyProtocolForm(),
			customHeaders: [
				{ name: '  User-Agent  ', value: 'a' },
				{ name: '', value: 'ignored' },
				{ name: 'User-Agent', value: 'b' },
			],
		},
	});
	const map = formDataToCustomHeadersMap(form);
	assert.deepEqual(map, { openai: { 'User-Agent': 'b' } });
});

test('formDataToCustomHeadersMap returns empty map when no headers', () => {
	assert.deepEqual(formDataToCustomHeadersMap(formWith({})), {});
});

test('protocolFormHasCustomHeaders detects any non-empty header name', () => {
	assert.equal(protocolFormHasCustomHeaders(emptyProtocolForm()), false);
	assert.equal(
		protocolFormHasCustomHeaders({ ...emptyProtocolForm(), customHeaders: [{ name: '  ', value: 'x' }] }),
		false,
	);
	assert.equal(
		protocolFormHasCustomHeaders({ ...emptyProtocolForm(), customHeaders: [{ name: 'X-A', value: '' }] }),
		true,
	);
});

test('providerToFormData round-trips custom_headers into per-protocol rows', () => {
	const provider = {
		custom_headers: JSON.stringify({
			openai: { 'User-Agent': 'ua-openai' },
			anthropic: { 'X-Trace': 'abc' },
		}),
	} as GatewayProvider;
	const form = providerToFormData(provider);
	assert.deepEqual(form.openai.customHeaders, [{ name: 'User-Agent', value: 'ua-openai' }]);
	assert.deepEqual(form.anthropic.customHeaders, [{ name: 'X-Trace', value: 'abc' }]);
	assert.deepEqual(form.gemini.customHeaders, []);
});
