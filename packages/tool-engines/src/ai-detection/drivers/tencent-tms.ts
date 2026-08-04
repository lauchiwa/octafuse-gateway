/**
 * 腾讯云 TMS TextModeration（Type=TEXT_AIGC）AI 生成文本检测。
 * API: https://tms.tencentcloudapi.com/ Version=2020-12-29
 */

import type { ResolvedAiDetectionConfig } from '@octafuse/core/lib/ai-detection-system-config';
import { AI_DETECTION_PROVIDER_REQUIRED_CREDENTIALS } from '@octafuse/core/lib/ai-detection-system-config';
import { signTc3Request } from '../../tencent/tc3-sign';
import {
	AiDetectionProviderError,
	type AiDetectionDriver,
	type AiDetectionSegmentDetectResult,
} from '../types';

const TMS_HOST = 'tms.tencentcloudapi.com';
const TMS_SERVICE = 'tms';
const TMS_VERSION = '2020-12-29';
const TMS_ACTION = 'TextModeration';
const DEFAULT_REGION = 'ap-guangzhou';

type TmsResponse = {
	Response?: {
		Score?: number;
		Label?: string;
		Suggestion?: string;
		RequestId?: string;
		Error?: {
			Code?: string;
			Message?: string;
		};
	};
};

function mapErrorStatus(code: string | undefined): number {
	switch (code) {
		case 'UnauthorizedOperation':
		case 'AuthFailure.SecretIdNotFound':
		case 'AuthFailure.SignatureFailure':
			return 401;
		case 'InvalidParameter':
		case 'InvalidParameterValue':
			return 400;
		case 'RequestLimitExceeded':
			return 429;
		case 'ResourceNotFound':
		case 'ResourceUnavailable':
			return 403;
		default:
			return 502;
	}
}

/** UTF-8 → Base64（Workers / Node 均可用，避免依赖 Buffer） */
function utf8ToBase64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]!);
	}
	return btoa(binary);
}

async function detectTencentTmsSegment(
	text: string,
	cfg: ResolvedAiDetectionConfig,
	options?: { fetchImpl?: typeof fetch }
): Promise<AiDetectionSegmentDetectResult> {
	const trimmed = text.trim();
	if (!trimmed) {
		throw new AiDetectionProviderError('Empty content', 400, 'tencent_tms');
	}

	const secretId = cfg.entry.secretId?.trim() ?? '';
	const secretKey = cfg.entry.secretKey?.trim() ?? '';
	if (!secretId || !secretKey) {
		throw new AiDetectionProviderError('Tencent TMS credentials missing', 503, 'tencent_tms');
	}

	const region = cfg.entry.region?.trim() || DEFAULT_REGION;
	const bizType = cfg.entry.bizType?.trim() || undefined;

	const body: Record<string, string> = {
		Content: utf8ToBase64(trimmed),
		Type: 'TEXT_AIGC',
	};
	if (bizType) {
		body.BizType = bizType;
	}

	const payload = JSON.stringify(body);
	const { authorization, timestamp } = await signTc3Request({
		secretId,
		secretKey,
		service: TMS_SERVICE,
		host: TMS_HOST,
		payload,
	});

	const fetchImpl = options?.fetchImpl ?? fetch;
	const res = await fetchImpl(`https://${TMS_HOST}/`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Host: TMS_HOST,
			Authorization: authorization,
			'X-TC-Action': TMS_ACTION,
			'X-TC-Version': TMS_VERSION,
			'X-TC-Region': region,
			'X-TC-Timestamp': timestamp,
		},
		body: payload,
	});

	const textBody = await res.text();
	let json: TmsResponse;
	try {
		json = JSON.parse(textBody) as TmsResponse;
	} catch {
		throw new AiDetectionProviderError(
			`Tencent TMS returned non-JSON (HTTP ${res.status})`,
			res.status || 502,
			'tencent_tms'
		);
	}

	const err = json.Response?.Error;
	if (err?.Code || err?.Message) {
		throw new AiDetectionProviderError(
			err.Message || err.Code || 'Tencent TMS error',
			mapErrorStatus(err.Code),
			'tencent_tms'
		);
	}

	if (!res.ok) {
		throw new AiDetectionProviderError(`Tencent TMS HTTP ${res.status}`, res.status, 'tencent_tms');
	}

	const response = json.Response;
	if (!response) {
		throw new AiDetectionProviderError('Tencent TMS empty response', 502, 'tencent_tms');
	}

	const score =
		typeof response.Score === 'number' ? Math.round(Math.max(0, Math.min(100, response.Score))) : 0;

	return { score };
}

export const tencentTmsDriver: AiDetectionDriver = {
	id: 'tencent_tms',
	requiredCredentials: AI_DETECTION_PROVIDER_REQUIRED_CREDENTIALS.tencent_tms,
	segmentMaxChars: 2000,
	detectSegment: detectTencentTmsSegment,
};
