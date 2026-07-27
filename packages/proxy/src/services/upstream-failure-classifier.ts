/**
 * 上游 HTTP 失败分类：决定是否在同 provider 内换 key、或换下一 provider。
 */

import type { ProviderKeyFailureKind } from './provider-key-circuit-breaker';

export type UpstreamFailureAction = 'retry_key' | 'fail_immediately';

export type UpstreamFailureClassification = {
	action: UpstreamFailureAction;
	/** 401/403 等 key 异常，切换 key 但应记录告警 */
	alertOnKeySwitch?: boolean;
	/** 有值时 dispatch 会写入 provider key 熔断；524 / fetch 等瞬时错误不设此项 */
	failureKind?: ProviderKeyFailureKind;
	/**
	 * 403 系「调用方身份被拒」（渠道白名单 / WAF），而非凭据问题。
	 * 不熔断、不换 key；仅用于日志与告警抑制。
	 */
	clientIdentityRejected?: boolean;
};

/**
 * 403 响应体是否表明「调用方身份被拒」而非「凭据无效」。
 *
 * 背景（实测 2026-07-27）：new-api 系中转站会对不在白名单的客户端返回
 * `403 {"error":{"code":"channel:client_restricted"}}`；Cloudflare WAF 挑战页
 * 则返回 403 + HTML。两者都与 provider key 是否有效**无关** —— 换 key 不会成功，
 * 而按 auth 失败熔断会让整个 provider 下线（单 key provider 上尤其致命），
 * 并把上游真实错误掩盖成后续请求的本地 429。
 *
 * 判定保守：只在命中已知特征时才改变分类；无法读取 body（流式已消费、读取超时等）
 * 时一律退回原有的 auth 行为，宁可误熔断也不放过真正的凭据问题。
 */
export function looksLikeClientIdentityRejection(bodyText: string | null | undefined): boolean {
	if (!bodyText) return false;
	const lower = bodyText.slice(0, 4096).toLowerCase();
	// new-api / one-api 系：渠道级客户端限制
	if (lower.includes('client_restricted')) return true;
	if (lower.includes('does not allow the current client')) return true;
	// Cloudflare WAF 挑战 / 拦截页（HTML，而非 JSON 错误体）
	if (lower.includes('<!doctype html') && lower.includes('cloudflare')) return true;
	if (lower.includes('attention required') && lower.includes('cloudflare')) return true;
	if (lower.includes('you have been blocked')) return true;
	return false;
}

/**
 * 对上游 HTTP status 分类。
 * - `retry_key`：可尝试同 provider 下一把 key；全部 key 失败后再换 provider。
 * - `fail_immediately`：请求本身错误（400/404 等），不重试其它 key 或 provider。
 */
export function classifyUpstreamHttpFailure(
	status: number,
	bodyText?: string | null
): UpstreamFailureClassification {
	if (status === 429) {
		return { action: 'retry_key', failureKind: 'rate_limit' };
	}
	// Cloudflare 524 等边缘超时：仅同次 failover，不跨请求熔断。
	if (status === 524) {
		return { action: 'retry_key' };
	}
	if (status >= 500) {
		return { action: 'retry_key', failureKind: 'server' };
	}
	if (status === 401 || status === 403) {
		// 只有 403 语义上模糊（「已认证但被拒绝」）；401 明确是认证失败，一律按凭据问题处理。
		// 调用方身份被拒（渠道白名单 / WAF）：换 key 无用，且不应熔断 provider key。
		// 直接失败并把上游原始错误交回客户端，便于定位。
		if (status === 403 && looksLikeClientIdentityRejection(bodyText)) {
			return { action: 'fail_immediately', clientIdentityRejected: true };
		}
		return { action: 'retry_key', alertOnKeySwitch: true, failureKind: 'auth' };
	}
	return { action: 'fail_immediately' };
}

/** fetch 异常、超时、网络错误 → 同次 failover，不跨请求熔断。 */
export function classifyUpstreamFetchFailure(): UpstreamFailureClassification {
	return { action: 'retry_key' };
}
