import type { GatewayProvider } from '@/lib/types';
import {
	listConfiguredCapabilities,
	parseProviderEndpoints,
	resolveUpstreamEndpoint,
	serializeProviderEndpoints,
	type ProviderEndpointCapability,
	type ProviderEndpointsMap,
	type ProtocolEndpointsConfig,
} from '@octafuse/core/provider-endpoints';
import { GEMINI_GENERATE_OPERATION } from '@octafuse/core/route-topology';
import type { UpstreamProtocol } from '@octafuse/core/upstream-protocol';
import {
	parseProviderCustomHeaders,
	type ProviderCustomHeadersMap,
} from '@octafuse/core/provider-custom-headers';
import type {
	CustomHeaderRow,
	GeminiLegacyPerActionEndpoints,
	ProtocolEndpointForm,
	ProviderCapabilityBadge,
	ProviderFormData,
	ProviderProtocolSummary,
} from './types';
import { EMPTY_PROTOCOL_FORM } from './types';

/** 完整 capability → 卡片紧凑标签（OpenAI images.* → images；audio.transcriptions → audio）。 */
export function capabilityDisplayBadges(
	capabilities: readonly ProviderEndpointCapability[]
): ProviderCapabilityBadge[] {
	const badges: ProviderCapabilityBadge[] = [];
	const set = new Set(capabilities);
	if (set.has('chat')) badges.push('chat');
	if (set.has('responses')) badges.push('responses');
	if (set.has('images.generations') || set.has('images.edits')) badges.push('images');
	if (set.has('audio.transcriptions')) badges.push('audio');
	if (set.has('messages')) badges.push('messages');
	if (set.has(GEMINI_GENERATE_OPERATION) || set.has('generateContent') || set.has('streamGenerateContent')) {
		badges.push('modelsGenerate');
	}
	return badges;
}

