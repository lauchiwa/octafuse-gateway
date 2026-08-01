/**
 * Playground：从上游原始报文（SSE / JSON / text）中提取 assistant 可读正文，
 * 并将推理类字段与正文分列，便于区分。
 */

/**
 * `responses` 是 OpenAI 协议下的第二个文本入口（`/v1/responses`），报文形状与 chat 不同：
 * SSE 为 `response.*` 生命周期事件（正文在 `response.output_text.delta` 的 `delta`），
 * 非流式则是 response 对象本身（正文在 `output[].content[].text`）。
 */
export type PlaygroundProtocol = 'openai' | 'responses' | 'anthropic' | 'gemini';

export type PlaygroundResponseParseMode = 'sse' | 'json' | 'text';

/** 推理链 / thinking 与最终正文分列 */
export type MergedAssistantParts = {
	reasoning: string;
	body: string;
};

const emptyParts = (): MergedAssistantParts => ({ reasoning: '', body: '' });

/** 由响应 Content-Type 推断解析方式（与 Playground `send` 分支一致）。 */
export function inferPlaygroundParseMode(contentType: string | null | undefined): PlaygroundResponseParseMode | null {
	if (contentType == null || contentType === '') {
		return null;
	}
	const lower = contentType.toLowerCase();
	if (lower.includes('text/event-stream')) {
		return 'sse';
	}
	if (lower.includes('application/json') && !lower.includes('text/event-stream')) {
		return 'json';
	}
	return 'text';
}

function extractOpenAiMessageContent(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	let s = '';
	for (const part of content) {
		if (!part || typeof part !== 'object') {
			continue;
		}
		const p = part as { type?: unknown; text?: unknown };
		if (p.type === 'text' && typeof p.text === 'string') {
			s += p.text;
		}
	}
	return s;
}

function appendOpenAiDeltaToParts(delta: Record<string, unknown>, parts: MergedAssistantParts): void {
	const rc = delta.reasoning_content;
	if (typeof rc === 'string' && rc.length > 0) {
		parts.reasoning += rc;
	}
	const th = delta.thinking;
	if (typeof th === 'string' && th.length > 0) {
		parts.reasoning += th;
	}
	const r = delta.reasoning;
	if (typeof r === 'string' && r.length > 0) {
		parts.reasoning += r;
	}
	const c = delta.content;
	if (typeof c === 'string' && c.length > 0) {
		parts.body += c;
	}
}

function mergeOpenAiSseParts(raw: string): MergedAssistantParts {
	const parts = emptyParts();
	for (const line of raw.split(/\r?\n/)) {
		const t = line.trim();
		if (!t.startsWith('data:')) {
			continue;
		}
		const payload = t.slice(5).trim();
		if (payload === '[DONE]' || payload === '') {
			continue;
		}
		let o: unknown;
		try {
			o = JSON.parse(payload);
		} catch {
			continue;
		}
		if (!o || typeof o !== 'object') {
			continue;
		}
		const choices = (o as { choices?: unknown }).choices;
		if (!Array.isArray(choices)) {
			continue;
		}
		for (const ch of choices) {
			if (!ch || typeof ch !== 'object') {
				continue;
			}
			const delta = (ch as { delta?: unknown }).delta;
			if (!delta || typeof delta !== 'object') {
				continue;
			}
			appendOpenAiDeltaToParts(delta as Record<string, unknown>, parts);
		}
	}
	return parts;
}

function mergeAnthropicSseParts(raw: string): MergedAssistantParts {
	const parts = emptyParts();
	let lastEvent = '';
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trimEnd();
		if (trimmed.startsWith('event:')) {
			lastEvent = trimmed.slice(6).trim();
			continue;
		}
		if (!trimmed.startsWith('data:')) {
			continue;
		}
		const dataStr = trimmed.slice(5).trim();
		if (dataStr === '' || dataStr === '[DONE]') {
			lastEvent = '';
			continue;
		}
		let o: unknown;
		try {
			o = JSON.parse(dataStr);
		} catch {
			lastEvent = '';
			continue;
		}
		if (!o || typeof o !== 'object') {
			lastEvent = '';
			continue;
		}
		const obj = o as Record<string, unknown>;
		const isDelta =
			lastEvent === 'content_block_delta' || obj.type === 'content_block_delta';
		if (isDelta) {
			const delta = obj.delta as Record<string, unknown> | undefined;
			if (!delta) {
				lastEvent = '';
				continue;
			}
			if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
				parts.reasoning += delta.thinking;
			}
			if (delta.type === 'text_delta' && typeof delta.text === 'string') {
				parts.body += delta.text;
			}
		}
		lastEvent = '';
	}
	return parts;
}

