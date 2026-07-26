/**
 * 网关下游密钥（`sk-`）的哈希与展示工具。
 *
 * 密钥**不再明文入库**：`api_keys.key_hash` 存 SHA-256 十六进制，`api_keys.key_prefix` 仅存前 11 位供后台展示。
 * 明文只在创建时返回一次，之后无法从库中还原。
 *
 * 选用 SHA-256 而非慢速 KDF：密钥是 32 字节随机值（62 字符表，约 190 bit 熵），
 * 不存在字典/暴力风险，而鉴权在代理热路径上，慢哈希只会徒增每请求延迟。
 */

/** 展示用前缀长度：`sk-` + 8 位。 */
const KEY_PREFIX_LENGTH = 11;

/** 计算密钥的 SHA-256 十六进制摘要（小写，64 字符）。 */
export async function hashApiKey(plaintextKey: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plaintextKey));
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** 取展示用前缀（`sk-` + 8 位）；短于该长度时原样返回。 */
export function apiKeyPrefix(plaintextKey: string): string {
	return plaintextKey.slice(0, KEY_PREFIX_LENGTH);
}

/**
 * 后台展示用掩码。仅依赖 `key_prefix`，因为明文已不可还原。
 * 无前缀（如迁移前的历史行）返回固定占位。
 */
export function maskApiKeyFromPrefix(keyPrefix: string | null | undefined): string {
	if (!keyPrefix) return 'sk-…';
	return `${keyPrefix}…`;
}