function customHeadersToRows(headers: Record<string, string> | undefined): CustomHeaderRow[] {
	if (!headers) return [];
	return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

/**
 * If both legacy URLs differ only by the trailing `:action`, collapse to a shared `{action}` template.
 */
export function tryCollapseGeminiLegacyEndpoints(
	generateContent: string,
	streamGenerateContent: string
): string | null {
	const gen = generateContent.trim();
	const stream = streamGenerateContent.trim();
	if (!gen || !stream) return null;
	const asTemplate = (url: string, action: string): string | null => {
		const suffix = `:${action}`;
		if (!url.endsWith(suffix)) return null;
		return `${url.slice(0, -suffix.length)}:{action}`;
	};
	const t1 = asTemplate(gen, 'generateContent');
	const t2 = asTemplate(stream, 'streamGenerateContent');
	if (t1 && t2 && t1 === t2) return t1;
	return null;
}

function protocolFormFromConfig(
	cfg: ProtocolEndpointsConfig | undefined,
	customHeaders: Record<string, string> | undefined
): ProtocolEndpointForm {
	// customHeaders 必须在任何 early return 之前写入：下方 Gemini family /
	// collapsed 分支都会提前 return，若在函数末尾赋值会静默丢掉自定义 header。
	const form: ProtocolEndpointForm = {
		...EMPTY_PROTOCOL_FORM,
		legacyPerAction: null,
		customHeaders: customHeadersToRows(customHeaders),
	};
	if (!cfg) return form;
	form.base = cfg.base ?? '';
	const eps = cfg.endpoints ?? {};
	form.chat = eps.chat ?? '';
	// fork 独有 Responses surface：上游没有这一行，合并时必须保留。
	form.responses = eps.responses ?? '';
	form.images_generations = eps['images.generations'] ?? '';
	form.images_edits = eps['images.edits'] ?? '';
	form.audio_transcriptions = eps['audio.transcriptions'] ?? '';
	form.messages = eps.messages ?? '';

	const family = eps[GEMINI_GENERATE_OPERATION]?.trim() ?? '';
	const legacyGen = eps.generateContent?.trim() ?? '';
	const legacyStream = eps.streamGenerateContent?.trim() ?? '';
	if (family) {
		form.modelsGenerate = family;
		return form;
	}
	if (legacyGen && legacyStream) {
		const collapsed = tryCollapseGeminiLegacyEndpoints(legacyGen, legacyStream);
		if (collapsed) {
			form.modelsGenerate = collapsed;
			return form;
		}
		form.legacyPerAction = {
			generateContent: legacyGen,
			streamGenerateContent: legacyStream,
		};
		form.generateContent = legacyGen;
		form.streamGenerateContent = legacyStream;
		return form;
	}
	if (legacyGen || legacyStream) {
		const legacy: GeminiLegacyPerActionEndpoints = {
			generateContent: legacyGen,
			streamGenerateContent: legacyStream,
		};
		form.legacyPerAction = legacy;
		form.generateContent = legacyGen;
		form.streamGenerateContent = legacyStream;
	}
	return form;
}

/** Provider 行 → 弹窗表单（`endpoints` + `custom_headers`；api_key 留空表示不改）。 */
export function providerToFormData(provider: GatewayProvider): Omit<ProviderFormData, 'id' | 'name' | 'description'> & {
	openai: ProtocolEndpointForm;
	anthropic: ProtocolEndpointForm;
	gemini: ProtocolEndpointForm;
} {
	const map = parseProviderEndpoints(provider);
	const headers: ProviderCustomHeadersMap = parseProviderCustomHeaders(provider);
	return {
		api_key: '',
		status: provider.status === 'disabled' ? 'disabled' : 'active',
		openai: protocolFormFromConfig(map.openai, headers.openai),
		anthropic: protocolFormFromConfig(map.anthropic, headers.anthropic),
		gemini: protocolFormFromConfig(map.gemini, headers.gemini),
	};
}

function configFromProtocolForm(
	protocol: 'openai' | 'anthropic' | 'gemini',
	form: ProtocolEndpointForm
): ProtocolEndpointsConfig | undefined {
	const base = form.base.trim();
	const endpoints: NonNullable<ProtocolEndpointsConfig['endpoints']> = {};
	if (protocol === 'openai') {
		if (form.chat.trim()) endpoints.chat = form.chat.trim();
		if (form.responses.trim()) endpoints.responses = form.responses.trim();
		if (form.images_generations.trim()) endpoints['images.generations'] = form.images_generations.trim();
		if (form.images_edits.trim()) endpoints['images.edits'] = form.images_edits.trim();
		if (form.audio_transcriptions.trim()) {
			endpoints['audio.transcriptions'] = form.audio_transcriptions.trim();
		}
	} else if (protocol === 'anthropic') {
		if (form.messages.trim()) endpoints.messages = form.messages.trim();
	} else if (form.legacyPerAction) {
		const gen = form.legacyPerAction.generateContent.trim();
		const stream = form.legacyPerAction.streamGenerateContent.trim();
		if (gen) endpoints.generateContent = gen;
		if (stream) endpoints.streamGenerateContent = stream;
	} else if (form.modelsGenerate.trim()) {
		endpoints[GEMINI_GENERATE_OPERATION] = form.modelsGenerate.trim();
	}
	if (!base && Object.keys(endpoints).length === 0) return undefined;
	const cfg: ProtocolEndpointsConfig = {};
	if (base) cfg.base = base;
	if (Object.keys(endpoints).length > 0) cfg.endpoints = endpoints;
	return cfg;
}

/** 表单 → API `endpoints` 对象。 */
export function formDataToEndpointsMap(form: ProviderFormData): ProviderEndpointsMap {
	const map: ProviderEndpointsMap = {};
	const openai = configFromProtocolForm('openai', form.openai);
	const anthropic = configFromProtocolForm('anthropic', form.anthropic);
	const gemini = configFromProtocolForm('gemini', form.gemini);
	if (openai) map.openai = openai;
	if (anthropic) map.anthropic = anthropic;
	if (gemini) map.gemini = gemini;
	return map;
}

export function formDataToEndpointsJson(form: ProviderFormData): string | null {
	return serializeProviderEndpoints(formDataToEndpointsMap(form));
}

/** 单协议表单 → 该协议自定义 header 记录；空名/空行过滤，重名后者覆盖前者。 */
function protocolFormToHeaderRecord(form: ProtocolEndpointForm): Record<string, string> | undefined {
	const record: Record<string, string> = {};
	for (const row of form.customHeaders) {
		const name = row.name.trim();
		if (!name) continue;
		record[name] = row.value;
	}
	return Object.keys(record).length > 0 ? record : undefined;
}

/** 表单 → API `customHeaders` 对象（provider × 协议粒度）。 */
export function formDataToCustomHeadersMap(form: ProviderFormData): ProviderCustomHeadersMap {
	const map: ProviderCustomHeadersMap = {};
	const openai = protocolFormToHeaderRecord(form.openai);
	const anthropic = protocolFormToHeaderRecord(form.anthropic);
	const gemini = protocolFormToHeaderRecord(form.gemini);
	if (openai) map.openai = openai;
	if (anthropic) map.anthropic = anthropic;
	if (gemini) map.gemini = gemini;
	return map;
}

export function getProviderProtocolSummaries(provider: GatewayProvider): ProviderProtocolSummary[] {
	const map = parseProviderEndpoints(provider);
	const rows: ProviderProtocolSummary[] = [];

	const appendProtocol = (
		key: UpstreamProtocol,
		label: string
	) => {
		const config = map[key];
		if (!config) return;
		const capabilities = listConfiguredCapabilities(map, key);
		if (capabilities.length === 0) return;
		const endpoints = capabilities.flatMap((capability) => {
			try {
				const resolved = resolveUpstreamEndpoint(key, capability, map, {
					model: '{model}',
					action: key === 'gemini' ? 'generateContent' : undefined,
					providerId: provider.id,
				})
					.replace(/%7Bmodel%7D/gi, '{model}')
					.replace(/:generateContent$/i, ':{action}');
				const override =
					Boolean(config.endpoints?.[capability]) ||
					(key === 'gemini' &&
						(Boolean(config.endpoints?.[GEMINI_GENERATE_OPERATION]) ||
							Boolean(config.endpoints?.generateContent) ||
							Boolean(config.endpoints?.streamGenerateContent)));
				return [{
					capability,
					url: resolved,
					source: override ? 'override' as const : 'base' as const,
				}];
			} catch {
				return [];
			}
		});
		if (endpoints.length === 0) return;
		rows.push({
			key,
			label,
			baseUrl: config.base ?? null,
			overrideCount: Object.keys(config.endpoints ?? {}).length,
			capabilities,
			badges: capabilityDisplayBadges(capabilities),
			endpoints,
		});
	};

	appendProtocol('openai', 'OpenAI');
	appendProtocol('anthropic', 'Anthropic');
	appendProtocol('gemini', 'Gemini');
	return rows;
}

export function suggestDuplicateProviderId(sourceId: string, existingIds: Set<string>): string {
	const base = `${sourceId}-copy`;
	if (!existingIds.has(base)) return base;
	for (let n = 2; n < 1000; n++) {
		const candidate = `${base}-${n}`;
		if (!existingIds.has(candidate)) return candidate;
	}
	return '';
}

/** 某协议 Advanced 区是否有任意覆盖（用于默认展开）。 */
export function protocolFormHasOverrides(
	protocol: 'openai' | 'anthropic' | 'gemini',
	form: ProtocolEndpointForm
): boolean {
	if (protocol === 'openai') {
		return !!(
			form.chat.trim() ||
			form.images_generations.trim() ||
			form.images_edits.trim() ||
			form.audio_transcriptions.trim()
		);
	}
	if (protocol === 'anthropic') return !!form.messages.trim();
	return !!(
		form.modelsGenerate.trim() ||
		form.legacyPerAction ||
		form.generateContent.trim() ||
		form.streamGenerateContent.trim()
	);
}

/** 某协议是否配置了任意非空自定义 header（用于 Advanced 区默认展开）。 */
export function protocolFormHasCustomHeaders(form: ProtocolEndpointForm): boolean {
	return form.customHeaders.some((row) => row.name.trim() !== '');
}
