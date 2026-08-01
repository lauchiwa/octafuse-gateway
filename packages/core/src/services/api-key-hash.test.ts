/**
 * `services/api-key-hash.ts` 单测（node:test）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiKeyPrefix, hashApiKey, maskApiKeyFromPrefix } from './api-key-hash';

const KEY = 'sk-AbCdEfGh1234567890abcdefghijKLMN';

test('hash is stable, 64-char lowercase hex', async () => {
	const h1 = await hashApiKey(KEY);
	const h2 = await hashApiKey(KEY);
	assert.equal(h1, h2);
	assert.match(h1, /^[0-9a-f]{64}$/);
});

test('known SHA-256 vector', async () => {
	// echo -n "abc" | shasum -a 256
	assert.equal(
		await hashApiKey('abc'),
		'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
	);
});

test('different keys hash differently', async () => {
	const a = await hashApiKey(KEY);
	const b = await hashApiKey(`${KEY}x`);
	assert.notEqual(a, b);
});

test('hash does not leak the plaintext', async () => {
	const h = await hashApiKey(KEY);
	assert.ok(!h.includes(KEY));
	assert.ok(!h.includes(KEY.slice(3, 20)));
});

test('prefix keeps sk- plus 8 chars', () => {
	assert.equal(apiKeyPrefix(KEY), 'sk-AbCdEfGh');
	assert.equal(apiKeyPrefix(KEY).length, 11);
	assert.ok(KEY.startsWith(apiKeyPrefix(KEY)));
	// 短输入不抛错
	assert.equal(apiKeyPrefix('sk-'), 'sk-');
});

test('mask renders from prefix only, never the full key', () => {
	const masked = maskApiKeyFromPrefix(apiKeyPrefix(KEY));
	assert.ok(masked.startsWith('sk-'));
	assert.ok(!masked.includes(KEY.slice(11)));
	assert.equal(maskApiKeyFromPrefix(null), 'sk-…');
	assert.equal(maskApiKeyFromPrefix(''), 'sk-…');
});

test('migration sentinel can never collide with a real hash', async () => {
	// 迁移把存量行置为 `migrated:<id>`；真实哈希是 64 位纯 hex，不含冒号
	const sentinel = 'migrated:abc-123';
	assert.ok(!/^[0-9a-f]{64}$/.test(sentinel));
	assert.notEqual(await hashApiKey(KEY), sentinel);
});
