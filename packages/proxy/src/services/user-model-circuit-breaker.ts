/**
 * User+model 熔断（单一 key：`userId\x1fmodelId`）。
 *
 * Gateway 侧策略统一：保护上游 provider，退避均为
 * **20s → 1min → 3min → 5min → 10min**（窗口内不累加，成功清零）。
 *
 * 敏感内容 vs 普通 400 只通过短路响应的 **code**（及 HTTP 形态）区分，供客户端分流处理。
 */
import { formatHttpErrorTextForRequestLog } from './request-log-record-status';
import { isSensitiveContentErrorMessage } from './sensitive-content-detector';
import { GATEWAY_ERROR_CODE_HEADER, GatewayErrorCode } from './gateway-error-codes';

export const USER_MODEL_CIRCUIT_BREAKER_ENABLED = true;

/** user+model 统一退避：20s → 1min → 3min → 5min → 10min */
export const USER_MODEL_BACKOFF_MS = [20_000, 60_000, 180_000, 300_000, 600_000] as const;

/** @deprecated 已与普通 400 统一为 {@link USER_MODEL_BACKOFF_MS}，不再使用固定 180s */
export const SENSITIVE_CONTENT_COOLDOWN_MS = USER_MODEL_BACKOFF_MS[2];
/** @deprecated 使用 {@link USER_MODEL_BACKOFF_MS} */
export const SENSITIVE_CONTENT_CIRCUIT_BREAKER_MS = SENSITIVE_CONTENT_COOLDOWN_MS;

const MAX_CIRCUIT_ENTRIES = 10_000;

export type UserModelCircuitReason = 'sensitive_content' | 'client_error';

export type UserModelCircuitOpenInfo = {
	blockedUntil: number;
	retryAfterSeconds: number;
	reason: UserModelCircuitReason;
	lastErrorMessage?: string;
};

type CircuitEntry = {
	blockedUntil: number;
	reason: UserModelCircuitReason;
	consecutiveFailures: number;
	lastErrorMessage?: string;
};

const circuitUntilByKey = new Map<string, CircuitEntry>();

function circuitKey(userId: string, modelId: string): string {
	return `${userId}\x1f${modelId}`;
}

function maybePurgeIfOverCapacity(now: number): void {
	if (circuitUntilByKey.size <= MAX_CIRCUIT_ENTRIES) {
		return;
	}
	for (const [key, entry] of circuitUntilByKey) {
		if (entry.blockedUntil <= now && entry.consecutiveFailures === 0) {
			circuitUntilByKey.delete(key);
		}
	}
}

function toOpenInfo(entry: CircuitEntry, now: number): UserModelCircuitOpenInfo {
	const retryAfterSeconds = Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000));
	return {
		blockedUntil: entry.blockedUntil,
		retryAfterSeconds,
		reason: entry.reason,
		lastErrorMessage: entry.lastErrorMessage,
	};
}

export function getUserModelCircuitOpen(
	userId: string,
	modelId: string,
	now = Date.now()
): UserModelCircuitOpenInfo | null {
	if (!USER_MODEL_CIRCUIT_BREAKER_ENABLED) {
		return null;
	}
	const key = circuitKey(userId, modelId);
	const entry = circuitUntilByKey.get(key);
	if (!entry || entry.blockedUntil <= now) {
		return null;
	}
	return toOpenInfo(entry, now);
}

/** @deprecated 使用 {@link getUserModelCircuitOpen} */
export function getSensitiveContentCircuitOpen(
	userId: string,
	modelId: string,
	now = Date.now()
): UserModelCircuitOpenInfo | null {
	return getUserModelCircuitOpen(userId, modelId, now);
}

/**
 * 记录一次 user+model 熔断触发（敏感内容或普通 400 共用退避档位）。
 * `reason` 只影响短路时返回的 code / HTTP 形态。
 */
export function recordUserModelCircuitTrigger(
	userId: string,
	modelId: string,
	reason: UserModelCircuitReason,
	lastErrorMessage?: string,
	now = Date.now()
): UserModelCircuitOpenInfo {
	const key = circuitKey(userId, modelId);
	const entry = circuitUntilByKey.get(key) ?? {
		blockedUntil: 0,
		reason,
		consecutiveFailures: 0,
		lastErrorMessage,
	};

	if (entry.blockedUntil <= now) {
		entry.consecutiveFailures += 1;
	}
	const idx = Math.min(Math.max(entry.consecutiveFailures, 1) - 1, USER_MODEL_BACKOFF_MS.length - 1);
	const cooldownMs = USER_MODEL_BACKOFF_MS[idx]!;
	entry.blockedUntil = Math.max(entry.blockedUntil, now + cooldownMs);
	entry.reason = reason;
	if (lastErrorMessage) {
		entry.lastErrorMessage = lastErrorMessage;
	}
	circuitUntilByKey.set(key, entry);
	maybePurgeIfOverCapacity(now);
	return toOpenInfo(entry, now);
}

