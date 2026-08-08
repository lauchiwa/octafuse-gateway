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

	it('fills gemini {model} in legacy per-action template', () => {
		const url = resolveUpstreamEndpoint(
			'gemini',
			'models.generate',
			{
				gemini: {
					endpoints: {
						generateContent: 'https://x.example/models/{model}:generateContent',
					},
				},
			},
			{ model: 'gemini-2.0-flash', action: 'generateContent' }
		);
		assert.equal(url, 'https://x.example/models/gemini-2.0-flash:generateContent');
	});

	it('prefers models.generate family template over legacy per-action', () => {
		const url = resolveUpstreamEndpoint(
			'gemini',
			'models.generate',
			{
				gemini: {
					endpoints: {
						'models.generate': 'https://family.example/models/{model}:{action}',
						generateContent: 'https://legacy.example/models/{model}:generateContent',
					},
				},
			},
			{ model: 'gemini-2.0-flash', action: 'streamGenerateContent' }
		);
		assert.equal(url, 'https://family.example/models/gemini-2.0-flash:streamGenerateContent');
	});

	it('derives gemini URL from base when no templates exist', () => {
		const url = resolveUpstreamEndpoint(
			'gemini',
			'models.generate',
			{ gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/models' } },
			{ model: 'gemini-2.0-flash', action: 'generateContent' }
		);
		assert.equal(
			url,
			'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'
		);
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

	it('accepts legacy gemini per-action keys on write', () => {
		const map = validateAndNormalizeProviderEndpoints({
			gemini: {
				endpoints: {
					generateContent: 'https://x.example/models/{model}:generateContent',
				},
			},
		});
		assert.equal(
			map.gemini?.endpoints?.generateContent,
			'https://x.example/models/{model}:generateContent'
		);
	});

	it('rejects models.generate template without {action}', () => {
		assert.throws(
			() =>
				validateAndNormalizeProviderEndpoints({
					gemini: {
						endpoints: {
							'models.generate': 'https://x.example/models/{model}:generateContent',
						},
					},
				}),
			/must include \{action\}/
		);
	});
});

describe('listConfiguredCapabilities', () => {
	it('returns all base-derivable capabilities when base is set, but never responses', () => {
		assert.deepEqual(
			listConfiguredCapabilities(
				{ openai: { base: 'https://api.openai.com/v1' } },
				'openai'
			),
			['chat', 'images.generations', 'images.edits', 'audio.transcriptions']
		);
	});

	it('includes responses only when explicitly declared alongside base', () => {
		assert.deepEqual(
			listConfiguredCapabilities(
				{
					openai: {
						base: 'https://relay.example/v1',
						endpoints: { responses: 'https://relay.example/v1/responses' },
					},
				},
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

	it('keeps base-derived capabilities with partial overrides, still excluding responses', () => {
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
			['chat', 'images.generations', 'images.edits', 'audio.transcriptions']
		);
	});

	it('returns empty array when protocol is not configured', () => {
		assert.deepEqual(listConfiguredCapabilities({}, 'anthropic'), []);
	});

	it('maps any gemini override key to models.generate', () => {
		assert.deepEqual(
			listConfiguredCapabilities(
				{
					gemini: {
						endpoints: {
							generateContent: 'https://x.example/models/{model}:generateContent',
						},
					},
				},
				'gemini'
			),
			['models.generate']
		);
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

	it('listConfiguredCapabilities and providerDeclaresResponsesEndpoint agree on responses', () => {
		const baseOnly = parseProviderEndpoints({
			endpoints: JSON.stringify({ openai: { base: 'https://api.openai.com/v1' } }),
		});
		// 自 2026-08 v2.3.0 合并起，两者对 `responses` 的结论必须一致：
		// 只配 `base` 时都认为未声明，否则 Admin 会列出一个运行时必抛错的能力。
		assert.equal(listConfiguredCapabilities(baseOnly, 'openai').includes('responses'), false);
		assert.equal(providerDeclaresResponsesEndpoint(baseOnly), false);

		const declared = parseProviderEndpoints({
			endpoints: JSON.stringify({
				openai: { base: 'https://relay.example/v1', endpoints: { responses: 'https://relay.example/v1/responses' } },
			}),
		});
		assert.equal(listConfiguredCapabilities(declared, 'openai').includes('responses'), true);
		assert.equal(providerDeclaresResponsesEndpoint(declared), true);

		// 空白串视为未声明（两者复用同一判定，不会出现 Boolean() vs trim() 分歧）。
		const blank = { openai: { base: 'https://relay.example/v1', endpoints: { responses: '   ' } } };
		assert.equal(listConfiguredCapabilities(blank, 'openai').includes('responses'), false);
		assert.equal(providerDeclaresResponsesEndpoint(blank), false);
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
