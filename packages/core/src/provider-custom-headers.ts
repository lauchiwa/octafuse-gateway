/**
 * Provider 自定义上游 header：解析 / 校验 / 序列化 / 按协议取值。
 * 权威列为 `providers.custom_headers`（JSON）。
 *
 * 安全边界（务必与调用方合并顺序配合）：
 * - 注入上游时使用 `{ ...custom, ...driverBaseHeaders }`，驱动内置的鉴权/协议 header 永远覆盖 custom。
 * - 本模块的校验器再以 denylist 双保险，直接拒绝配置敏感 header。
 */
import { UPSTREAM_PROTOCOLS, type UpstreamProtocol } from './upstream-protocol';
import type {
	ProviderCustomHeadersMap,
	ProviderCustomHeadersSource,
} from './provider-custom-headers-types';

export type { ProviderCustomHeadersMap, ProviderCustomHeadersSource };

/** 每协议允许的最大 header 数量。 */
export const CUSTOM_HEADERS_MAX_PER_PROTOCOL = 20;
/** 单协议序列化后的最大字节数。 */
export const CUSTOM_HEADERS_MAX_BYTES_PER_PROTOCOL = 1024;

/**
 * 禁止用户配置的 header 名（小写比较）。这些由驱动内置或由 runtime 控制，
 * 允许自定义会造成鉴权篡改 / 请求走私 / 传输语义破坏。
 */
export const CUSTOM_HEADERS_DENYLIST: readonly string[] = [
	'authorization',
	'x-api-key',
	'anthropic-version',
	'content-type',
	'content-length',
	'host',
	'connection',
] as const;

const DENYLIST_SET = new Set(CUSTOM_HEADERS_DENYLIST);

/** RFC 7230 token：合法 HTTP header 名字符集。 */
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** header 值是否含 CR/LF 或控制字符（普通空格 0x20 除外）。 */
function hasIllegalHeaderValueChar(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		// 拒绝 < 0x20（含 \r \n \t）与 0x7F(DEL)；0x20 空格允许。
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * 宽松解析（读路径）：NULL / 非法 / 空对象返回空 map，坏 header 静默跳过。
 * 不抛错，保证 runtime 读取永不因脏数据崩溃。
 */
export function parseProviderCustomHeaders(
	provider: ProviderCustomHeadersSource
): ProviderCustomHeadersMap {
	const col = provider.custom_headers;
	if (col == null || col === '') return {};
	let raw: unknown = col;
	if (typeof col === 'string') {
		try {
			raw = JSON.parse(col) as unknown;
		} catch {
			return {};
		}
	}
	if (!isPlainObject(raw)) return {};

	const out: ProviderCustomHeadersMap = {};
	for (const protocol of UPSTREAM_PROTOCOLS) {
		const headersRaw = raw[protocol];
		if (!isPlainObject(headersRaw)) continue;
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(headersRaw)) {
			const trimmedName = name.trim();
			if (!trimmedName || !HTTP_TOKEN_RE.test(trimmedName)) continue;
			if (DENYLIST_SET.has(trimmedName.toLowerCase())) continue;
			if (typeof value !== 'string') continue;
			if (hasIllegalHeaderValueChar(value)) continue;
			headers[trimmedName] = value;
		}
		if (Object.keys(headers).length > 0) out[protocol] = headers;
	}
	return out;
}

/** 序列化为入库 JSON 文本；空配置返回 null（与 endpoints 一致）。 */
export function serializeProviderCustomHeaders(map: ProviderCustomHeadersMap): string | null {
	const cleaned: ProviderCustomHeadersMap = {};
	for (const protocol of UPSTREAM_PROTOCOLS) {
		const headers = map[protocol];
		if (!headers) continue;
		const entry: Record<string, string> = {};
		for (const [name, value] of Object.entries(headers)) {
			const trimmedName = name.trim();
			if (!trimmedName || typeof value !== 'string') continue;
			entry[trimmedName] = value;
		}
		if (Object.keys(entry).length > 0) cleaned[protocol] = entry;
	}
	return Object.keys(cleaned).length > 0 ? JSON.stringify(cleaned) : null;
}

export type ValidateCustomHeadersResult =
	| { ok: true; value: ProviderCustomHeadersMap }
	| { ok: false; error: string };

/**
 * 严格校验并规范化 admin 写入的 custom headers（对象或 JSON 字符串）。
 * 返回结果对象而非抛错，便于 BFF 直接映射到 `{ success:false, message }`。
 */
export function validateAndNormalizeProviderCustomHeaders(
	raw: unknown
): ValidateCustomHeadersResult {
	let value: unknown = raw;
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (trimmed === '') return { ok: true, value: {} };
		try {
			value = JSON.parse(trimmed) as unknown;
		} catch {
			return { ok: false, error: 'custom_headers must be valid JSON' };
		}
	}
	if (value == null) return { ok: true, value: {} };
	if (!isPlainObject(value)) {
		return { ok: false, error: 'custom_headers must be a JSON object' };
	}

	const out: ProviderCustomHeadersMap = {};
	for (const [key, headersRaw] of Object.entries(value)) {
		if (!(UPSTREAM_PROTOCOLS as readonly string[]).includes(key)) {
			return { ok: false, error: `custom_headers: unknown protocol ${JSON.stringify(key)}` };
		}
		const protocol = key as UpstreamProtocol;
		if (headersRaw == null) continue;
		if (!isPlainObject(headersRaw)) {
			return { ok: false, error: `custom_headers.${protocol} must be an object` };
		}

		const headers: Record<string, string> = {};
		for (const [nameRaw, valueRaw] of Object.entries(headersRaw)) {
			const name = nameRaw.trim();
			if (!name) continue;
			if (!HTTP_TOKEN_RE.test(name)) {
				return {
					ok: false,
					error: `custom_headers.${protocol}: invalid header name ${JSON.stringify(nameRaw)}`,
				};
			}
			if (DENYLIST_SET.has(name.toLowerCase())) {
				return {
					ok: false,
					error: `custom_headers.${protocol}: header ${JSON.stringify(name)} is not allowed`,
				};
			}
			if (typeof valueRaw !== 'string') {
				return {
					ok: false,
					error: `custom_headers.${protocol}.${name} must be a string`,
				};
			}
			if (hasIllegalHeaderValueChar(valueRaw)) {
				return {
					ok: false,
					error: `custom_headers.${protocol}.${name} contains illegal control characters`,
				};
			}
			headers[name] = valueRaw;
		}

		const count = Object.keys(headers).length;
		if (count === 0) continue;
		if (count > CUSTOM_HEADERS_MAX_PER_PROTOCOL) {
			return {
				ok: false,
				error: `custom_headers.${protocol}: too many headers (max ${CUSTOM_HEADERS_MAX_PER_PROTOCOL})`,
			};
		}
		const bytes = new TextEncoder().encode(JSON.stringify(headers)).length;
		if (bytes > CUSTOM_HEADERS_MAX_BYTES_PER_PROTOCOL) {
			return {
				ok: false,
				error: `custom_headers.${protocol}: serialized size exceeds ${CUSTOM_HEADERS_MAX_BYTES_PER_PROTOCOL} bytes`,
			};
		}
		out[protocol] = headers;
	}
	return { ok: true, value: out };
}

/** 取某协议的自定义 header；缺省返回空对象（调用方永远拿到对象而非 undefined）。 */
export function resolveCustomHeadersForProtocol(
	map: ProviderCustomHeadersMap,
	protocol: UpstreamProtocol
): Record<string, string> {
	return map[protocol] ?? {};
}
