/**
 * `lib/auth.ts` 会话签名/校验单测（node:test 运行）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCookieSecure,
  issueSessionToken,
  verifySessionToken,
  verifyRequestSession,
  readCookie,
} from './auth';

const PASSWORD = 'correct horse battery staple';

test('valid token round-trips', async () => {
  const token = await issueSessionToken(PASSWORD);
  assert.equal(await verifySessionToken(token, PASSWORD), true);
});

test('wrong password is rejected', async () => {
  const token = await issueSessionToken(PASSWORD);
  assert.equal(await verifySessionToken(token, 'other-password'), false);
});

test('tampered payload is rejected', async () => {
  const token = await issueSessionToken(PASSWORD);
  const [, sig] = token.split('.');
  // 用另一段合法 payload 拼原签名 → 签名与 payload 不匹配
  const otherToken = await issueSessionToken(PASSWORD);
  const [otherPayload] = otherToken.split('.');
  const forged = `${otherPayload}.${sig}`;
  assert.equal(await verifySessionToken(forged, PASSWORD), false);
});

test('tampered signature is rejected', async () => {
  const token = await issueSessionToken(PASSWORD);
  const [payload] = token.split('.');
  const forged = `${payload}.YWJjZGVm`; // 任意 base64url 假签名
  assert.equal(await verifySessionToken(forged, PASSWORD), false);
});

test('expired token is rejected', async () => {
  const token = await issueSessionToken(PASSWORD, -10); // 已过期
  assert.equal(await verifySessionToken(token, PASSWORD), false);
});

test('arbitrary / malformed values are rejected (the old bypass)', async () => {
  for (const bad of ['totally-fake-value', '', 'a.b.c', 'nodot', '.', 'a.']) {
    assert.equal(await verifySessionToken(bad, PASSWORD), false, `should reject: ${JSON.stringify(bad)}`);
  }
});

test('empty password never authenticates', async () => {
  const token = await issueSessionToken(PASSWORD);
  assert.equal(await verifySessionToken(token, ''), false);
  assert.equal(await verifySessionToken(token, undefined), false);
});

test('readCookie extracts the right value among many', () => {
  const header = 'foo=1; admin_session=abc.def; bar=2';
  assert.equal(readCookie(header, 'admin_session'), 'abc.def');
  assert.equal(readCookie(header, 'missing'), null);
  assert.equal(readCookie(null, 'admin_session'), null);
  // 子串不应误命中（旧实现的问题）
  assert.equal(readCookie('xadmin_session=nope', 'admin_session'), null);
});

test('verifyRequestSession validates cookie from request headers', async () => {
  const token = await issueSessionToken(PASSWORD);
  const good = new Request('https://x/api/admin/models', {
    headers: { cookie: `admin_session=${token}` },
  });
  assert.equal(await verifyRequestSession(good, PASSWORD), true);

  const forged = new Request('https://x/api/admin/models', {
    headers: { cookie: 'admin_session=totally-fake-value' },
  });
  assert.equal(await verifyRequestSession(forged, PASSWORD), false);

  const none = new Request('https://x/api/admin/models');
  assert.equal(await verifyRequestSession(none, PASSWORD), false);
});

test('cookie Secure follows request protocol when unset', () => {
	delete process.env.ADMIN_COOKIE_SECURE;
	assert.equal(resolveCookieSecure(new Request('https://admin.example/x')), true);
	assert.equal(resolveCookieSecure(new Request('http://localhost:8789/x')), false);
	// 无 request 时保守取 false（不破坏纯 HTTP 部署）
	assert.equal(resolveCookieSecure(), false);
});

test('explicit ADMIN_COOKIE_SECURE overrides both ways', () => {
	process.env.ADMIN_COOKIE_SECURE = '1';
	assert.equal(resolveCookieSecure(new Request('http://plain.example/x')), true);
	process.env.ADMIN_COOKIE_SECURE = '0';
	assert.equal(resolveCookieSecure(new Request('https://admin.example/x')), false);
	delete process.env.ADMIN_COOKIE_SECURE;
});
