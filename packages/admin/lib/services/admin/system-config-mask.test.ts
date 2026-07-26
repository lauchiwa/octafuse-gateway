/**
 * `system-config-mask.ts` 单测（node:test）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	mergeSecretCatalogPreservingKeys,
	isSecretCatalogConfigKey,
	isSensitiveConfigKey,
	maskSecretCatalogJson,
	maskSecretValue,
	maskSystemConfigRow,
} from './system-config-mask';

const REAL_MASTER_KEY = '8bxazSTi2Kbvukzjtbwbea3oeexejNfp';

test('registered sensitive keys are detected', () => {
	for (const k of [
		'MASTER_KEY',
		'WEB_SEARCH_API_KEY',
		'WEB_FETCH_API_KEY',
		'ALERT_WEBHOOK_WECOM_URL',
		'ALERT_WEBHOOK_FEISHU_URL',
		'WEB_SEARCH_CATALOG',
		'WEB_FETCH_CATALOG',
		'WEB_DEEP_SEARCH_CATALOG',
	]) {
		assert.equal(isSensitiveConfigKey(k), true, `${k} should be sensitive`);
	}
});

test('heuristic catches unregistered secret-looking keys', () => {
	for (const k of ['FOO_API_KEY', 'SOME_SECRET', 'GITHUB_TOKEN', 'ALERT_WEBHOOK_SLACK_URL']) {
		assert.equal(isSensitiveConfigKey(k), true, `${k} should be sensitive`);
	}
});

test('non-secret keys are not masked', () => {
	for (const k of [
		'BILLING_CURRENCY',
		'BUSINESS_TIMEZONE',
		'WEB_SEARCH_PROVIDER',
		'WEB_SEARCH_ACTIVE',
		'WEB_FETCH_ACTIVE',
	]) {
		assert.equal(isSensitiveConfigKey(k), false, `${k} should NOT be sensitive`);
	}
});

test('mask reveals only first/last 4 of long values', () => {
	const masked = maskSecretValue(REAL_MASTER_KEY);
	assert.equal(masked, '8bxa…jNfp');
	assert.ok(!masked!.includes(REAL_MASTER_KEY.slice(4, -4)));
});

test('short values are fully hidden', () => {
	assert.equal(maskSecretValue('short'), '••••');
	assert.equal(maskSecretValue('12345678901'), '••••');
});

test('empty / missing values mask to null', () => {
	assert.equal(maskSecretValue(''), null);
	assert.equal(maskSecretValue('   '), null);
	assert.equal(maskSecretValue(null), null);
	assert.equal(maskSecretValue(undefined), null);
});

test('sensitive scalar row drops the value entirely', () => {
	const row = maskSystemConfigRow({ key: 'MASTER_KEY', value: REAL_MASTER_KEY, description: 'd' });
	assert.equal(row.value, null);
	assert.equal(row.is_secret, true);
	assert.equal(row.is_set, true);
	assert.equal(row.value_masked, '8bxa…jNfp');
	// 整行序列化后不得出现明文
	assert.ok(!JSON.stringify(row).includes(REAL_MASTER_KEY));
});

test('unset secret reports not-set with no mask', () => {
	const row = maskSystemConfigRow({ key: 'MASTER_KEY', value: '', description: null });
	assert.equal(row.is_set, false);
	assert.equal(row.value_masked, null);
});

test('non-secret row passes through untouched', () => {
	const row = maskSystemConfigRow({ key: 'BILLING_CURRENCY', value: 'CNY', description: 'd' });
	assert.equal(row.value, 'CNY');
	assert.equal(row.is_secret, false);
	assert.equal(row.value_masked, null);
});

test('catalog keeps cost, masks apiKey, flags apiKeySet', () => {
	const raw = JSON.stringify({
		tavily: { apiKey: 'tvly-abc123def456', cost: 0.01 },
		exa: { apiKey: '', cost: 0.02 },
	});
	const masked = maskSecretCatalogJson(raw)!;
	const parsed = JSON.parse(masked) as Record<string, Record<string, unknown>>;

	assert.equal(parsed.tavily!.cost, 0.01);
	assert.equal(parsed.tavily!.apiKeySet, true);
	assert.equal(parsed.tavily!.apiKey, 'tvly…f456');
	assert.ok(!masked.includes('tvly-abc123def456'));

	assert.equal(parsed.exa!.cost, 0.02);
	assert.equal(parsed.exa!.apiKeySet, false);
});

test('catalog with unexpected shape fails safe', () => {
	assert.equal(maskSecretCatalogJson('not json at all'), null);
	assert.equal(maskSecretCatalogJson('[1,2,3]'), null);
	assert.equal(maskSecretCatalogJson(''), null);
	assert.equal(maskSecretCatalogJson(null), null);
	// provider 值不是对象时整条丢弃，不回落成原值
	const odd = maskSecretCatalogJson(JSON.stringify({ tavily: 'tvly-leak' }))!;
	assert.ok(!odd.includes('tvly-leak'));
});

test('catalog row is routed through catalog masking, not scalar masking', () => {
	const raw = JSON.stringify({ tavily: { apiKey: 'tvly-abc123def456', cost: 0.03 } });
	const row = maskSystemConfigRow({ key: 'WEB_SEARCH_CATALOG', value: raw, description: null });
	assert.equal(row.is_secret, true);
	assert.ok(row.value != null, 'catalog value must survive so the UI keeps cost');
	assert.ok(!row.value!.includes('tvly-abc123def456'));
	assert.ok(row.value!.includes('0.03'));
});

test('isSecretCatalogConfigKey distinguishes catalogs from scalars', () => {
	assert.equal(isSecretCatalogConfigKey('WEB_SEARCH_CATALOG'), true);
	assert.equal(isSecretCatalogConfigKey('MASTER_KEY'), false);
});

test('catalog merge keeps stored key when incoming apiKey is empty', () => {
	const stored = JSON.stringify({ tavily: { apiKey: 'tvly-real-secret', cost: 0.01 } });
	// 前端只改了成本，apiKey 草稿为空
	const merged = mergeSecretCatalogPreservingKeys({ tavily: { apiKey: '', cost: 0.05 } }, stored);
	assert.equal(merged.tavily!.apiKey, 'tvly-real-secret');
	assert.equal(merged.tavily!.cost, 0.05);
});

test('catalog merge takes the new key when provided', () => {
	const stored = JSON.stringify({ tavily: { apiKey: 'tvly-old', cost: 0.01 } });
	const merged = mergeSecretCatalogPreservingKeys({ tavily: { apiKey: 'tvly-new', cost: 0.01 } }, stored);
	assert.equal(merged.tavily!.apiKey, 'tvly-new');
});

test('catalog merge tolerates missing/corrupt stored value', () => {
	for (const stored of [null, '', 'not json', '[1]']) {
		const merged = mergeSecretCatalogPreservingKeys({ tavily: { apiKey: '', cost: 0.01 } }, stored);
		assert.equal(merged.tavily!.apiKey, '');
	}
});

test('catalog merge drops providers absent from the incoming payload', () => {
	const stored = JSON.stringify({ tavily: { apiKey: 'a', cost: 1 }, exa: { apiKey: 'b', cost: 2 } });
	const merged = mergeSecretCatalogPreservingKeys({ tavily: { apiKey: '', cost: 1 } }, stored);
	assert.deepStrictEqual(Object.keys(merged), ['tavily']);
});
