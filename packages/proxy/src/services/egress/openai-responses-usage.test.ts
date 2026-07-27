/**
 * Responses usage 解析单测。
 *
 * 事件形状取自真实抓包（2026-07-26, muyuan.do / gpt-5.6-sol），含两种轮次：
 * 纯文本轮与工具调用轮 —— 后者事件类型完全不同，是 TTFT 的回归点。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	extractResponsesUsageFromResponseObject,
	isResponsesOutputDeltaLine,
	isResponsesReasoningDeltaLine,
	isResponsesTerminalEventLine,
	parseResponsesUsageFromDataLine,
} from './openai-responses-usage';

/** 实测 response.completed 的 data（截去无关字段）。 */
const COMPLETED_LINE =
	'data: {"type":"response.completed","response":{"id":"resp_03772fc7721ebcfe","object":"response","status":"completed","usage":{"input_tokens":4388,"input_tokens_details":{"cache_write_tokens":0,"cached_tokens":3840},"output_tokens":5,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":4393}}}';

/** 实测进行中事件：response 存在但 usage 为 null。 */
const IN_PROGRESS_LINE =
	'data: {"type":"response.in_progress","response":{"id":"resp_03772fc7721ebcfe","status":"in_progress","usage":null}}';

describe('parseResponsesUsageFromDataLine', () => {
	it('reads usage from data.response.usage, not the top level', () => {
		const got = parseResponsesUsageFromDataLine(COMPLETED_LINE);
		assert.ok(got, 'expected usage from the terminal event');
		// input_tokens 已含缓存（4388 > 3840），归一化后保持原值
		assert.equal(got.input_tokens, 4388);
		assert.equal(got.output_tokens, 5);
		assert.equal(got.cache_read_tokens, 3840);
		assert.equal(got.cache_write_tokens, 0);
		assert.equal(got.reasoning_tokens, 0);
		assert.equal(got.upstreamMessageId, 'resp_03772fc7721ebcfe');
	});

	it('returns null for in-progress events (usage: null)', () => {
		assert.equal(parseResponsesUsageFromDataLine(IN_PROGRESS_LINE), null);
	});

	it('a top-level usage field is NOT mistaken for Responses usage', () => {
		// chat 的形状：usage 在 data 顶层。Responses 解析器必须忽略它，
		// 否则会把 chat 帧误读成 Responses 帧。
		const chatShaped =
			'data: {"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}';
		assert.equal(parseResponsesUsageFromDataLine(chatShaped), null);
	});

	it('ignores non-data lines, [DONE] and malformed JSON', () => {
		assert.equal(parseResponsesUsageFromDataLine('event: response.completed'), null);
		assert.equal(parseResponsesUsageFromDataLine('data: [DONE]'), null);
		assert.equal(parseResponsesUsageFromDataLine('data: {not json'), null);
		assert.equal(parseResponsesUsageFromDataLine(''), null);
		assert.equal(parseResponsesUsageFromDataLine('data:'), null);
	});

	it('reconciles the prompt-excludes-cache convention (under-billing guard)', () => {
		// input_tokens(500) < cached(3840) → 该上游是「不含缓存」口径，
		// 直接相信会让 computeMeteredCost 的 regularInput 变负、严重少算。
		const line =
			'data: {"type":"response.completed","response":{"id":"resp_x","usage":{"input_tokens":500,"input_tokens_details":{"cached_tokens":3840,"cache_write_tokens":0},"output_tokens":7,"output_tokens_details":{"reasoning_tokens":0}}}}';
		const got = parseResponsesUsageFromDataLine(line);
		assert.ok(got);
		assert.equal(got.input_tokens, 500 + 3840);
		// 计费恒等式：regular 不为负
		assert.ok(got.input_tokens - got.cache_read_tokens - got.cache_write_tokens >= 0);
	});

	it('captures reasoning tokens without folding them into output', () => {
		const line =
			'data: {"type":"response.completed","response":{"id":"resp_r","usage":{"input_tokens":100,"output_tokens":50,"output_tokens_details":{"reasoning_tokens":42}}}}';
		const got = parseResponsesUsageFromDataLine(line);
		assert.ok(got);
		assert.equal(got.reasoning_tokens, 42);
		// reasoning 不参与计费（computeMeteredCost 不消费该字段）；
		// 折进 output 会重复计费。
		assert.equal(got.output_tokens, 50);
	});

	it('tolerates missing details objects', () => {
		const line =
			'data: {"type":"response.completed","response":{"id":"resp_min","usage":{"input_tokens":8,"output_tokens":1}}}';
		const got = parseResponsesUsageFromDataLine(line);
		assert.ok(got);
		assert.equal(got.input_tokens, 8);
		assert.equal(got.cache_read_tokens, 0);
		assert.equal(got.reasoning_tokens, 0);
	});
});

describe('extractResponsesUsageFromResponseObject (non-streaming path)', () => {
	it('reads a stream:false body where the body IS the response object', () => {
		// 非流式：usage 在 body.usage、id 在 body.id（不是 data.response.*）
		const body = {
			id: 'resp_nonstream',
			object: 'response',
			status: 'completed',
			usage: {
				input_tokens: 30,
				input_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 },
				output_tokens: 4,
				output_tokens_details: { reasoning_tokens: 2 },
			},
		};
		const got = extractResponsesUsageFromResponseObject(body);
		assert.ok(got);
		assert.equal(got.input_tokens, 30);
		assert.equal(got.cache_read_tokens, 10);
		assert.equal(got.cache_write_tokens, 5);
		assert.equal(got.reasoning_tokens, 2);
		assert.equal(got.upstreamMessageId, 'resp_nonstream');
	});

	it('returns null when there is no usage', () => {
		assert.equal(extractResponsesUsageFromResponseObject({ id: 'resp_x' }), null);
		assert.equal(extractResponsesUsageFromResponseObject(null), null);
		assert.equal(extractResponsesUsageFromResponseObject('nope'), null);
	});
});

describe('event classification', () => {
	it('detects terminal events', () => {
		assert.equal(isResponsesTerminalEventLine(COMPLETED_LINE), true);
		assert.equal(
			isResponsesTerminalEventLine('data: {"type":"response.failed","response":{}}'),
			true
		);
		assert.equal(
			isResponsesTerminalEventLine('data: {"type":"response.incomplete","response":{}}'),
			true
		);
		assert.equal(isResponsesTerminalEventLine(IN_PROGRESS_LINE), false);
	});

	it('treats tool-call deltas as output tokens (measured: no output_text events in a tool turn)', () => {
		// 工具调用轮的实测事件序列里没有 output_text.delta；
		// 只认 output_text 会让工具轮的 TTFT 永远为空。
		assert.equal(
			isResponsesOutputDeltaLine(
				'data: {"type":"response.function_call_arguments.delta","delta":"{\\"a\\":1}"}'
			),
			true
		);
		assert.equal(
			isResponsesOutputDeltaLine('data: {"type":"response.output_text.delta","delta":"hi"}'),
			true
		);
		assert.equal(isResponsesOutputDeltaLine(COMPLETED_LINE), false);
		assert.equal(isResponsesOutputDeltaLine(IN_PROGRESS_LINE), false);
	});

	it('separates reasoning deltas from output deltas', () => {
		const reasoning = 'data: {"type":"response.reasoning_summary_text.delta","delta":"think"}';
		assert.equal(isResponsesReasoningDeltaLine(reasoning), true);
		assert.equal(
			isResponsesReasoningDeltaLine('data: {"type":"response.output_text.delta","delta":"hi"}'),
			false
		);
	});
});
