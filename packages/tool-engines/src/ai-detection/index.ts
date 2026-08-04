/**
 * AI Detection drivers 注册与分发（多 provider：在此登记已实现 driver）。
 */

import type {
	AiDetectionImplementedProvider,
	AiDetectionProvider,
} from '@octafuse/core/lib/ai-detection-system-config';
import { tencentTmsDriver } from './drivers/tencent-tms';
import type { AiDetectionDriver } from './types';

export { detectAiRate, type DetectionAggregateResult, type DetectionSegmentResult } from './detect';
export { segmentTextForDetection, type TextSegment } from './segment';
export {
	AiDetectionProviderError,
	type AiDetectionDriver,
	type AiDetectionSegmentDetectResult,
} from './types';

const DRIVERS: Record<AiDetectionImplementedProvider, AiDetectionDriver> = {
	tencent_tms: tencentTmsDriver,
};

export function getAiDetectionDriver(provider: AiDetectionProvider): AiDetectionDriver | null {
	if (provider in DRIVERS) {
		return DRIVERS[provider as AiDetectionImplementedProvider];
	}
	return null;
}
