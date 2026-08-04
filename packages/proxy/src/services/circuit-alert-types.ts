/**
 * 熔断告警元数据：供 `recordUsage` / `fireGatewayErrorWebhooks` 展示熔断措施或抑制重复告警。
 */
import type { ProviderFailureKind } from './provider-circuit-breaker';

export type ProviderCircuitAlertEvent = {
	kind: 'provider';
	providerId: string;
	providerName?: string | null;
	keyFingerprint?: string | null;
	failureKind: ProviderFailureKind;
	openUntil: number;
	cooldownMs: number;
	/** 本次失败调用是否打开或延长了熔断窗口 */
	openedOrExtended: boolean;
};

export type UserModelCircuitAlertEvent = {
	kind: 'user_model';
	userId: string;
	modelId: string;
	reason: 'sensitive_content' | 'client_error';
	openUntil: number;
	cooldownMs: number;
};

export type GatewayCircuitAlertEvent = ProviderCircuitAlertEvent | UserModelCircuitAlertEvent;
