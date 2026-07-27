/**
 * `/v1/responses` 请求日志脱敏（finding I-3）。
 *
 * Codex 的 Responses body 与 chat 形状不同：提示词在 `instructions` 与 `input` 里。
 * chat 的 `openAiBodyRedactedForLog` 只丢 `messages`/`input`/`prompt`/`data`，
 * 直接复用会把 Codex 的完整系统提示写进 `api_key_request_logs`，违反 logging-guidelines。
 *
 * 这些用例是那条保证的执行版本：任何提示词字段回到日志里都会让测试变红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { responsesBodyRedactedForLog, hasUsage } from './responses';

/** 真实 Codex 会发的 body 形状（instructions 为服务端注入的完整系统提示）。 */
const CODEX_BODY: Record<string, unknown> = {
	model: 'gpt-5.6-sol',
	instructions:
		'You are Codex, a coding agent based on GPT-5. You and the user share one workspace...',
	input: [
		{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'refactor auth.ts' }] },
		{ type: 'function_call', name: 'shell', arguments: '{"cmd":["cat","/etc/passwd"]}' },
		{ type: 'function_call_output', output: 'root:x:0:0:root:/root:/bin/bash' },
	],
	tools: [
		{
			type: 'function',
			name: 'shell',
			description: 'run a shell command',
			parameters: { type: 'object', properties: { cmd: { type: 'array' } } },
		},
	],
	stream: true,
	store: false,
	reasoning: { effort: 'medium' },
};

test('no prompt-bearing field survives redaction', () => {
	const out = responsesBodyRedactedForLog(CODEX_BODY);
	const serialized = JSON.stringify(out);

	assert.equal('instructions' in out, false, 'instructions must be dropped');
	assert.equal('input' in out, false, 'input must be dropped');

	// 内容层面的兜底：即使将来字段名变了，提示词文本也不该出现。
	assert.equal(serialized.includes('You are Codex'), false);
	assert.equal(serialized.includes('refactor auth.ts'), false);
	assert.equal(serialized.includes('/etc/passwd'), false);
	assert.equal(serialized.includes('root:x:0:0'), false);
});

test('non-sensitive routing/sampling metadata is kept', () => {
	const out = responsesBodyRedactedForLog(CODEX_BODY);
	assert.equal(out.model, 'gpt-5.6-sol');
	assert.equal(out.stream, true);
	assert.equal(out.store, false);
	assert.deepEqual(out.reasoning, { effort: 'medium' });
});

test('input is replaced by a count, so volume stays observable', () => {
	const out = responsesBodyRedactedForLog(CODEX_BODY);
	assert.equal(out._input_count, 3);
});

test('tools go through the summariser, not raw schemas', () => {
	const out = responsesBodyRedactedForLog(CODEX_BODY);
	const serialized = JSON.stringify(out);
	// 工具名可留（运维需要），但完整 JSON Schema 不该落库。
	assert.equal(serialized.includes('"properties"'), false);
	assert.equal(serialized.includes('run a shell command'), false);
	assert.ok(serialized.includes('shell'), 'tool name should still be observable');
});

test('a string input is also dropped (Codex sends arrays, relays may send strings)', () => {
	const out = responsesBodyRedactedForLog({ model: 'm', input: 'plain text prompt' });
	assert.equal('input' in out, false);
	assert.equal(JSON.stringify(out).includes('plain text prompt'), false);
	// 字符串没有 length 语义的条目数，不应伪造 _input_count
	assert.equal('_input_count' in out, false);
});

test('empty body redacts to empty, not to a crash', () => {
	assert.deepEqual(responsesBodyRedactedForLog({}), {});
});

test('hasUsage drives the incomplete decision (finding I-4)', () => {
	const zero = {
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		reasoning_tokens: 0,
		total_tokens: 0,
		raw_usage: null,
	};
	assert.equal(hasUsage(zero), false, 'no tokens → incomplete');
	assert.equal(hasUsage({ ...zero, total_tokens: 4393 }), true);
	assert.equal(hasUsage({ ...zero, input_tokens: 4388 }), true);
	assert.equal(hasUsage({ ...zero, output_tokens: 5 }), true);
});
