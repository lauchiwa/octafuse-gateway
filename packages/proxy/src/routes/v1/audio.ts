/**
 * 用户路由：OpenAI 兼容 Audio Transcriptions
 * - `POST /v1/audio/transcriptions`（multipart）
 *
 * 流程：鉴权 → 解析 model/file → 预算预检 → openai 路由故障转移 → 成功后按秒扣费。
 * 日志禁止写入音频二进制。
 */
import type { GatewayRepositories, ModelRow } from '@octafuse/core';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../app';
import { requireApiKey, type ApiKeyContext } from '../../middleware/auth';
import {
	resolveRoutesForSurface,
	type RouteResult,
} from '../../services/model-router';
import { resolveModelRouting } from '../../services/resolve-model-route-group';
import {
	buildAffinityKey,
	buildTierKeyPrefix,
	resolveRouteStrategy,
} from '../../services/route-strategies';
import { proxyAudioTranscriptions, type ProxyResult } from '../../services/proxy';
import { finalizeRequestLogJson } from '../../services/request-log-shared';
import {
	canAffordAudioCost,
	estimateAudioBudgetPrecheck,
	recordAudioUsage,
} from '../../services/audio-usage-charge';
import {
	AUDIO_MAX_BYTES_PER_FILE,
	redactAudioRequestForLog,
	resolveAudioUploadFilename,
	normalizeAudioMimeType,
	validateAudioUpload,
	type NormalizedAudioTranscriptionRequest,
} from '../../services/egress/openai-audio-driver';
import {
	formatHttpErrorTextForRequestLog,
	materializeNonOkResponse,
} from '../../services/request-log-record-status';
import {
	maybeBlockUserModelCircuit,
	maybeTriggerUserModelCircuitFromUpstream,
	markUserModelSuccess,
} from '../../services/user-model-circuit-route';
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import { gatewayErrorJson } from '../../services/gateway-error-response';
import { RequestTimingCollector } from '../../services/request-timing';
import { scheduleBackgroundWork } from '../../runtime/schedule-background-work';

type AudioEnv = Env & { Variables: { apiKey: ApiKeyContext } };
type AudioContext = Context<AudioEnv>;

export const audioRoutes = new Hono<AudioEnv>();

audioRoutes.use('*', requireApiKey);

async function resolveOpenAiAudioRoutes(
	repos: GatewayRepositories,
	rawModelId: string
): Promise<
	| {
			ok: true;
			model: ModelRow;
			baseModelId: string;
			effectiveRouteGroup: string;
			routes: RouteResult[];
			poolStrategy: string | null;
	  }
	| { ok: false; status: 400 | 404 | 502; error: string }
> {
	const resolved = await resolveModelRouting(repos, rawModelId);
	if (!resolved) {
		const modelForLog = truncateModelIdForLog(rawModelId);
		console.warn(`[Gateway Audio] model not found clientModel=${modelForLog}`);
		return { ok: false, status: 404, error: `Model not found: ${modelForLog}` };
	}
	const { model, baseModelId, explicitGroup } = resolved;
	const effectiveRouteGroup = explicitGroup?.trim() || 'default';
	try {
		const resolvedSurface = await resolveRoutesForSurface(repos, {
			modelId: baseModelId,
			routeGroup: effectiveRouteGroup,
			requestProtocol: 'openai',
			requestOperation: 'audio.transcriptions',
		});
		const routes = resolvedSurface.routes;
		if (routes.length === 0) {
			return {
				ok: false,
				status: 502,
				error: `No OpenAI route in route group "${effectiveRouteGroup}" for this model`,
			};
		}
		return {
			ok: true,
			model,
			baseModelId,
			effectiveRouteGroup,
			routes,
			poolStrategy: resolvedSurface.surface?.pool_strategy ?? null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Model route resolution failed';
		return { ok: false, status: 502, error: message };
	}
}

function modelDisplayName(model: { display_name?: string | null }, baseModelId: string): string {
	return model.display_name != null && String(model.display_name).trim() !== ''
		? String(model.display_name).trim()
		: baseModelId;
}

function truncateModelIdForLog(rawModelId: string, maxLen = 200): string {
	const trimmed = rawModelId.trim();
	if (trimmed.length <= maxLen) {
		return trimmed;
	}
	return `${trimmed.slice(0, maxLen)}…`;
}

const ALLOWED_RESPONSE_FORMATS = new Set([
	'json',
	'text',
	'srt',
	'verbose_json',
	'vtt',
	'diarized_json',
]);

/** Hono `parseBody({ all: true })` may yield string or string[] for text fields. */
function multipartTextField(value: unknown): string {
	if (typeof value === 'string') {
		return value.trim();
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item === 'string' && item.trim() !== '') {
				return item.trim();
			}
		}
	}
	return '';
}

