/**
 * 上游非 2xx → `upstream.*` 错误码（供 materializeNonOkResponse 写响应头）。
 */
import {
	GATEWAY_ERROR_CODE_HEADER,
	GatewayErrorCode,
	type GatewayErrorCodeValue,
} from './gateway-error-codes';
import { classifyUpstreamHttpFailure } from './upstream-failure-classifier';
import { isSensitiveContentErrorMessage } from './sensitive-content-detector';

export function classifyUpstreamErrorCode(
	status: number,
	_contentType: string | null,
	bodyText: string
): GatewayErrorCodeValue {
	if (status === 524) {
		return GatewayErrorCode.upstreamTimeout;
	}
	const classification = classifyUpstreamHttpFailure(status);
	if (classification.failureKind === 'rate_limit') {
		return GatewayErrorCode.upstreamRateLimited;
	}
	if (classification.failureKind === 'auth') {
		return GatewayErrorCode.upstreamAuthFailed;
	}
	if (classification.failureKind === 'server') {
		return GatewayErrorCode.upstreamServerError;
	}
	if (status === 404) {
		return GatewayErrorCode.upstreamNotFound;
	}
	if (status === 400) {
		if (isSensitiveContentErrorMessage(bodyText)) {
			return GatewayErrorCode.upstreamContentFilter;
		}
		return GatewayErrorCode.upstreamInvalidRequest;
	}
	if (status >= 500) {
		return GatewayErrorCode.upstreamServerError;
	}
	return GatewayErrorCode.upstreamInvalidRequest;
}

/** 给已重建的非 2xx Response 打上 `X-OctaFuse-Error-Code`（不改 body）。 */
export function withUpstreamErrorCodeHeader(response: Response, errorBodyText: string): Response {
	const code = classifyUpstreamErrorCode(
		response.status,
		response.headers.get('content-type'),
		errorBodyText
	);
	const headers = new Headers(response.headers);
	headers.set(GATEWAY_ERROR_CODE_HEADER, code);
	return new Response(errorBodyText, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
