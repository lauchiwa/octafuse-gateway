import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	STICKY_DEFAULT_SHORT_WAIT_MS,
	STICKY_DEFAULT_TTL_SECONDS,
	normalizeModelStickyConfigInput,
	parseModelStickyConfig,
	resolveStickyRouteRule,
} from './model-sticky-config';

describe('parseModelStickyConfig', () => {
	it('returns null for empty / invalid / rule-less configs', () => {
		assert.strictEqual(parseModelStickyConfig(null), null);
		assert.strictEqual(parseModelStickyConfig(''), null);
		assert.strictEqual(parseModelStickyConfig('not json'), null);
		assert.strictEqual(parseModelStickyConfig('{"ttl_seconds":600}'), null);
		assert.strictEqual(parseModelStickyConfig('{"rules":{}}'), null);
	});

	it('parses rules with top-level defaults', () => {
		const config = parseModelStickyConfig(
			'{"ttl_seconds":300,"short_wait_ms":2000,"rules":{"openai:default":{"enabled":true}}}'
		);
		assert.notStrictEqual(config, null);
		assert.strictEqual(config!.ttlSeconds, 300);
		assert.strictEqual(config!.shortWaitMs, 2000);
		assert.deepStrictEqual(config!.rules.get('openai:default'), { enabled: true, ttlSeconds: null, shortWaitMs: null });
	});

	it('falls back to code defaults when top-level values are missing', () => {
		const config = parseModelStickyConfig('{"rules":{"openai:default":{"enabled":true}}}');
		assert.strictEqual(config!.ttlSeconds, STICKY_DEFAULT_TTL_SECONDS);
		assert.strictEqual(config!.shortWaitMs, STICKY_DEFAULT_SHORT_WAIT_MS);
	});

	it('normalizes rule keys to lowercase and skips malformed keys', () => {
		const config = parseModelStickyConfig(
			'{"rules":{"OpenAI:Default":{"enabled":true},"nocolon":{"enabled":true}}}'
		);
		assert.strictEqual(config!.rules.has('openai:default'), true);
		assert.strictEqual(config!.rules.size, 1);
	});
});

describe('resolveStickyRouteRule', () => {
	const raw = JSON.stringify({
		ttl_seconds: 300,
		rules: {
			'openai:default': { enabled: true },
			'openai:free': { enabled: true, ttl_seconds: 120, short_wait_ms: 1000 },
			'anthropic:default': { enabled: false },
		},
	});

	it('resolves an enabled rule with merged defaults', () => {
		assert.deepStrictEqual(resolveStickyRouteRule(raw, 'openai', 'default'), {
			ttlSeconds: 300,
			shortWaitMs: STICKY_DEFAULT_SHORT_WAIT_MS,
		});
	});

	it('lets per-rule overrides win over top-level defaults', () => {
		assert.deepStrictEqual(resolveStickyRouteRule(raw, 'openai', 'free'), { ttlSeconds: 120, shortWaitMs: 1000 });
	});

	it('matches protocol and group case-insensitively', () => {
		assert.notStrictEqual(resolveStickyRouteRule(raw, 'OpenAI', 'DEFAULT'), null);
	});

	it('returns null for disabled or missing rules and null configs', () => {
		assert.strictEqual(resolveStickyRouteRule(raw, 'anthropic', 'default'), null);
		assert.strictEqual(resolveStickyRouteRule(raw, 'gemini', 'default'), null);
		assert.strictEqual(resolveStickyRouteRule(null, 'openai', 'default'), null);
	});
});

describe('normalizeModelStickyConfigInput', () => {
	it('returns null for empty input (clear config = sticky off)', () => {
		assert.strictEqual(normalizeModelStickyConfigInput(null), null);
		assert.strictEqual(normalizeModelStickyConfigInput('  '), null);
	});

	it('normalizes keys and keeps only known rule fields', () => {
		const out = normalizeModelStickyConfigInput(
			'{"rules":{"OpenAI:Default":{"enabled":true,"ttl_seconds":120,"junk":1}},"ttl_seconds":300}'
		);
		assert.deepStrictEqual(JSON.parse(out!), {
			rules: { 'openai:default': { enabled: true, ttl_seconds: 120 } },
			ttl_seconds: 300,
		});
	});

	it('preserves explicit enabled=false rules', () => {
		const out = normalizeModelStickyConfigInput('{"rules":{"openai:default":{"enabled":false}}}');
		assert.deepStrictEqual(JSON.parse(out!), { rules: { 'openai:default': { enabled: false } } });
	});

	it('throws for invalid JSON, malformed rule keys and empty rules', () => {
		assert.throws(() => normalizeModelStickyConfigInput('nope'), /valid JSON/);
		assert.throws(() => normalizeModelStickyConfigInput('{"rules":{"bad":{"enabled":true}}}'), /\{protocol\}:\{route_group\}/);
		assert.throws(() => normalizeModelStickyConfigInput('{"rules":{}}'), /at least one rule/);
	});
});