/** Gemini：带 `thought: true` 的 part 归入推理，其余有 text 的归入正文 */
function appendGeminiPartsToParts(partsArr: unknown, parts: MergedAssistantParts): void {
	if (!Array.isArray(partsArr)) {
		return;
	}
	for (const p of partsArr) {
		if (!p || typeof p !== 'object') {
			continue;
		}
		const part = p as { text?: unknown; thought?: unknown };
		if (typeof part.text !== 'string' || part.text.length === 0) {
			continue;
		}
		if (part.thought === true) {
			parts.reasoning += part.text;
		} else {
			parts.body += part.text;
		}
	}
}

function extractGeminiCandidatesParts(o: unknown): MergedAssistantParts {
	const parts = emptyParts();
	if (!o || typeof o !== 'object') {
		return parts;
	}
	const cands = (o as { candidates?: unknown }).candidates;
	if (!Array.isArray(cands) || cands.length === 0) {
		return parts;
	}
	const first = cands[0];
	if (!first || typeof first !== 'object') {
		return parts;
	}
	const content = (first as { content?: { parts?: unknown } }).content;
	appendGeminiPartsToParts(content?.parts, parts);
	return parts;
}

function mergeGeminiSseParts(raw: string): MergedAssistantParts {
	const acc = emptyParts();
	for (const line of raw.split(/\r?\n/)) {
		const t = line.trim();
		if (!t || t.startsWith(':')) {
			continue;
		}
		let jsonStr = t;
		if (t.startsWith('data:')) {
			jsonStr = t.slice(5).trim();
		}
		if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) {
			continue;
		}
		let o: unknown;
		try {
			o = JSON.parse(jsonStr);
		} catch {
			continue;
		}
		const chunk = extractGeminiCandidatesParts(o);
		acc.reasoning += chunk.reasoning;
		acc.body += chunk.body;
	}
	return acc;
}

/**
 * Responses 协议 SSE：正文取 `response.output_text.delta` 的 `delta`；
 * reasoning 取 `response.reasoning_summary_text.delta` 一类事件（存在则分列）。
 * 终止事件 `response.completed` 携带完整 `output`，此处不重复累加。
 */
function mergeResponsesSseParts(raw: string): MergedAssistantParts {
	const parts = emptyParts();
	for (const line of raw.split('\n')) {
		const t = line.trim();
		if (!t.startsWith('data:')) {
			continue;
		}
		const payload = t.slice(5).trim();
		if (payload === '' || payload === '[DONE]') {
			continue;
		}
		let o: unknown;
		try {
			o = JSON.parse(payload) as unknown;
		} catch {
			continue;
		}
		if (!o || typeof o !== 'object') {
			continue;
		}
		const evt = o as { type?: unknown; delta?: unknown };
		const type = typeof evt.type === 'string' ? evt.type : '';
		const delta = typeof evt.delta === 'string' ? evt.delta : '';
		if (delta === '') {
			continue;
		}
		if (type === 'response.output_text.delta') {
			parts.body += delta;
		} else if (type.includes('reasoning') && type.endsWith('.delta')) {
			parts.reasoning += delta;
		}
	}
	return parts;
}

