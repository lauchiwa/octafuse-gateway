/**
 * 统一构造网关自造错误响应：body `{ error: string, code }` + 响应头 `X-OctaFuse-Error-Code`。
 * 保持 `error` 为字符串，兼容老版 Agent 的 flat-error 检测。
 */
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
	GATEWAY_ERROR_CODE_HEADER,
	type GatewayErrorCodeValue,
} from './gateway-error-codes';
export {
	classifyUpstreamErrorCode,
	withUpstreamErrorCodeHeader,
} from './upstream-error-code';

export type GatewayErrorJsonOptions = {
	status: ContentfulStatusCode;
	code: GatewayErrorCodeValue;
	message: string;
	headers?: Record<string, string>;
};

/** Hono Context：扁平 `{ error, code }` + 错误码响应头。 */
export function gatewayErrorJson(c: Context, opts: GatewayErrorJsonOptions): Response {
	return c.json(
		{ error: opts.message, code: opts.code },
		opts.status,
		{
			[GATEWAY_ERROR_CODE_HEADER]: opts.code,
			...opts.headers,
		}
	);
}

/** 非 Hono 场景（如 failover-dispatch）：同样形状的 Response。 */
export function gatewayErrorResponse(opts: GatewayErrorJsonOptions): Response {
	return new Response(JSON.stringify({ error: opts.message, code: opts.code }), {
		status: opts.status,
		headers: {
			'Content-Type': 'application/json',
			[GATEWAY_ERROR_CODE_HEADER]: opts.code,
			...opts.headers,
		},
	});
}

/** 嵌套 OpenAI 风格错误体（熔断短路等）——仍写入错误码响应头；`error.code` 使用点分 code。 */
export function gatewayNestedErrorResponse(opts: {
	status: number;
	code: GatewayErrorCodeValue;
	/** 嵌套 error 对象（可含 type / message / retry_after_seconds 等） */
	error: Record<string, unknown>;
	headers?: Record<string, string>;
}): Response {
	const body = {
		error: {
			...opts.error,
			code: opts.code,
		},
	};
	return new Response(JSON.stringify(body), {
		status: opts.status,
		headers: {
			'Content-Type': 'application/json',
			[GATEWAY_ERROR_CODE_HEADER]: opts.code,
			...opts.headers,
		},
	});
}
