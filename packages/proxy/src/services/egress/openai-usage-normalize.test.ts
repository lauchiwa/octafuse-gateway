/**
 * `normalizeInputTokensFromPrompt` 归一化单测（node:test）。
 *
 * 背景：网关计费公式假设 `input_tokens = regular + cache_read + cache_write`
 * （见 `services/usage-tracker.ts` 的 `computeMeteredCost`）。上游对 prompt 口径不一致：
 * - 「已含缓存」口径（OpenAI）：prompt_tokens 已包含 cached。
 * - 「不含缓存」口径（部分中转）：prompt_tokens 仅为非缓存输入。
 *
 * 归一化写错会静默少算：把 4388（已含 3840 缓存）当成不含缓存口径去加，
 * 或反过来把不含缓存的值直接当 input_tokens，都会算错钱。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInputTokensFromPrompt } from './openai-driver';

test('prompt-includes-cache convention is passed through unchanged', () => {
	// OpenAI 口径：prompt 4388 已包含 3840 cached。归一后仍是 4388。
	const input = normalizeInputTokensFromPrompt({
		promptTokens: 4388,
		completionTokens: 5,
		cacheRead: 3840,
		cacheWrite: 0,
		totalTokens: 4393,
	});
	assert.strictEqual(input, 4388);
});

test('prompt-excludes-cache convention is reconciled upward', () => {
	// 兼容口径：prompt 548 只是非缓存部分，cached 3840 另计。
	// 归一后必须是 548 + 3840 = 4388，否则少算 87%。
	const input = normalizeInputTokensFromPrompt({
		promptTokens: 548,
		completionTokens: 5,
		cacheRead: 3840,
		cacheWrite: 0,
		totalTokens: 4393,
	});
	assert.strictEqual(input, 4388);
});

test('no cache tokens leaves prompt untouched', () => {
	const input = normalizeInputTokensFromPrompt({
		promptTokens: 1200,
		completionTokens: 30,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1230,
	});
	assert.strictEqual(input, 1200);
});

test('cache_write counts toward input the same way cache_read does', () => {
	const input = normalizeInputTokensFromPrompt({
		promptTokens: 100,
		completionTokens: 10,
		cacheRead: 0,
		cacheWrite: 900,
		totalTokens: 1010,
	});
	assert.strictEqual(input, 1000);
});

test('billing identity holds after normalisation (regular is never negative)', () => {
	// computeMeteredCost 会算 regular = input - cache_read - cache_write。
	// 归一化的契约是让这个差值 >= 0，否则会出现负数计费项。
	const cases = [
		{ promptTokens: 4388, cacheRead: 3840, cacheWrite: 0 },
		{ promptTokens: 548, cacheRead: 3840, cacheWrite: 0 },
		{ promptTokens: 100, cacheRead: 60, cacheWrite: 40 },
		{ promptTokens: 0, cacheRead: 0, cacheWrite: 0 },
	];
	for (const c of cases) {
		const input = normalizeInputTokensFromPrompt({
			promptTokens: c.promptTokens,
			completionTokens: 1,
			cacheRead: c.cacheRead,
			cacheWrite: c.cacheWrite,
		});
		const regular = input - c.cacheRead - c.cacheWrite;
		assert.ok(
			regular >= 0,
			`regular must not go negative: prompt=${c.promptTokens} read=${c.cacheRead} write=${c.cacheWrite} -> input=${input} regular=${regular}`
		);
	}
});
