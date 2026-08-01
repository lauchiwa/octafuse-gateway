/**
 * OpenAI Responses 协议的 usage 解析。
 *
 * 与 chat/completions 的差异（实测 2026-07-26，muyuan.do / gpt-5.6-sol）：
 * - usage 位于 `data.response.usage`，**不是** data 顶层（chat 是顶层 `usage`）。
 * - 仅 `response.completed` 携带 usage；其余 11 种事件均为 null。
 * - 字段名不同：`input_tokens` / `output_tokens`（chat 为 `prompt_tokens` / `completion_tokens`）。
 * - 缓存与 reasoning 在嵌套 details 里：`input_tokens_details.{cached_tokens,cache_write_tokens}`、
 *   `output_tokens_details.reasoning_tokens`。
 *
 * 解析策略是**防御式**的：扫描任意事件的 `data.response.usage`，忽略 null，最后一个非空值胜出。
 * 这样即使某些上游在中间事件发累计 usage、或用了未知事件类型，也不会漏掉或误判。
 *
 * 非流式（`stream:false`）响应体本身就是 response 对象：usage 在 `body.usage`、id 在 `body.id`。
 * 两条路径共用 {@link extractResponsesUsageFromResponseObject}。
 */
import { normalizeInputTokensFromPrompt } from './openai-driver';

/** 单次解析结果；调用方负责累积（最后非空胜出）。 */
export type ResponsesUsageSnapshot = {
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	reasoning_tokens: number;
	total_tokens: number;
	/** 上游 usage 对象 JSON 快照，供审计（与其它驱动一致）。 */
	raw_usage: string | null;
	/** 上游 `resp_*` id，落库到 `upstream_message_id`。 */
	upstreamMessageId: string | null;
};

function num(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: null;
}

/**
 * 从一个 response 对象（流式终止事件的 `data.response`，或非流式的整个 body）提取 usage。
 * @returns usage 为 null（进行中的事件）时返回 null，调用方应保留上一次的非空值
 */
export function extractResponsesUsageFromResponseObject(
	responseObj: unknown
): ResponsesUsageSnapshot | null {
	const resp = asRecord(responseObj);
	if (!resp) return null;

	const usage = asRecord(resp.usage);
	if (!usage) return null;

	const inputDetails = asRecord(usage.input_tokens_details);
	const outputDetails = asRecord(usage.output_tokens_details);

	const cacheRead = num(inputDetails?.cached_tokens);
	const cacheWrite = num(inputDetails?.cache_write_tokens);
	const rawInput = num(usage.input_tokens);
	const outputTokens = num(usage.output_tokens);

	// 与 chat 路径同一归一化：不同上游对 input_tokens 是否已含缓存口径不一致。
	// 网关计费假设 input = regular + cache_read + cache_write（见 usage-tracker.computeMeteredCost）。
	const inputTokens = normalizeInputTokensFromPrompt({
		promptTokens: rawInput,
		completionTokens: outputTokens,
		cacheRead,
		cacheWrite,
		totalTokens: num(usage.total_tokens) || undefined,
	});

	const id = typeof resp.id === 'string' && resp.id.trim() !== '' ? resp.id.trim() : null;

	return {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		cache_read_tokens: cacheRead,
		cache_write_tokens: cacheWrite,
		reasoning_tokens: num(outputDetails?.reasoning_tokens),
		total_tokens: num(usage.total_tokens) || inputTokens + outputTokens,
		raw_usage: JSON.stringify(usage),
		upstreamMessageId: id,
	};
}

/**
 * 解析一行 SSE `data: {...}`。非 data 行、`[DONE]`、坏 JSON 均安全返回 null。
 *
 * 不限定事件类型：任何携带 `response.usage` 的事件都会被采纳（防御式，见文件头注释）。
 */
export function parseResponsesUsageFromDataLine(line: string): ResponsesUsageSnapshot | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith('data:')) return null;
	const payload = trimmed.slice(5).trim();
	if (payload === '' || payload === '[DONE]') return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(payload) as unknown;
	} catch {
		return null;
	}

	const obj = asRecord(parsed);
	if (!obj) return null;
	// 事件封装：{ type: 'response.completed', response: { … , usage } }
	return extractResponsesUsageFromResponseObject(obj.response);
}

/**
 * 是否为流的终止事件。仅用于日志/可观测性 —— usage 采集不依赖它
 * （`usagePromise` 在 pump 的 finally 里 resolve，最后非空 usage 胜出）。
 */
export function isResponsesTerminalEventLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.startsWith('data:')) return false;
	const payload = trimmed.slice(5).trim();
	if (payload === '' || payload === '[DONE]') return false;
	try {
		const obj = asRecord(JSON.parse(payload) as unknown);
		const type = obj?.type;
		return (
			type === 'response.completed' ||
			type === 'response.incomplete' ||
			type === 'response.failed' ||
			type === 'error'
		);
	} catch {
		return false;
	}
}

/**
 * 是否为「首个输出 token」类事件 —— 供 `timing.markFirstToken()`。
 *
 * 实测两种轮次的事件类型完全不同：
 * - 文本轮：`response.output_text.delta`
 * - 工具调用轮：`response.function_call_arguments.delta`（**没有** output_text 事件）
 * 只认前者会让工具调用轮的 TTFT 永远为空。
 */
export function isResponsesOutputDeltaLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.startsWith('data:')) return false;
	const payload = trimmed.slice(5).trim();
	if (payload === '' || payload === '[DONE]') return false;
	try {
		const obj = asRecord(JSON.parse(payload) as unknown);
		const type = obj?.type;
		if (typeof type !== 'string') return false;
		return (
			type === 'response.output_text.delta' ||
			type === 'response.function_call_arguments.delta' ||
			type === 'response.refusal.delta' ||
			type === 'response.audio.delta' ||
			type.endsWith('.delta')
		);
	} catch {
		return false;
	}
}

/** 是否为 reasoning 增量事件 —— 供 `timing.markFirstReasoningToken()`。 */
export function isResponsesReasoningDeltaLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed.startsWith('data:')) return false;
	const payload = trimmed.slice(5).trim();
	if (payload === '' || payload === '[DONE]') return false;
	try {
		const obj = asRecord(JSON.parse(payload) as unknown);
		const type = obj?.type;
		if (typeof type !== 'string') return false;
		return type.startsWith('response.reasoning') && type.endsWith('.delta');
	} catch {
		return false;
	}
}
