/**
 * 上游 HTTP 代理与故障转移：按协议分发到 openai/anthropic/gemini driver，并在流开始前按路由顺序重试。
 * 返回的 `usagePromise` 在流结束后解析 token 用量，供 `usage-tracker` 记账。
 */
import { providerDeclaresResponsesEndpoint, type GatewayRepositories } from '@octafuse/core';
import type { RouteResult } from './model-router';
import { dispatchOpenAiRoute } from './egress/openai-driver';
import { dispatchOpenAiResponsesRoute } from './egress/openai-responses-driver';
import { dispatchResponsesViaChatRoute } from './egress/openai-responses-chat-driver';
import {
	dispatchOpenAiImageEdits,
	dispatchOpenAiImageGenerations,
	type NormalizedImageEditRequest,
} from './egress/openai-images-driver';
import {
	dispatchOpenAiAudioTranscriptions,
	type NormalizedAudioTranscriptionRequest,
} from './egress/openai-audio-driver';
import { dispatchAnthropicRoute } from './egress/anthropic-driver';
import { dispatchGeminiRoute } from './egress/gemini-driver';
import {
	failoverDispatch,
	type FailoverDispatchOptions,
	type ProxyDispatchMeta,
} from './failover-dispatch';
import type { GatewayCircuitAlertEvent } from './circuit-alert-types';
import type { RequestTimingAttempt, RequestTimingCollector } from './request-timing';

export type { FailoverDispatchOptions, ProxyDispatchMeta } from './failover-dispatch';

/** 各协议 driver 从上游响应/stream 汇总出的用量（供 `usage-tracker` 计价）。 */
export interface UsageFromStream {
	/** 输入侧常规 token（含逻辑输入；具体口径见各 driver） */
	input_tokens: number;
	/** 按 `output_price` 计费的输出 token（Gemini：`candidatesTokenCount`+`thoughtsTokenCount`；OpenAI：completion 总量） */
	output_tokens: number;
	/** 缓存命中等按上游 usage 拆出的只读类 token */
	cache_read_tokens: number;
	cache_write_tokens: number;
	/** 推理/thinking 分列（Gemini：thoughts，为计入 `output_tokens` 的子集；OpenAI：completion 内 reasoning 子集） */
	reasoning_tokens: number;
	total_tokens: number;
	/** 上游 usage 对象 JSON 字符串快照，便于审计 */
	raw_usage: string | null;
	/** 客户端在流结束前断开（如用户取消）时置位 */
	cancelled?: boolean;
	/**
	 * 上游响应 body 里的「生成结果」id（OpenAI `chatcmpl-*` / Anthropic `msg_*` / Gemini `responseId`）。
	 * 与 header 侧 `upstreamRequestId` 语义不同：这是应用层 message id，穿透聚合商/CDN，随 usage 一起解析。
	 */
	upstreamMessageId?: string | null;
	/** Gemini 等上游 body 内非标准的 request id 字段（`requestId` / `request_id`），与 message id 区分 */
	upstreamBodyRequestId?: string | null;
}

export interface ProxyResult {
	response: Response;
	usagePromise: Promise<UsageFromStream>;
	/** 上游响应头中的 provider 追踪 id（如 x-request-id） */
	upstreamRequestId: string | null;
	/** 实际选用或最后尝试的路由（用于日志）；若全部失败则为最后一次尝试 */
	chosenRoute: RouteResult;
	/** 本次请求触发的熔断事件（provider / user+model） */
	circuitEvents: GatewayCircuitAlertEvent[];
	/** 因已有熔断短路、无需重复 webhook 告警 */
	suppressErrorAlert: boolean;
	/** Images 等协议透传已解析字段，避免 route 侧重复 parse */
	meta?: ProxyDispatchMeta;
}

/** 无用量或解析失败时的零值占位（避免 undefined 传播）。 */
export const EMPTY_USAGE: UsageFromStream = {
	input_tokens: 0,
	output_tokens: 0,
	cache_read_tokens: 0,
	cache_write_tokens: 0,
	reasoning_tokens: 0,
	total_tokens: 0,
	raw_usage: null,
};

/**
 * 代理 OpenAI Chat Completions：外层 provider 优先级 + 层内 route strategy failover。
 */
export async function proxyChatCompletions(
	repos: GatewayRepositories,
	routes: RouteResult[],
	body: Record<string, unknown>,
	requestSignal?: AbortSignal,
	options?: FailoverDispatchOptions
): Promise<ProxyResult> {
	const result = await failoverDispatch(
		repos,
		routes,
		'openai',
		(route, signal, timing?: RequestTimingCollector | null, attempt?: RequestTimingAttempt) =>
			dispatchOpenAiRoute(route, body, signal, timing, attempt),
		requestSignal,
		options
	);
	return result;
}

