/**
 * AI Detection driver 契约。
 * 配置解析见 `@octafuse/core` `resolveAiDetectionConfig`（按 `requiredCredentials` 校验）。
 * 多 provider：每个引擎一个 driver，登记到 `getAiDetectionDriver`。
 */

import type {
	AiDetectionCredentialField,
	AiDetectionProvider,
	ResolvedAiDetectionConfig,
} from '@octafuse/core/lib/ai-detection-system-config';

export type AiDetectionSegmentDetectResult = {
	/** 归一化到 0–100 的 AI 率 */
	score: number;
};

export type AiDetectionDriver = {
	id: AiDetectionProvider;
	/** resolve 时校验 catalog entry 是否配齐（与 core `AI_DETECTION_PROVIDER_REQUIRED_CREDENTIALS` 对齐） */
	requiredCredentials: readonly AiDetectionCredentialField[];
	/** 引擎单次调用的技术字数上限；决定切几段调上游，与计费无关 */
	segmentMaxChars: number;
	/** 返回归一化到 0–100 的 AI 率 */
	detectSegment(
		text: string,
		cfg: ResolvedAiDetectionConfig,
		options?: { fetchImpl?: typeof fetch }
	): Promise<AiDetectionSegmentDetectResult>;
};

/** 上游引擎错误；路由层据此映射 HTTP 状态，勿把 401 透出为用户 Key 无效。 */
export class AiDetectionProviderError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly provider: string
	) {
		super(message);
		this.name = 'AiDetectionProviderError';
	}
}