/** Responses 非流式：response 对象的 `output[]`，正文在 `content[].text`。 */
function extractResponsesOutputParts(o: unknown): MergedAssistantParts {
	const parts = emptyParts();
	if (!o || typeof o !== 'object') {
		return parts;
	}
	const output = (o as { output?: unknown }).output;
	if (!Array.isArray(output)) {
		return parts;
	}
	for (const item of output) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const it = item as { type?: unknown; content?: unknown; summary?: unknown };
		if (it.type === 'reasoning' && Array.isArray(it.summary)) {
			for (const s of it.summary) {
				if (s && typeof s === 'object' && typeof (s as { text?: unknown }).text === 'string') {
					parts.reasoning += (s as { text: string }).text;
				}
			}
			continue;
		}
		if (!Array.isArray(it.content)) {
			continue;
		}
		for (const c of it.content) {
			if (!c || typeof c !== 'object') {
				continue;
			}
			const part = c as { type?: unknown; text?: unknown };
			if (typeof part.text === 'string' && (part.type === 'output_text' || part.type === 'text')) {
				parts.body += part.text;
			}
		}
	}
	return parts;
}

function mergeFromJsonObjectParts(o: unknown, protocol: PlaygroundProtocol): MergedAssistantParts {
	const parts = emptyParts();
	if (!o || typeof o !== 'object') {
		return parts;
	}
	if (protocol === 'openai') {
		const choices = (o as { choices?: unknown }).choices;
		if (!Array.isArray(choices) || choices.length === 0) {
			return parts;
		}
		const msg = (choices[0] as { message?: Record<string, unknown> }).message;
		if (!msg || typeof msg !== 'object') {
			return parts;
		}
		if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0) {
			parts.reasoning += msg.reasoning_content;
		}
		if (typeof msg.thinking === 'string' && msg.thinking.length > 0) {
			parts.reasoning += msg.thinking;
		}
		parts.body += extractOpenAiMessageContent(msg.content);
		return parts;
	}
	if (protocol === 'responses') {
		// SDK 便宜フィールド：あれば最優先（実測 2026-07-27 muyuan.do は返さないが、
		// OpenAI 公式 SDK は付与するため両形状を許容する）。
		const convenience = (o as { output_text?: unknown }).output_text;
		if (typeof convenience === 'string' && convenience.length > 0) {
			parts.body += convenience;
			return parts;
		}
		return extractResponsesOutputParts(o);
	}
	if (protocol === 'anthropic') {
		const blocks = (o as { content?: unknown }).content;
		if (!Array.isArray(blocks)) {
			return parts;
		}
		for (const b of blocks) {
			if (!b || typeof b !== 'object') {
				continue;
			}
			const block = b as { type?: unknown; text?: unknown; thinking?: unknown };
			if (block.type === 'thinking' && typeof block.thinking === 'string') {
				parts.reasoning += block.thinking;
			}
			if (block.type === 'text' && typeof block.text === 'string') {
				parts.body += block.text;
			}
		}
		return parts;
	}
	return extractGeminiCandidatesParts(o);
}

/**
 * 从原始报文拼接 / 抽取：推理类与正文分列。
 */
export function mergeAssistantTextParts(
	raw: string,
	protocol: PlaygroundProtocol,
	mode: PlaygroundResponseParseMode
): MergedAssistantParts {
	if (!raw.trim()) {
		return emptyParts();
	}
	if (mode === 'sse') {
		if (protocol === 'openai') {
			return mergeOpenAiSseParts(raw);
		}
		if (protocol === 'responses') {
			return mergeResponsesSseParts(raw);
		}
		if (protocol === 'anthropic') {
			return mergeAnthropicSseParts(raw);
		}
		return mergeGeminiSseParts(raw);
	}
	if (mode === 'json') {
		try {
			const o = JSON.parse(raw) as unknown;
			return mergeFromJsonObjectParts(o, protocol);
		} catch {
			return emptyParts();
		}
	}
	try {
		const o = JSON.parse(raw) as unknown;
		if (o && typeof o === 'object') {
			return mergeFromJsonObjectParts(o, protocol);
		}
	} catch {
		// ignore
	}
	return emptyParts();
}

/**
 * 从原始报文拼接为单字符串（推理在前、正文在后，无分隔符；仅兼容旧用法）。
 */
export function mergeAssistantText(
	raw: string,
	protocol: PlaygroundProtocol,
	mode: PlaygroundResponseParseMode
): string {
	const p = mergeAssistantTextParts(raw, protocol, mode);
	return p.reasoning + p.body;
}