function multipartFileField(value: unknown): File | null {
	if (value != null && typeof value === 'object' && 'arrayBuffer' in value) {
		return value as File;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			if (item != null && typeof item === 'object' && 'arrayBuffer' in item) {
				return item as File;
			}
		}
	}
	return null;
}

async function parseMultipartTranscription(c: {
	req: { parseBody: (options?: { all?: boolean }) => Promise<Record<string, unknown>> };
}): Promise<
	| { ok: true; model: string; transcription: NormalizedAudioTranscriptionRequest }
	| { ok: false; error: string }
> {
	let body: Record<string, unknown>;
	try {
		body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
	} catch {
		return { ok: false, error: 'Invalid multipart body' };
	}

	const model = multipartTextField(body.model);
	if (!model) {
		return { ok: false, error: 'Missing model' };
	}

	const file = multipartFileField(body.file);
	if (!file) {
		return { ok: false, error: 'Missing audio file' };
	}
	const declaredSize =
		typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : null;
	if (declaredSize != null && declaredSize > AUDIO_MAX_BYTES_PER_FILE) {
		return { ok: false, error: `audio file must be at most ${AUDIO_MAX_BYTES_PER_FILE} bytes` };
	}
	const buf = new Uint8Array(await file.arrayBuffer());
	const mimeType =
		normalizeAudioMimeType(file.type || '') || 'application/octet-stream';
	const upload = {
		filename: resolveAudioUploadFilename(
			(file as { name?: string }).name || '',
			mimeType
		),
		mimeType,
		bytes: buf,
	};
	const uploadErr = validateAudioUpload(upload);
	if (uploadErr) {
		return { ok: false, error: uploadErr };
	}

	const formatRaw = multipartTextField(body.response_format).toLowerCase() || 'json';
	const clientResponseFormat = (
		ALLOWED_RESPONSE_FORMATS.has(formatRaw) ? formatRaw : 'json'
	) as NormalizedAudioTranscriptionRequest['clientResponseFormat'];

	const languageField = multipartTextField(body.language);
	const language = languageField !== '' ? languageField : undefined;
	const promptField = multipartTextField(body.prompt);
	const prompt = promptField !== '' ? promptField : undefined;
	let temperature: number | undefined;
	if (body.temperature != null && body.temperature !== '') {
		const t = Number(body.temperature);
		if (!Number.isFinite(t) || t < 0 || t > 1) {
			return { ok: false, error: 'temperature must be between 0 and 1' };
		}
		temperature = t;
	}

	const clientDurationRaw = multipartTextField(
		body.duration_seconds ?? body.duration
	);
	let clientDurationSeconds: number | undefined;
	if (clientDurationRaw !== '') {
		const n = Number(clientDurationRaw);
		if (Number.isFinite(n) && n > 0) {
			clientDurationSeconds = n;
		}
	}

	return {
		ok: true,
		model,
		transcription: {
			file: upload,
			clientResponseFormat,
			language,
			prompt,
			temperature,
			clientDurationSeconds,
		},
	};
}

