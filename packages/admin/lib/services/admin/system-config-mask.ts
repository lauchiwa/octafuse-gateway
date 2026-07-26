/**
 * `GET /admin/config` 敏感值脱敏。
 *
 * `system_config` 里混放了普通配置（币种、时区、成本）与凭据（MASTER_KEY、第三方服务密钥、
 * 带 token 的 webhook URL）。列表接口原先原样返回全部值，任何已鉴权调用方都能拿到明文凭据 ——
 * 也正是绕过漏洞期间 MASTER_KEY 被暴露的那条路径。
 *
 * 策略与网关密钥一致：**可写入，不可读回**。写路径不变，读路径只给掩码 + 是否已配置。
 * 丢失凭据的带外恢复通道见 `npm run deploy:cloudflare -- <instance> --show-master-key`（直读 D1）。
 */

/** 明确登记的敏感标量键。 */
const SENSITIVE_CONFIG_KEYS = new Set([
	'MASTER_KEY',
	'WEB_SEARCH_API_KEY',
	'WEB_FETCH_API_KEY',
	'ALERT_WEBHOOK_WECOM_URL',
	'ALERT_WEBHOOK_FEISHU_URL',
]);

/** JSON 目录键：值形如 `{ "<provider>": { apiKey, cost } }`，只脱敏 `apiKey`。 */
const SECRET_CATALOG_KEYS = new Set([
	'WEB_SEARCH_CATALOG',
	'WEB_FETCH_CATALOG',
	'WEB_DEEP_SEARCH_CATALOG',
]);

/**
 * 名称启发式兜底：日后新增 `FOO_API_KEY` 这类键无需登记即被脱敏。
 * 故意不匹配 `WEB_SEARCH_PROVIDER` / `*_ACTIVE` 等非凭据键。
 */
const SENSITIVE_NAME_PATTERN = /(_KEY|_SECRET|_TOKEN)$/;
const SENSITIVE_WEBHOOK_PATTERN = /^ALERT_WEBHOOK_.*_URL$/;

/** 短于该长度的值不露出任何字符（露头尾对短密钥没有意义且有害）。 */
const MASK_MIN_REVEALABLE_LENGTH = 12;

export type MaskedAdminConfigRow = {
	key: string;
	/** 敏感标量为 `null`；目录键为已脱敏的 JSON；普通键为原值。 */
	value: string | null;
	description: string | null;
	is_secret: boolean;
	/** 是否已配置（供前端显示「已配置 / 未配置」，不泄露内容）。 */
	is_set: boolean;
	/** 形如 `8bxa…xejN`；未配置或非敏感时为 `null`。 */
	value_masked: string | null;
};

/** 是否为需要脱敏的键（含目录键）。 */
export function isSensitiveConfigKey(key: string): boolean {
	return (
		SENSITIVE_CONFIG_KEYS.has(key) ||
		SECRET_CATALOG_KEYS.has(key) ||
		SENSITIVE_NAME_PATTERN.test(key) ||
		SENSITIVE_WEBHOOK_PATTERN.test(key)
	);
}

/** 是否为 JSON 目录键。 */
export function isSecretCatalogConfigKey(key: string): boolean {
	return SECRET_CATALOG_KEYS.has(key);
}

/** 生成掩码：长值露首尾各 4 位，短值全遮。空值返回 `null`。 */
export function maskSecretValue(value: string | null | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	if (trimmed === '') return null;
	if (trimmed.length < MASK_MIN_REVEALABLE_LENGTH) return '••••';
	return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

/**
 * 目录 JSON 脱敏：逐 provider 把 `apiKey` 换成掩码，保留 `cost` 等其余字段，
 * 并加 `apiKeySet` 供前端区分「已配置」与「空串」。
 *
 * 解析失败时整体遮蔽（fail safe，不 fail open）。
 */
export function maskSecretCatalogJson(raw: string | null | undefined): string | null {
	if (raw == null || raw.trim() === '') return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return null;
	}
	const out: Record<string, unknown> = {};
	for (const [provider, entry] of Object.entries(parsed as Record<string, unknown>)) {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
			// 结构不符合预期时不保留原值，避免把密钥藏在异常形态里漏出去。
			continue;
		}
		const rec = entry as Record<string, unknown>;
		const apiKeyRaw = typeof rec.apiKey === 'string' ? rec.apiKey : '';
		const masked: Record<string, unknown> = {};
		for (const [field, fieldValue] of Object.entries(rec)) {
			if (field === 'apiKey') continue;
			masked[field] = fieldValue;
		}
		masked.apiKey = maskSecretValue(apiKeyRaw) ?? '';
		masked.apiKeySet = apiKeyRaw.trim() !== '';
		out[provider] = masked;
	}
	return JSON.stringify(out);
}

/** 单行脱敏；非敏感键原样返回。 */
export function maskSystemConfigRow(row: {
	key: string;
	value: string | null;
	description: string | null;
}): MaskedAdminConfigRow {
	const rawValue = row.value ?? '';
	const isSet = rawValue.trim() !== '';

	if (!isSensitiveConfigKey(row.key)) {
		return {
			key: row.key,
			value: rawValue,
			description: row.description,
			is_secret: false,
			is_set: isSet,
			value_masked: null,
		};
	}

	if (isSecretCatalogConfigKey(row.key)) {
		return {
			key: row.key,
			// 目录仍需返回结构（`cost` 等非敏感字段前端要用），仅 `apiKey` 被遮。
			value: maskSecretCatalogJson(row.value),
			description: row.description,
			is_secret: true,
			is_set: isSet,
			value_masked: null,
		};
	}

	return {
		key: row.key,
		value: null,
		description: row.description,
		is_secret: true,
		is_set: isSet,
		value_masked: maskSecretValue(row.value),
	};
}

/**
 * 目录写入合并：入参里 `apiKey` 为空的 provider 沿用库中已存值。
 *
 * 必要性：前端不再回读密钥（草稿为空），若直接整体覆盖，「只改成本」会把密钥抹成空串。
 * 空 `apiKey` 语义统一为「不修改」；要清除某个 provider，从目录里移除该条目。
 */
export function mergeSecretCatalogPreservingKeys(
	incoming: Record<string, { apiKey?: string; cost?: number } & Record<string, unknown>>,
	storedRaw: string | null | undefined
): Record<string, { apiKey?: string; cost?: number } & Record<string, unknown>> {
	let stored: Record<string, { apiKey?: unknown }> = {};
	if (storedRaw != null && storedRaw.trim() !== '') {
		try {
			const parsed = JSON.parse(storedRaw);
			if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
				stored = parsed as Record<string, { apiKey?: unknown }>;
			}
		} catch {
			stored = {};
		}
	}

	const merged: Record<string, { apiKey?: string; cost?: number } & Record<string, unknown>> = {};
	for (const [provider, entry] of Object.entries(incoming)) {
		const incomingKey = typeof entry.apiKey === 'string' ? entry.apiKey.trim() : '';
		if (incomingKey !== '') {
			merged[provider] = entry;
			continue;
		}
		const storedKey = stored[provider]?.apiKey;
		merged[provider] = {
			...entry,
			apiKey: typeof storedKey === 'string' ? storedKey : '',
		};
	}
	return merged;
}
