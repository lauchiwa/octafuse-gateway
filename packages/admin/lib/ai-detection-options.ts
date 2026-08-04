/**
 * Tools → Configuration：AI Detection 引擎下拉（与 `@octafuse/core` 白名单一致）。
 * 多 provider：扩 `AI_DETECTION_PROVIDERS` + driver 后，UI 按 `requiredCredentials` 动态渲染凭证框。
 */
import {
	AI_DETECTION_ACTIVE_KEY,
	AI_DETECTION_CATALOG_KEY,
	AI_DETECTION_IMPLEMENTED_PROVIDERS,
	AI_DETECTION_PROVIDER_REQUIRED_CREDENTIALS,
	AI_DETECTION_PROVIDERS,
	DEFAULT_AI_DETECTION_BILLING_UNIT_CHARS,
	DEFAULT_AI_DETECTION_COST,
	DEFAULT_AI_DETECTION_PROVIDER,
	isAiDetectionImplementedProvider,
	type AiDetectionCredentialField,
	type AiDetectionProvider,
} from '@octafuse/core/lib/ai-detection-system-config';

export {
	AI_DETECTION_ACTIVE_KEY,
	AI_DETECTION_CATALOG_KEY,
	AI_DETECTION_IMPLEMENTED_PROVIDERS,
	AI_DETECTION_PROVIDER_REQUIRED_CREDENTIALS,
	AI_DETECTION_PROVIDERS,
	DEFAULT_AI_DETECTION_BILLING_UNIT_CHARS,
	DEFAULT_AI_DETECTION_COST,
	DEFAULT_AI_DETECTION_PROVIDER,
	isAiDetectionImplementedProvider,
	type AiDetectionCredentialField,
	type AiDetectionProvider,
};

export type AiDetectionProviderOption = {
	value: AiDetectionProvider;
	label: string;
	/** 未实现引擎不可设为 Active */
	implemented: boolean;
};

/** 各引擎官网 / 申请入口（非 i18n） */
export const AI_DETECTION_PROVIDER_DOCS_URL: Record<AiDetectionProvider, string> = {
	tencent_tms: 'https://cloud.tencent.com/document/product/1124',
};

type AiDetectionProviderLabelKey = `aiDetection.providers.${AiDetectionProvider}`;

/** 展示名；value 必须落在 `AI_DETECTION_PROVIDERS`。 */
export function getAiDetectionProviderOptions(
	t: (key: AiDetectionProviderLabelKey) => string
): ReadonlyArray<AiDetectionProviderOption> {
	return AI_DETECTION_PROVIDERS.map((value) => ({
		value,
		label: t(`aiDetection.providers.${value}`),
		implemented: isAiDetectionImplementedProvider(value),
	}));
}

/** UI 动态凭证字段（按 provider 的 requiredCredentials） */
export function getAiDetectionCredentialFields(
	provider: AiDetectionProvider
): readonly AiDetectionCredentialField[] {
	if (!isAiDetectionImplementedProvider(provider)) {
		return ['apiKey'];
	}
	return AI_DETECTION_PROVIDER_REQUIRED_CREDENTIALS[provider];
}
