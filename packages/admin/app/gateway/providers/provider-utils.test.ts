import test from 'node:test';
import assert from 'node:assert/strict';
import {
	formDataToCustomHeadersMap,
	protocolFormHasCustomHeaders,
	providerToFormData,
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