audioRoutes.post('/transcriptions', async (c) => {
	const repos = c.get('repositories');
	const apiKey = c.get('apiKey');
	const start = Date.now();
	const timing = new RequestTimingCollector();

	const parsed = await parseMultipartTranscription(c);
	if (!parsed.ok) {
		console.warn(`[Gateway Audio] transcriptions parse failed: ${parsed.error}`);
		return gatewayErrorJson(c, {
			status: 400,
			code: GatewayErrorCode.invalidRequest,
			message: parsed.error,
		});
	}
	const { model: rawModelId, transcription } = parsed;

	const routed = await resolveOpenAiAudioRoutes(repos, rawModelId);
	if (!routed.ok) {
		if (routed.status !== 404) {
			console.warn(
				`[Gateway Audio] transcriptions route resolve failed status=${routed.status} clientModel=${truncateModelIdForLog(rawModelId)} error=${routed.error}`
			);
		}
		return gatewayErrorJson(c, {
			status: routed.status as 400 | 403 | 404 | 502,
			code:
				routed.status === 404
					? GatewayErrorCode.modelNotFound
					: routed.status === 502
						? GatewayErrorCode.routeResolutionFailed
						: GatewayErrorCode.invalidRequest,
			message: routed.error,
		});
	}
	const { model, baseModelId, effectiveRouteGroup, routes } = routed;
	const modelNameForLog = modelDisplayName(model, baseModelId);

	if (apiKey.budgetMax != null && apiKey.budgetSpent >= apiKey.budgetMax) {
		return gatewayErrorJson(c, {
			status: 403,
			code: GatewayErrorCode.budgetExceeded,
			message: 'Budget exceeded',
		});
	}

	const estimate = await estimateAudioBudgetPrecheck(
		repos,
		{
			modelPricingProfileJson: model.pricing_profile ?? null,
			fileBytes: transcription.file.bytes.byteLength,
			mimeType: transcription.file.mimeType,
			fileBytesForParse: transcription.file.bytes,
			clientDurationSeconds: transcription.clientDurationSeconds,
			requestStartedAtMs: start,
		},
		routes.map((route) => route.priceOverrideRaw)
	);
	if (!canAffordAudioCost(apiKey.budgetMax, apiKey.budgetSpent, estimate.chargedCost)) {
		return gatewayErrorJson(c, {
			status: 403,
			code: GatewayErrorCode.budgetExceeded,
			message: 'Budget exceeded',
		});
	}

	const requestBodyForLog = finalizeRequestLogJson(
		redactAudioRequestForLog({
			model: rawModelId,
			filename: transcription.file.filename,
			mimeType: transcription.file.mimeType,
			byteLength: transcription.file.bytes.byteLength,
			language: transcription.language,
			responseFormat: transcription.clientResponseFormat,
			clientDurationSeconds: transcription.clientDurationSeconds,
		})
	);

	const circuitBlocked = maybeBlockUserModelCircuit(c, repos, apiKey, {
		baseModelId,
		modelNameForLog,
		requestBodyForLog,
		requestProtocol: 'openai',
		startMs: start,
		timing,
		clientErrorCircuitEnabled: false,
	});
	if (circuitBlocked) {
		return circuitBlocked;
	}

	const strategy = await resolveRouteStrategy({
		routePolicyRaw: model.route_policy ?? null,
		poolStrategy: routed.poolStrategy,
		protocol: 'openai',
		capability: 'audio.transcriptions',
		routeGroup: effectiveRouteGroup,
		repos,
	});
	const affinityKey = buildAffinityKey(apiKey.userId, baseModelId, effectiveRouteGroup, 'openai');
	const tierKeyPrefix = buildTierKeyPrefix(baseModelId, effectiveRouteGroup, 'openai');
	timing.markGatewayComplete();

	console.log(
		`[Gateway Audio] transcriptions baseModelId=${baseModelId} keyId=${apiKey.keyId} bytes=${transcription.file.bytes.byteLength}`
	);

	const proxyResult = await proxyAudioTranscriptions(
		repos,
		routes,
		transcription,
		c.req.raw.signal,
		{ affinityKey, tierKeyPrefix, strategy, timing }
	);

	return finalizeAudioResponse({
		c,
		proxyResult,
		apiKey,
		repos,
		baseModelId,
		effectiveRouteGroup,
		modelNameForLog,
		requestBodyForLog,
		modelPricingProfileJson: model.pricing_profile ?? null,
		fileBytes: transcription.file.bytes.byteLength,
		start,
		timing,
	});
});