export function recordSensitiveContentCircuitTrigger(
	userId: string,
	modelId: string,
	lastErrorMessage?: string,
	_cooldownMsIgnored?: number,
	now = Date.now()
): UserModelCircuitOpenInfo {
	return recordUserModelCircuitTrigger(userId, modelId, 'sensitive_content', lastErrorMessage, now);
}

export function recordClientErrorCircuitTrigger(
	userId: string,
	modelId: string,
	lastErrorMessage?: string,
	now = Date.now()
): UserModelCircuitOpenInfo {
	return recordUserModelCircuitTrigger(userId, modelId, 'client_error', lastErrorMessage, now);
}

/** 成功清零整个 user+model 熔断状态（含敏感内容）。 */
export function markUserModelSuccess(userId: string, modelId: string, _now = Date.now()): void {
	circuitUntilByKey.delete(circuitKey(userId, modelId));
}

export function isSensitiveUpstreamResponse(
	status: number,
	contentType: string | null,
	bodyText: string
): boolean {
	const formatted = formatHttpErrorTextForRequestLog(status, contentType, bodyText);
	return isSensitiveContentErrorMessage(formatted) || isSensitiveContentErrorMessage(bodyText);
}

export function formatUserModelCircuitOpenErrorMessage(info: UserModelCircuitOpenInfo): string {
	const blockedUntilIso = new Date(info.blockedUntil).toISOString();
	if (info.reason === 'sensitive_content') {
		return `Sensitive content circuit open; retry after ${info.retryAfterSeconds}s (blocked until ${blockedUntilIso})`;
	}
	return `Upstream client error circuit open; retry after ${info.retryAfterSeconds}s (blocked until ${blockedUntilIso})`;
}

/** @deprecated 使用 {@link formatUserModelCircuitOpenErrorMessage} */
export function formatSensitiveContentCircuitOpenErrorMessage(info: UserModelCircuitOpenInfo): string {
	return formatUserModelCircuitOpenErrorMessage(info);
}

export function buildSensitiveContentCircuitOpenResponse(info: UserModelCircuitOpenInfo): Response {
	const blockedUntilIso = new Date(info.blockedUntil).toISOString();
	const code = GatewayErrorCode.circuitSensitiveContent;
	const body = {
		error: {
			message: `Sensitive content was blocked upstream. Please retry this user/model after ${info.retryAfterSeconds} seconds.`,
			type: 'sensitive_content_circuit_open',
			code,
			retry_after_seconds: info.retryAfterSeconds,
			blocked_until: blockedUntilIso,
		},
	};
	return new Response(JSON.stringify(body), {
		status: 429,
		headers: {
			'Content-Type': 'application/json',
			'Retry-After': String(info.retryAfterSeconds),
			[GATEWAY_ERROR_CODE_HEADER]: code,
		},
	});
}

export function buildClientErrorCircuitOpenResponse(info: UserModelCircuitOpenInfo): Response {
	const blockedUntilIso = new Date(info.blockedUntil).toISOString();
	const code = GatewayErrorCode.circuitClientError;
	const replay =
		info.lastErrorMessage?.trim() ||
		`Upstream rejected this request (client error). Circuit open until ${blockedUntilIso}.`;
	const body = {
		error: {
			message: replay,
			type: 'upstream_client_error_circuit_open',
			code,
			retry_after_seconds: info.retryAfterSeconds,
			blocked_until: blockedUntilIso,
		},
	};
	return new Response(JSON.stringify(body), {
		status: 400,
		headers: {
			'Content-Type': 'application/json',
			[GATEWAY_ERROR_CODE_HEADER]: code,
		},
	});
}

export function buildUserModelCircuitOpenResponse(info: UserModelCircuitOpenInfo): Response {
	if (info.reason === 'sensitive_content') {
		return buildSensitiveContentCircuitOpenResponse(info);
	}
	return buildClientErrorCircuitOpenResponse(info);
}

/** 测试用：清空熔断状态。 */
export function resetUserModelCircuitStateForTests(): void {
	circuitUntilByKey.clear();
}

/** @deprecated 使用 {@link resetUserModelCircuitStateForTests} */
export function resetSensitiveContentCircuitStateForTests(): void {
	resetUserModelCircuitStateForTests();
}
