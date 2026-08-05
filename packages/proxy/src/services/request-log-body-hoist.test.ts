/**
 * 回归测试：把 `upstream_request_body` 的脱敏提前到 `scheduleBackgroundWork` 之前（避免后台闭包
 * 捕获整个请求体，见 Error 1102 排查）之所以安全且有效，依赖两个不变量：
 *
 * 1. **产物有界** —— 脱敏结果与请求体规模无关。否则「提前算出短字符串」这个前提不成立，
 *    闭包仍会持有大对象。
 * 2. **计算无副作用** —— `buildRouteRequestBody` 不改动用户 body。否则提前计算与
 *    原先在流结束后计算会得到不同结果，落库值静默变化。
 *
 * 任一条被破坏，1102 就会以「并发大请求时 isolate 内存超限」的形式回归，而这类失败
 * 不会进请求日志（Worker 先被终止），排查成本极高。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_REQUEST_LOG_JSON, finalizeRequestLogJson } from './request-log-shared';
import { buildRouteRequestBody } from './route-default-params';
import type { RouteResult } from './model-router';

/** 构造一个近似生产峰值的会话体：41 万 token 量级。 */
function hugeConversation(turns: number): Record<string, unknown> {
  const messages = Array.from({ length: turns }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text: 'x'.repeat(2000) }],
  }));
  return {
    model: 'claude-opus-5',
    max_tokens: 4096,
    stream: true,
    system: 'y'.repeat(50_000),
    messages,
  };
}

function routeStub(overrides: Partial<RouteResult> = {}): RouteResult {
  return {
    targetId: 't1',
    modelSurfaceId: null,
    routePoolId: null,
    providerId: 'p1',
    providerName: 'stub',
    providerModelName: 'upstream-model',
    upstreamProtocol: 'anthropic',
    upstreamOperation: 'messages',
    adapter: 'passthrough',
    providerEndpoints: {},
    providerCustomHeaders: {},
    providerApiKey: 'k',
    priceOverrideRaw: null,
    routeMeteredProfileJson: null,
    routeChargedProfileJson: null,
    customParams: null,
    routeGroup: 'default',
    routePriority: 10,
    routeWeight: 1,
    ...overrides,
  } as RouteResult;
}

test('脱敏产物有界：请求体放大 100 倍，日志列长度不随之增长', () => {
  // 与各路由的脱敏一致：丢弃 messages / system，只留计数。
  const redact = (b: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) {
      if (k === 'messages' || k === 'system') continue;
      out[k] = v;
    }
    if (Array.isArray(b.messages)) out._messages_count = b.messages.length;
    return out;
  };

  const small = finalizeRequestLogJson(redact(hugeConversation(2)));
  const huge = finalizeRequestLogJson(redact(hugeConversation(200)));
  assert.ok(small && huge);

  // 原始体积随对话轮数增长（小样本里 50KB 的 system 占主体，故用绝对量级校验）
  const rawSmall = JSON.stringify(hugeConversation(2)).length;
  const rawHuge = JSON.stringify(hugeConversation(200)).length;
  assert.ok(rawHuge > 400_000, `raw huge body should be ~400KB+, got ${rawHuge}`);
  assert.ok(rawHuge > rawSmall * 8, `raw should scale with turns: ${rawSmall} -> ${rawHuge}`);

  // 但日志产物必须保持在同一量级，且远小于原始体积
  assert.ok(huge.length < 1_000, `log body must stay small, got ${huge.length}`);
  assert.ok(huge.length < rawHuge / 100, 'log body must not scale with request size');
  assert.ok(huge.length <= MAX_REQUEST_LOG_JSON);
});

test('产物硬性封顶：即使脱敏后仍超长也被截断', () => {
  const bloated = { blob: 'z'.repeat(MAX_REQUEST_LOG_JSON * 2) };
  const s = finalizeRequestLogJson(bloated);
  assert.ok(s);
  assert.ok(s.length <= MAX_REQUEST_LOG_JSON + 20, `got ${s.length}`);
  assert.match(s, /\.\.\.\[truncated\]$/);
});

test('buildRouteRequestBody 不改动用户 body：提前计算与流结束后计算等价', () => {
  const body = hugeConversation(4);
  const before = JSON.stringify(body);
  const merged = buildRouteRequestBody(
    routeStub({ customParams: { temperature: 0.3, nested: { a: 1 } } }),
    body
  );
  assert.equal(JSON.stringify(body), before, 'user body must not be mutated');
  assert.equal(merged.temperature, 0.3, 'route default applied to the merged copy');
  assert.equal((body as { temperature?: unknown }).temperature, undefined);
});

test('messages 数组按引用透传：合并不复制大对话（内存前提）', () => {
  const body = hugeConversation(50);
  const merged = buildRouteRequestBody(routeStub({ customParams: { top_p: 0.9 } }), body);
  assert.equal(merged.messages, body.messages, 'messages must be the same array reference');
});