async function finalizeAudioResponse(params: {
	c: AudioContext;
	proxyResult: ProxyResult;
	apiKey: ApiKeyContext;
	repos: GatewayRepositories;
	baseModelId: string;
	effectiveRouteGroup: string;
	modelNameForLog: string;
	requestBodyForLog: string | null;
	modelPricingProfileJson: string | null;
	fileBytes: number;
	start: number;
	timing: RequestTimingCollector;
}): Promise<Response> {
	const {
		c,
		proxyResult,
		apiKey,
		repos,
		baseModelId,
		effectiveRouteGroup,
		modelNameForLog,
		requestBodyForLog,
		modelPricingProfileJson,
		fileBytes,
		start,
		timing,
	} = params;

	const { chosenRoute, upstreamRequestId, circuitEvents, suppressErrorAlert } = proxyResult;
	const { response, errorBodyText } = await materializeNonOkResponse(proxyResult.response);
	await proxyResult.usagePromise.catch(() => undefined);

	const latencyMs = Date.now() - start;
	const meta = proxyResult.meta;
	const durationSeconds = response.ok ? (meta?.audioDurationSeconds ?? 0) : 0;
	const durationSource =
		response.ok && meta?.audioDurationSource
			? meta.audioDurationSource
			: 'estimated';
	const tokenUsage = response.ok ? (meta?.audioTokenUsage ?? null) : null;

	let userModelCircuitEvent = null;
	if (response.ok) {
		markUserModelSuccess(apiKey.userId, baseModelId);
	} else if (errorBodyText != null) {
		userModelCircuitEvent = maybeTriggerUserModelCircuitFromUpstream(
			apiKey.userId,
			baseModelId,
			response.status,
			response.headers.get('content-type'),
			errorBodyText,
			formatHttpErrorTextForRequestLog(
				response.status,
				response.headers.get('content-type'),
				errorBodyText
			),
			{ clientErrorCircuitEnabled: false }
		);
	}
	const alertCircuitEvents = userModelCircuitEvent
		? [...circuitEvents, userModelCircuitEvent]
		: circuitEvents;

	const status: 'success' | 'error' = response.ok ? 'success' : 'error';
	const errorMessage =
		status === 'error'
			? errorBodyText != null
				? formatHttpErrorTextForRequestLog(
						response.status,
						response.headers.get('content-type'),
						errorBodyText
					)
				: `HTTP ${response.status}`
			: undefined;

	scheduleBackgroundWork(
		c,
		recordAudioUsage({
			repos,
			apiKeyId: apiKey.keyId,
			userId: apiKey.userId,
			userEmail: apiKey.userEmail,
			modelId: baseModelId,
			providerId: chosenRoute.providerId,
			providerModelName: chosenRoute.providerModelName,
			modelName: modelNameForLog,
			providerName: chosenRoute.providerName,
			requestBody: requestBodyForLog,
			requestProtocol: 'openai',
			requestOperation: 'audio.transcriptions',
			upstreamProtocol: chosenRoute.upstreamProtocol,
			upstreamOperation: chosenRoute.upstreamOperation,
			modelSurfaceId: chosenRoute.modelSurfaceId,
			routePoolId: chosenRoute.routePoolId,
			routeTargetId: chosenRoute.targetId,
			adapter: chosenRoute.adapter,
			routeGroup: effectiveRouteGroup,
			status,
			latencyMs,
			errorMessage,
			billing: {
				modelPricingProfileJson,
				routePriceOverrideJson: chosenRoute.priceOverrideRaw,
				durationSeconds,
				durationSource,
				fileBytes,
				requestStartedAtMs: start,
				tokenUsage,
			},
			providerKeyId: chosenRoute.providerKeyId ?? null,
			providerKeyLabel: chosenRoute.providerKeyLabel ?? null,
			providerKeyFingerprint: chosenRoute.providerKeyFingerprint ?? null,
			upstreamRequestId,
			timing: timing.snapshot(),
			circuitEvents: alertCircuitEvents.length > 0 ? alertCircuitEvents : undefined,
			suppressErrorAlert: suppressErrorAlert || undefined,
		}).catch((err) => {
			console.error(
				`[Gateway Audio] recordAudioUsage failed baseModelId=${baseModelId} keyId=${apiKey.keyId} error=${err instanceof Error ? err.message : String(err)}`
			);
		})
	);

	return response;
}
