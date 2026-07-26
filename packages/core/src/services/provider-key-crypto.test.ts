/**
 * `services/provider-key-crypto.ts` 单测（node:test）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	createProviderKeyCrypto,
	decryptProviderApiKey,
	encryptProviderApiKey,
	isEncryptedProviderApiKey,
} from './provider-key-crypto';

const SECRET = 'a-long-random-worker-secret-value';
const UPSTREAM_KEY = 'sk-proj-AbCdEf0123456789upstreamprovidersecret';

test('round-trips', async () => {
	const enc = await encryptProviderApiKey(UPSTREAM_KEY, SECRET);
	assert.equal(await decryptProviderApiKey(enc, SECRET), UPSTREAM_KEY);
});

test('ciphertext does not contain the plaintext', async () => {
	const enc = await encryptProviderApiKey(UPSTREAM_KEY, SECRET);
	assert.ok(!enc.includes(UPSTREAM_KEY));
	assert.ok(!enc.includes(UPSTREAM_KEY.slice(8, 30)));
	assert.ok(enc.startsWith('ofk1.'));
});

test('same plaintext encrypts differently each time (random IV)', async () => {
	const a = await encryptProviderApiKey(UPSTREAM_KEY, SECRET);
	const b = await encryptProviderApiKey(UPSTREAM_KEY, SECRET);
	assert.notEqual(a, b);
	// 但都能解回同一明文
	assert.equal(await decryptProviderApiKey(a, SECRET), UPSTREAM_KEY);
	assert.equal(await decryptProviderApiKey(b, SECRET), UPSTREAM_KEY);
});

test('wrong secret fails loudly, never returns garbage', async () => {
	const enc = await encryptProviderApiKey(UPSTREAM_KEY, SECRET);
	await assert.rejects(() => decryptProviderApiKey(enc, 'wrong-secret'), /Failed to decrypt provider key/);
});

test('tampered ciphertext is rejected (AES-GCM auth)', async () => {
	const enc = await encryptProviderApiKey(UPSTREAM_KEY, SECRET);
	const parts = enc.split('.');
	const flipped = parts[2]!.slice(0, -2) + (parts[2]!.endsWith('AA') ? 'BB' : 'AA');
	await assert.rejects(() => decryptProviderApiKey(`${parts[0]}.${parts[1]}.${flipped}`, SECRET));
});

test('legacy plaintext passes through unchanged', async () => {
	assert.equal(await decryptProviderApiKey(UPSTREAM_KEY, SECRET), UPSTREAM_KEY);
	assert.equal(await decryptProviderApiKey(UPSTREAM_KEY, null), UPSTREAM_KEY);
	assert.equal(isEncryptedProviderApiKey(UPSTREAM_KEY), false);
});

test('encrypted value without a secret fails closed on read', async () => {
	const enc = await encryptProviderApiKey(UPSTREAM_KEY, SECRET);
	await assert.rejects(() => decryptProviderApiKey(enc, null), /not configured/);
});

test('writing without a secret fails closed', async () => {
	await assert.rejects(() => encryptProviderApiKey(UPSTREAM_KEY, ''), /refusing to store/);
	await assert.rejects(() => encryptProviderApiKey(UPSTREAM_KEY, null), /refusing to store/);
});

test('malformed ciphertext is rejected', async () => {
	await assert.rejects(() => decryptProviderApiKey('ofk1.onlytwo', SECRET), /Malformed/);
});

test('crypto handle mirrors the standalone functions', async () => {
	const c = createProviderKeyCrypto(SECRET);
	assert.equal(await c.decrypt(await c.encrypt(UPSTREAM_KEY)), UPSTREAM_KEY);
	const noSecret = createProviderKeyCrypto(null);
	assert.equal(await noSecret.decrypt(UPSTREAM_KEY), UPSTREAM_KEY); // 历史明文仍可读
	await assert.rejects(() => noSecret.encrypt(UPSTREAM_KEY)); // 但不允许写
});

test('unicode and long keys survive the round trip', async () => {
	for (const v of ['ключ-测试-🔑', 'x'.repeat(4096), '']) {
		assert.equal(await decryptProviderApiKey(await encryptProviderApiKey(v || 'e', SECRET), SECRET), v || 'e');
	}
});
