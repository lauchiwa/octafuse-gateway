/**
 * Playground 正文抽取单测。
 *
 * 重点是 `responses` 入口：报文形状与 chat 完全不同（事件是 `response.output_text.delta`，
 * 非流式正文在 `output[].content[].text`），此前 merger 只认 chat/anthropic/gemini，
 * 导致 Responses 响应在调试台显示为空。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	inferPlaygroundParseMode,
	mergeAssistantTextParts,
	mergeAssistantText,
} from './merge-assistant-text';

/** 真实抓包形状（muyuan.do / gpt-5.6-sol，2026-07-26）。 */
const RESPONSES_SSE = [
	'event: response.created',
	'data: {"type":"response.created","response":{"id":"resp_x","usage":null}}',
	'',
	'event: response.output_text.delta',
	'data: {"type":"response.output_text.delta","delta":"Hel"}',
	'',
	'event: response.output_text.delta',
	'data: {"type":"response.output_text.delta","delta":"lo"}',
	'',
	'event: response.completed',
	'data: {"type":"response.completed","response":{"id":"resp_x","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}',
	'',
].join('\n');

describe('responses SSE', () => {
	it('concatenates output_text deltas into the body', () => {
		const parts = mergeAssistantTextParts(RESPONSES_SSE, 'responses', 'sse');
		assert.equal(parts.body, 'Hello');
		assert.equal(parts.reasoning, '');
	});

	it('chat parser yields nothing on a Responses stream (the bug this fixes)', () => {
		// 证明必须分列 protocol：用 chat 解析器读 Responses 流拿不到正文。
		const parts = mergeAssistantTextParts(RESPONSES_SSE, 'openai', 'sse');
		assert.equal(parts.body, '');
	});

	it('separates reasoning deltas from body', () => {
		const sse = [
			'data: {"type":"response.reasoning_summary_text.delta","delta":"thinking..."}',
			'',
			'data: {"type":"response.output_text.delta","delta":"answer"}',
			'',
		].join('\n');
		const parts = mergeAssistantTextParts(sse, 'responses', 'sse');
		assert.equal(parts.reasoning, 'thinking...');
		assert.equal(parts.body, 'answer');
	});

	it('tolerates unknown event types and broken JSON', () => {
		const sse = [
			'data: {"type":"response.some_future_event","delta":"ignored"}',
			'',
			'data: {not json',
			'',
			'data: {"type":"response.output_text.delta","delta":"ok"}',
			'',
			'data: [DONE]',
			'',
		].join('\n');
		const parts = mergeAssistantTextParts(sse, 'responses', 'sse');
		assert.equal(parts.body, 'ok');
	});
});

describe('responses non-streaming JSON', () => {
	it('reads output[].content[].text', () => {
		const body = JSON.stringify({
			id: 'resp_y',
			status: 'completed',
			output: [
				{
					type: 'message',
					role: 'assistant',
					content: [{ type: 'output_text', text: 'Non-stream OK' }],
				},
			],
		});
		const parts = mergeAssistantTextParts(body, 'responses', 'json');
		assert.equal(parts.body, 'Non-stream OK');
	});

	it('prefers the convenience output_text field when present', () => {
		const body = JSON.stringify({ id: 'resp_z', output_text: 'shortcut' });
		const parts = mergeAssistantTextParts(body, 'responses', 'json');
		assert.equal(parts.body, 'shortcut');
	});

	it('separates reasoning items from message items', () => {
		const body = JSON.stringify({
			output: [
				{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'why' }] },
				{ type: 'message', content: [{ type: 'output_text', text: 'what' }] },
			],
		});
		const parts = mergeAssistantTextParts(body, 'responses', 'json');
		assert.equal(parts.reasoning, 'why');
		assert.equal(parts.body, 'what');
	});

	it('empty or malformed payloads do not throw', () => {
		assert.equal(mergeAssistantTextParts('', 'responses', 'json').body, '');
		assert.equal(mergeAssistantTextParts('{oops', 'responses', 'json').body, '');
		assert.equal(mergeAssistantTextParts('{}', 'responses', 'json').body, '');
	});
});

describe('regression: existing protocols still work', () => {
	it('chat SSE unchanged', () => {
		const sse = [
			'data: {"choices":[{"delta":{"content":"a"}}]}',
			'',
			'data: {"choices":[{"delta":{"content":"b"}}]}',
			'',
			'data: [DONE]',
			'',
		].join('\n');
		assert.equal(mergeAssistantTextParts(sse, 'openai', 'sse').body, 'ab');
	});

	it('chat JSON unchanged', () => {
		const body = JSON.stringify({ choices: [{ message: { content: 'hi' } }] });
		assert.equal(mergeAssistantTextParts(body, 'openai', 'json').body, 'hi');
	});

	it('anthropic JSON unchanged', () => {
		const body = JSON.stringify({ content: [{ type: 'text', text: 'anthropic' }] });
		assert.equal(mergeAssistantTextParts(body, 'anthropic', 'json').body, 'anthropic');
	});

	it('mergeAssistantText concatenates reasoning before body', () => {
		const sse = [
			'data: {"type":"response.reasoning_summary_text.delta","delta":"R"}',
			'',
			'data: {"type":"response.output_text.delta","delta":"B"}',
			'',
		].join('\n');
		assert.equal(mergeAssistantText(sse, 'responses', 'sse'), 'RB');
	});
});

describe('inferPlaygroundParseMode', () => {
	it('detects SSE and JSON', () => {
		assert.equal(inferPlaygroundParseMode('text/event-stream'), 'sse');
		assert.equal(inferPlaygroundParseMode('application/json; charset=utf-8'), 'json');
		assert.equal(inferPlaygroundParseMode('text/plain'), 'text');
		assert.equal(inferPlaygroundParseMode(null), null);
	});
});
