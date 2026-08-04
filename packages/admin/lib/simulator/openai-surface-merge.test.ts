/**
 * Merge-seam regression: upstream v2.1.1 introduced the shared invoke-kind
 * mapping (llm/image/audio/tool) while this fork carries the OpenAI Responses
 * surface. Both must coexist — the Responses surface may only affect llm+openai,
 * and must never leak into image/audio/tool routing or into upstream's `toolId`
 * template slot. See .trellis/spec/guides/upstream-merge-thinking-guide.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSimulatorRequest } from '@/lib/simulator/endpoint';
import {
	resolveProxyPathForModelInvoke,
	resolveOpenaiUpstreamCapability,
	resolveRequestOperation,
} from '@/lib/invoke-kind';
import { bodyTemplateForSelection, isBodyDirty, RESPONSES_BODY_TEMPLATE } from '@/app/gateway/simulator/simulator-utils';

test('fork: Responses surface survives the merge end-to-end', () => {
	const r = buildSimulatorRequest({
		baseUrl: 'https://gw.example.com', protocol: 'openai',
		modelForRouting: 'gpt-5.5', body: {}, apiKey: 'sk-x',
		openaiSurface: 'responses',
	});
	assert.equal(r.url, 'https://gw.example.com/v1/responses');
	assert.equal(resolveOpenaiUpstreamCapability({ kind: 'llm', openaiSurface: 'responses' }), 'responses');
	assert.equal(resolveRequestOperation({ kind: 'llm', protocol: 'openai', openaiSurface: 'responses' }), 'responses');
});

test('fork: chat remains the default (no silent surface flip)', () => {
	const r = buildSimulatorRequest({
		baseUrl: 'https://gw.example.com', protocol: 'openai',
		modelForRouting: 'gpt-5.5', body: {}, apiKey: 'sk-x',
	});
	assert.equal(r.url, 'https://gw.example.com/v1/chat/completions');
	assert.equal(resolveOpenaiUpstreamCapability({ kind: 'llm' }), 'chat');
});

test('upstream: tools route unaffected by the surface param', () => {
	const r = buildSimulatorRequest({
		baseUrl: 'https://gw.example.com', protocol: 'openai', kind: 'tool',
		toolId: 'ai-detection', modelForRouting: 'ignored', body: { text: 'x' }, apiKey: 'sk-x',
		openaiSurface: 'responses',
	});
	assert.equal(r.url, 'https://gw.example.com/v1/tools/ai-detection');
});

test('image/audio ignore the Responses surface (regression guard)', () => {
	assert.equal(resolveProxyPathForModelInvoke({
		kind: 'image', protocol: 'openai', imageOperation: 'edits', openaiSurface: 'responses',
	}), '/v1/images/edits');
	assert.equal(resolveProxyPathForModelInvoke({
		kind: 'audio', protocol: 'openai', openaiSurface: 'responses',
	}), '/v1/audio/transcriptions');
	assert.equal(resolveOpenaiUpstreamCapability({
		kind: 'audio', openaiSurface: 'responses',
	}), 'audio.transcriptions');
});

test('the guard is protocol- and kind-scoped, not a bare surface check', () => {
	// anthropic/gemini must never resolve a `responses` operation even if the
	// surface state is stale from a previous OpenAI selection.
	assert.equal(
		resolveRequestOperation({ kind: 'llm', protocol: 'anthropic', openaiSurface: 'responses' }),
		'messages'
	);
	assert.equal(
		resolveRequestOperation({
			kind: 'llm', protocol: 'gemini', geminiAction: 'generateContent', openaiSurface: 'responses',
		}),
		'generateContent'
	);
	// image/audio keep their own operations regardless of surface.
	assert.equal(
		resolveRequestOperation({ kind: 'image', protocol: 'openai', openaiSurface: 'responses' }),
		'images.generations'
	);
	assert.equal(
		resolveRequestOperation({ kind: 'audio', protocol: 'openai', openaiSurface: 'responses' }),
		'audio.transcriptions'
	);
	// anthropic path must not become /v1/responses either.
	assert.equal(
		resolveProxyPathForModelInvoke({ kind: 'llm', protocol: 'anthropic', openaiSurface: 'responses' }),
		'/v1/messages'
	);
});

test('templates: toolId and openaiSurface occupy distinct slots', () => {
	assert.equal(bodyTemplateForSelection('openai', false, 'generations', false, null, 'responses'), RESPONSES_BODY_TEMPLATE);
	const tool = bodyTemplateForSelection('openai', false, 'generations', false, 'web-search');
	assert.match(tool, /"query"/);
	// a Responses body must not read as dirty against its own template
	assert.equal(isBodyDirty(RESPONSES_BODY_TEMPLATE, 'openai', false, 'generations', false, null, 'responses'), false);
	// and must read as dirty against the chat template
	assert.equal(isBodyDirty(RESPONSES_BODY_TEMPLATE, 'openai', false, 'generations', false, null, 'chat'), true);
});
