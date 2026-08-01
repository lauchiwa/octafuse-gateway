import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	listConfiguredCapabilities,
	parseProviderEndpoints,
	providerDeclaresResponsesEndpoint,
	providerSupportsUpstreamProtocol,
	resolveUpstreamEndpoint,
	validateAndNormalizeProviderEndpoints,
} from './provider-endpoints';

describe('parseProviderEndpoints', () => {
	it('uses endpoints column when present', () => {
		const map = parseProviderEndpoints({
			endpoints: JSON.stringify({
				openai: { base: 'https://api.openai.com/v1' },
			}),
		});
		assert.equal(map.openai?.base, 'https://api.openai.com/v1');
	});

	it('returns empty map when endpoints is null', () => {
		const map = parseProviderEndpoints({ endpoints: null });
		assert.deepEqual(map, {});
	});

	it('returns empty map when endpoints is empty object', () => {
		const map = parseProviderEndpoints({ endpoints: '{}' });
		assert.deepEqual(map, {});
	});
});

describe('resolveUpstreamEndpoint', () => {
	it('derives chat from openai base', () => {
		const url = resolveUpstreamEndpoint('openai', 'chat', {
			openai: { base: 'https://api.openai.com/v1' },
		});
		assert.equal(url, 'https://api.openai.com/v1/chat/completions');
	});

	it('derives audio.transcriptions from openai base', () => {
		const url = resolveUpstreamEndpoint('openai', 'audio.transcriptions', {
			openai: { base: 'https://api.openai.com/v1' },
		});
		assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
	});

	it('uses capability template without appending suffix', () => {
		const url = resolveUpstreamEndpoint('openai', 'chat', {
			openai: {
				endpoints: { chat: 'https://vendor.example/custom/chat' },
			},
		});
		assert.equal(url, 'https://vendor.example/custom/chat');
	});

	it('fills gemini {model} in template', () => {
		const url = resolveUpstreamEndpoint(
			'gemini',
			'generateContent',
			{
				gemini: {
					endpoints: {
						generateContent: 'https://x.example/models/{model}:generateContent',
					},
				},
			},
			{ model: 'gemini-2.0-flash' }
		);
		assert.equal(url, 'https://x.example/models/gemini-2.0-flash:generateContent');
	});
});

describe('providerSupportsUpstreamProtocol', () => {
	it('true when only capability endpoints exist', () => {
		assert.equal(
			providerSupportsUpstreamProtocol('openai', {
				endpoints: {
					openai: { endpoints: { chat: 'https://v.example/chat' } },
				},
			}),
			true
		);
	});
});

describe('validateAndNormalizeProviderEndpoints', () => {
	it('rejects gemini template without {model}', () => {
		assert.throws(
			() =>
				validateAndNormalizeProviderEndpoints({
					gemini: {
						endpoints: {
							generateContent: 'https://x.example/generate',
						},
					},
				}),
			/must include \{model\}/
		);
	});
});

describe('listConfiguredCapabilities', () => {
	it('returns all protocol capabilities when base is set', () => {
		assert.deepEqual(
			listConfiguredCapabilities(
				{ openai: { base: 'https://api.openai.com/v1' } },
				'openai'
			),
			['chat', 'responses', 'images.generations', 'images.edits', 'audio.transcriptions']
		);
	});

	it('returns only explicit overrides when base is absent', () => {
		assert.deepEqual(
			listConfiguredCapabilities(
				{
					openai: {
						endpoints: { chat: 'https://vendor.example/chat' },
					},
				},
				'openai'
			),
			['chat']
		);
	});

	it('returns all capabilities when base is set even with partial overrides', () => {
		assert.deepEqual(
			listConfiguredCapabilities(
				{
					openai: {
						base: 'https://api.openai.com/v1',
						endpoints: { chat: 'https://vendor.example/chat' },
					},
				},
				'openai'
			),
			['chat', 'responses', 'images.generations', 'images.edits', 'audio.transcriptions']
		);
	});

	it('returns empty array when protocol is not configured', () => {
		assert.deepEqual(listConfiguredCapabilities({}, 'anthropic'), []);
	});
});

describe('responses capability (never derived from base)', () => {
	it('resolves an explicit responses template', () => {
		const map = parseProviderEndpoints({
			endpoints: JSON.stringify({
				openai: { endpoints: { responses: 'https://relay.example/v1/responses' } },
			}),
		});
		assert.equal(
			resolveUpstreamEndpoint('openai', 'responses', map, { providerId: 'p1' }),
			'https://relay.example/v1/responses'
		);
	});

	it('throws for base-only providers instead of deriving ${base}/responses', () => {
		const map = parseProviderEndpoints({
			endpoints: JSON.stringify({ openai: { base: 'https://api.openai.com/v1' } }),
		});
		assert.throws(
			() => resolveUpstreamEndpoint('openai', 'responses', map, { providerId: 'p-base' }),
			/no explicit endpoints\.openai\.endpoints\.responses/
		);
	});

	it('providerDeclaresResponsesEndpoint is the routing gate, not listConfiguredCapabilities', () => {
		const baseOnly = parseProviderEndpoints({
			endpoints: JSON.stringify({ openai: { base: 'https://api.openai.com/v1' } }),
		});
		// listConfiguredCapabilities reports every capability when `base` is set — that is why
		// the route gate must use the explicit-declaration helper instead.
		assert.ok(listConfiguredCapabilities(baseOnly, 'openai').includes('responses'));
		assert.equal(providerDeclaresResponsesEndpoint(baseOnly), false);

		const declared = parseProviderEndpoints({
			endpoints: JSON.stringify({
				openai: { base: 'https://relay.example/v1', endpoints: { responses: 'https://relay.example/v1/responses' } },
			}),
		});
		assert.equal(providerDeclaresResponsesEndpoint(declared), true);
	});

	it('accepts an explicit responses endpoint through admin validation', () => {
		// 返回归一化后的 map；非法输入会 throw（无 { ok } 包装）。
		const map = validateAndNormalizeProviderEndpoints(
			JSON.stringify({ openai: { endpoints: { responses: 'https://relay.example/v1/responses' } } })
		);
		assert.equal(map.openai?.endpoints?.responses, 'https://relay.example/v1/responses');
	});

	it('rejects an unknown capability name so typos surface at save time', () => {
		assert.throws(
			() =>
				validateAndNormalizeProviderEndpoints(
					JSON.stringify({ openai: { endpoints: { response: 'https://relay.example/v1/responses' } } })
				),
			/unknown capability/
		);
	});
});