/**
 * 代理 OpenAI Responses API（Codex CLI 协议）：与 chat 同一 failover 编排，
 * 但驱动为字节直通，且额外闭包 `clientIdentity`（调用方 UA / originator）。
 *
 * `clientIdentity` 由入口路由从请求头提取后传入 —— `DispatchFn` 契约不含请求对象，
 * 驱动无法自行读取（与 `body` 同理，见 design.md C2）。
 *
 * **策略按 route 逐条决定**（phase 2）：显式声明 `endpoints.openai.endpoints.responses`
 * 的 provider 走 phase 1 字节直通；其余翻译成 `/chat/completions`。
 * 判定放在 dispatch 闭包内而非路由层，是为了让「原生 provider 故障转移到 chat-only provider」
 * 这种混合路由组也能工作 —— `DispatchFn` 收到的是当次尝试的 route。
 *
 * 排序上「原生直通优先」，但只在**同一 priority 层内**生效（见 `preferWithinTier`）：
 * 原生可用时行为与 phase 1 一致，翻译仅作兜底；同时不会让低优先级的原生 provider
 * 抢占 admin 明确配置为高优先级的 chat-only provider。
 */
export async function proxyResponses(
	repos: GatewayRepositories,
	routes: RouteResult[],
	body: Record<string, unknown>,
	clientIdentity: Record<string, string>,
	requestSignal?: AbortSignal,
	options?: FailoverDispatchOptions
): Promise<ProxyResult> {
	const result = await failoverDispatch(
		repos,
		routes,
		'openai',
		(route, signal, timing?: RequestTimingCollector | null, attempt?: RequestTimingAttempt) =>
			providerDeclaresResponsesEndpoint(route.providerEndpoints)
				? dispatchOpenAiResponsesRoute(route, body, clientIdentity, signal, timing, attempt)
				: dispatchResponsesViaChatRoute(route, body, clientIdentity, signal, timing, attempt),
		requestSignal,
		{
			...options,
			// 直通优先只在同一 priority 层内生效：admin 配的分层不被越过。
			preferWithinTier: (route) => providerDeclaresResponsesEndpoint(route.providerEndpoints),
		}
	);
	return result;
}

/**
 * 代理 Anthropic Messages API。
 */
export async function proxyAnthropicMessages(
	repos: GatewayRepositories,
	routes: RouteResult[],
	body: Record<string, unknown>,
	requestSignal?: AbortSignal,
	options?: FailoverDispatchOptions
): Promise<ProxyResult> {
	return failoverDispatch(
		repos,
		routes,
		'anthropic',
		(route, signal, timing?: RequestTimingCollector | null, attempt?: RequestTimingAttempt) =>
			dispatchAnthropicRoute(route, body, signal, timing, attempt),
		requestSignal,
		options
	);
}

/**
 * 代理 OpenAI Images Generations。
 */
export async function proxyImageGenerations(
	repos: GatewayRepositories,
	routes: RouteResult[],
	body: Record<string, unknown>,
	requestSignal?: AbortSignal,
	options?: FailoverDispatchOptions
): Promise<ProxyResult> {
	return failoverDispatch(
		repos,
		routes,
		'openai',
		(route, signal, timing?: RequestTimingCollector | null, attempt?: RequestTimingAttempt) =>
			dispatchOpenAiImageGenerations(route, body, signal, timing, attempt),
		requestSignal,
		options
	);
}

/**
 * 代理 OpenAI Images Edits（multipart；每次 attempt 重建 FormData）。
 */
export async function proxyImageEdits(
	repos: GatewayRepositories,
	routes: RouteResult[],
	edit: NormalizedImageEditRequest,
	requestSignal?: AbortSignal,
	options?: FailoverDispatchOptions
): Promise<ProxyResult> {
	return failoverDispatch(
		repos,
		routes,
		'openai',
		(route, signal, timing?: RequestTimingCollector | null, attempt?: RequestTimingAttempt) =>
			dispatchOpenAiImageEdits(route, edit, signal, timing, attempt),
		requestSignal,
		options
	);
}

/**
 * 代理 OpenAI Audio Transcriptions（multipart；每次 attempt 重建 FormData）。
 */
export async function proxyAudioTranscriptions(
	repos: GatewayRepositories,
	routes: RouteResult[],
	req: NormalizedAudioTranscriptionRequest,
	requestSignal?: AbortSignal,
	options?: FailoverDispatchOptions
): Promise<ProxyResult> {
	return failoverDispatch(
		repos,
		routes,
		'openai',
		(route, signal, timing?: RequestTimingCollector | null, attempt?: RequestTimingAttempt) =>
			dispatchOpenAiAudioTranscriptions(route, req, signal, timing, attempt),
		requestSignal,
		options
	);
}

/**
 * 代理 Gemini `generateContent` / `streamGenerateContent`。
 */
export async function proxyGeminiContent(
	repos: GatewayRepositories,
	routes: RouteResult[],
	action: 'generateContent' | 'streamGenerateContent',
	body: Record<string, unknown>,
	search: string,
	requestSignal?: AbortSignal,
	options?: FailoverDispatchOptions
): Promise<ProxyResult> {
	return failoverDispatch(
		repos,
		routes,
		'gemini',
		(route, signal, timing?: RequestTimingCollector | null, attempt?: RequestTimingAttempt) =>
			dispatchGeminiRoute(route, body, action, search, signal, timing, attempt),
		requestSignal,
		options
	);
}
