import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeUpstreamHeaders } from './merge-upstream-headers';

test('returns base unchanged when custom is empty / nullish', () => {
	const base = { Authorization: 'Bearer x', 'Content-Type': 'application/json' };
	assert.equal(mergeUpstreamHeaders(base, undefined), base);
	assert.equal(mergeUpstreamHeaders(base, null), base);
	assert.equal(mergeUpstreamHeaders(base, {}), base);
});

test('merges neutral custom headers into base', () => {
	const merged = mergeUpstreamHeaders(
		{ Authorization: 'Bearer x' },
		{ 'User-Agent': 'myapp/1.0' },
	);
	assert.equal(merged['User-Agent'], 'myapp/1.0');
	assert.equal(merged['Authorization'], 'Bearer x');
});

test('driver base headers always win over conflicting custom headers', () => {
	const merged = mergeUpstreamHeaders(
		{ Authorization: 'Bearer real', 'anthropic-version': '2023-06-01' },
		{ Authorization: 'Bearer leak', 'anthropic-version': 'evil', 'User-Agent': 'ua' },
	);
	// 鉴权/协议 header 不可被 custom 覆盖
	assert.equal(merged['Authorization'], 'Bearer real');
	assert.equal(merged['anthropic-version'], '2023-06-01');
	// 中性字段仍然注入
	assert.equal(merged['User-Agent'], 'ua');
});

test('does not mutate the input base object', () => {
	const base = { Authorization: 'Bearer x' };
	mergeUpstreamHeaders(base, { 'User-Agent': 'ua' });
	assert.deepEqual(base, { Authorization: 'Bearer x' });
});
