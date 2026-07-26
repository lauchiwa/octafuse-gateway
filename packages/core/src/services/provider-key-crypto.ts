/**
 * Provider 上游密钥的静态加密（AES-GCM）。
 *
 * 密文格式：`ofk1.<base64url(iv)>.<base64url(密文‖tag)>`
 * - 密钥 = `SHA-256(PROVIDER_KEY_ENCRYPTION_KEY)`，因此 secret 可以是任意长度/字符集。
 * - 每个值用独立的 12 字节随机 IV。
 * - `ofk1` 为版本标记，日后换算法或换密钥可用 `ofk2` 并存而不产生歧义。
 *
 * 不以 `ofk1.` 开头的值视为**迁移前的历史明文**，原样返回。正是这一点让代码可以先于数据上线：
 * 部署后历史密钥继续可用，再通过管理端一次性回填转换。
 */

const CIPHER_PREFIX = 'ofk1';
const IV_BYTE_LENGTH = 12;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function base64urlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
	const material = await crypto.subtle.digest('SHA-256', textEncoder.encode(secret));
	return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** 是否为本模块产出的密文（而非历史明文）。 */
export function isEncryptedProviderApiKey(stored: string | null | undefined): boolean {
	return typeof stored === 'string' && stored.startsWith(`${CIPHER_PREFIX}.`);
}

/** 加密上游密钥；`secret` 为空时抛错（调用方须 fail closed，不得静默存明文）。 */
export async function encryptProviderApiKey(plaintext: string, secret: string | null | undefined): Promise<string> {
	if (!secret) {
		throw new Error(
			'PROVIDER_KEY_ENCRYPTION_KEY is not configured; refusing to store an upstream provider key in plaintext'
		);
	}
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
	const key = await deriveAesKey(secret);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		textEncoder.encode(plaintext)
	);
	return `${CIPHER_PREFIX}.${base64urlEncode(iv)}.${base64urlEncode(new Uint8Array(ciphertext))}`;
}

/**
 * 解密上游密钥。
 * - 历史明文（无 `ofk1.` 前缀）原样返回，保证迁移期间可用。
 * - 密文但 secret 缺失/错误 → 抛错，绝不把坏凭据发往上游。
 */
export async function decryptProviderApiKey(stored: string, secret: string | null | undefined): Promise<string> {
	if (!isEncryptedProviderApiKey(stored)) {
		return stored;
	}
	if (!secret) {
		throw new Error(
			'PROVIDER_KEY_ENCRYPTION_KEY is not configured but a stored provider key is encrypted; cannot decrypt'
		);
	}
	const parts = stored.split('.');
	if (parts.length !== 3) {
		throw new Error('Malformed encrypted provider key');
	}
	const iv = base64urlDecode(parts[1]!);
	const payload = base64urlDecode(parts[2]!);
	const key = await deriveAesKey(secret);
	try {
		const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, payload);
		return textDecoder.decode(plaintext);
	} catch {
		// AES-GCM 认证失败：secret 不对，或密文被篡改。
		throw new Error('Failed to decrypt provider key: wrong PROVIDER_KEY_ENCRYPTION_KEY or corrupted value');
	}
}

/** 注入存储层的加解密句柄；未配置 secret 时仍需构造（读历史明文可用，写则抛错）。 */
export interface ProviderKeyCrypto {
	encrypt(plaintext: string): Promise<string>;
	decrypt(stored: string): Promise<string>;
}

/** 由 secret 构造存储层用的加解密句柄。`secret` 可为空（见上方行为矩阵）。 */
export function createProviderKeyCrypto(secret: string | null | undefined): ProviderKeyCrypto {
	return {
		encrypt: (plaintext: string) => encryptProviderApiKey(plaintext, secret),
		decrypt: (stored: string) => decryptProviderApiKey(stored, secret),
	};
}
