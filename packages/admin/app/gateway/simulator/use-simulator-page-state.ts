'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { flushSync } from 'react-dom';
import { readApiJson } from '@/lib/api-json';
import { isAudioRouteModel, validateAudioTranscriptionFile } from '@/lib/audio-transcriptions';
import {
	imageRequestMetaFromBody,
	isImageRouteModel,
	parseImagesGenerationsResponse,
	validateEditImageFiles,
	type ImageOperation,
	type ImagePreviewItem,
} from '@/lib/image-generations';
import {
	inferPlaygroundParseMode,
	mergeAssistantTextParts,
	type PlaygroundProtocol,
} from '@/lib/playground/merge-assistant-text';
import { normalizeProtocol, parseLastStreamUsage, tryParseUsageSummary } from '@/lib/playground/usage-parsing';
import {
	buildSimulatorRequest,
	type SimulatorGeminiAction,
	type SimulatorProtocol,
} from '@/lib/simulator/endpoint';
import type { AdminKeyListItem, AdminModelRow } from '@/lib/services/admin/types';
import type { ApiResponse } from '@/lib/types';
import {
	DEFAULT_INVOKE_KIND,
	emptyModelKindCounts,
	GATEWAY_TOOL_IDS,
	isInvokeKind,
	modelKindFromFlags,
	parseGatewayToolId,
	resolveRequestOperation,
	type GatewayToolId,
	type InvokeKind,
	type ModelKindFilter,
} from '@/lib/invoke-kind';
import { GATEWAY_TOOLS } from '@/lib/gateway-tools';
import {
	BODY_TEMPLATES,
	bodyTemplateForSelection,
	bodyTemplateForTool,
	KEYS_PAGE_SIZE,
	LS_INVOKE_KIND,
	LS_KEY_ID,
	LS_MODEL_ID,
	LS_PROTOCOL,
	LS_PROXY,
	LS_ROUTE_GROUP,
	LS_TOOL_ID,
	buildModelRoutingString,
	filterMatchingActiveRoutes,
	isBodyDirty,
	listGatewayTools,
	redactHeaders,
	tryParseProxyBaseUrl,
} from './simulator-utils';
import type { ResponseMeta, ResponseTab, RouteListRow, SendBlockReason, WirePreview } from './types';
import type { SimulatorOpenAiSurface } from '@/lib/simulator/endpoint';

function resolveModelKind(m: AdminModelRow | null | undefined): ModelKindFilter {
	if (!m) return 'llm';
	return modelKindFromFlags(isAudioRouteModel(m), isImageRouteModel(m));
}

export function useSimulatorPageState() {
	const t = useTranslations('simulator');
	const tCommon = useTranslations('common');

	const [proxyBaseUrl, setProxyBaseUrl] = useState('');
	const [protocol, setProtocolState] = useState<SimulatorProtocol>('openai');
	const [geminiAction, setGeminiAction] = useState<SimulatorGeminiAction>('streamGenerateContent');
	/** OpenAI 协议下测 `/v1/chat/completions` 还是 `/v1/responses`（Codex 用后者）。 */
	const [openaiSurface, setOpenaiSurfaceState] = useState<SimulatorOpenAiSurface>('chat');
	const [imageOperation, setImageOperationState] = useState<ImageOperation>('generations');
	const [editFiles, setEditFiles] = useState<File[]>([]);
	const [audioFile, setAudioFile] = useState<File | null>(null);

	const [models, setModels] = useState<AdminModelRow[]>([]);
	const [routes, setRoutes] = useState<RouteListRow[]>([]);
	const [loadingCatalog, setLoadingCatalog] = useState(true);
	const [catalogError, setCatalogError] = useState<string | null>(null);

	/** llm|image|audio|tool；tool 时走 `/v1/tools/*`，隐藏 model/route */
	const [filterKind, setFilterKind] = useState<InvokeKind>(DEFAULT_INVOKE_KIND);
	const [filterModel, setFilterModel] = useState('');
	const [selectedModelId, setSelectedModelId] = useState('');
	const [selectedToolId, setSelectedToolId] = useState<GatewayToolId>(GATEWAY_TOOL_IDS[0] ?? 'web-search');
	const [routeGroup, setRouteGroup] = useState('');
	const isToolKind = filterKind === 'tool';

	const [keys, setKeys] = useState<AdminKeyListItem[]>([]);
	const [keysTotal, setKeysTotal] = useState(0);
	const [filterKeyEmail, setFilterKeyEmail] = useState('');
	const [loadingKeys, setLoadingKeys] = useState(false);
	const [keysError, setKeysError] = useState<string | null>(null);

	const [selectedKeyId, setSelectedKeyId] = useState('');
	const [revealedSk, setRevealedSk] = useState<string | null>(null);
	const [revealLoading, setRevealLoading] = useState(false);
	const [revealError, setRevealError] = useState<string | null>(null);

	const [bodyText, setBodyText] = useState(BODY_TEMPLATES.openai);
	const [bodyError, setBodyError] = useState<string | null>(null);
	const [infoHint, setInfoHint] = useState<string | null>(null);

	const [sending, setSending] = useState(false);
	const abortRef = useRef<AbortController | null>(null);
	const [responseMeta, setResponseMeta] = useState<ResponseMeta | null>(null);
	const [responseText, setResponseText] = useState('');
	const [responseProtocol, setResponseProtocol] = useState<PlaygroundProtocol>('openai');
	const [usageHint, setUsageHint] = useState<string | null>(null);
	const [wirePreview, setWirePreview] = useState<WirePreview | null>(null);
	const [wireOpen, setWireOpen] = useState(false);
	const [responseTab, setResponseTab] = useState<ResponseTab>('merged');
	const [imagePreviews, setImagePreviews] = useState<ImagePreviewItem[]>([]);
	const [hydrated, setHydrated] = useState(false);

	const streamEndRef = useRef<HTMLSpanElement>(null);
	const mergedStreamEndRef = useRef<HTMLSpanElement>(null);

	const kindCounts = useMemo(() => {
		const counts = { ...emptyModelKindCounts(), tool: GATEWAY_TOOLS.length };
		for (const m of models) {
			counts[resolveModelKind(m)] += 1;
		}
		return counts;
	}, [models]);

	const modelsInKind = useMemo(
		() =>
			isToolKind ? [] : models.filter((m) => resolveModelKind(m) === (filterKind as ModelKindFilter)),
		[models, filterKind, isToolKind]
	);

	const filteredModels = useMemo(() => {
		const q = filterModel.trim().toLowerCase();
		if (!q) return modelsInKind;
		return modelsInKind.filter(
			(m) =>
				m.id.toLowerCase().includes(q) ||
				(m.display_name ?? '').toLowerCase().includes(q) ||
				m.vendor.toLowerCase().includes(q)
		);
	}, [modelsInKind, filterModel]);

	const setFilterKindAndClear = useCallback(
		(next: InvokeKind) => {
			if (next === filterKind) return;
			setFilterKind(next);
			setFilterModel('');
			setSelectedModelId('');
			setRouteGroup('');
			if (next === 'tool') {
				setBodyText(bodyTemplateForTool(selectedToolId));
				setBodyError(null);
			} else if (filterKind === 'tool') {
				setBodyText(bodyTemplateForSelection(protocol, next === 'image', imageOperation, next === 'audio'));
				setBodyError(null);
			}
		},
		[filterKind, selectedToolId, protocol, imageOperation]
	);

	const selectTool = useCallback((id: string) => {
		const parsed = parseGatewayToolId(id);
		if (!parsed) return;
		setSelectedToolId(parsed);
		setBodyText(bodyTemplateForTool(parsed));
		setBodyError(null);
	}, []);

	const modelIdsWithActiveRouter = useMemo(() => {
		const s = new Set<string>();
		for (const r of routes) {
			if (r.model_id && String(r.status).toLowerCase() === 'active') {
				s.add(r.model_id);
			}
		}
		return s;
	}, [routes]);

	const routeGroupsForModel = useMemo(() => {
		if (!selectedModelId) return [] as string[];
		const set = new Set<string>();
		for (const r of routes) {
			if (r.model_id === selectedModelId && String(r.status).toLowerCase() === 'active' && r.route_group) {
				set.add(r.route_group);
			}
		}
		return Array.from(set).sort((a, b) => a.localeCompare(b));
	}, [routes, selectedModelId]);

	const selectedModel = useMemo(
		() => models.find((m) => m.id === selectedModelId) ?? null,
		[models, selectedModelId]
	);

	const selectedModelIsImage = useMemo(
		() => (selectedModel ? isImageRouteModel(selectedModel) : false),
		[selectedModel]
	);

	const selectedModelIsAudio = useMemo(
		() => (selectedModel ? isAudioRouteModel(selectedModel) : false),
		[selectedModel]
	);

	const modelRoutingString = useMemo(() => {
		if (!selectedModelId) return '';
		return buildModelRoutingString(selectedModelId, routeGroup);
	}, [selectedModelId, routeGroup]);

	const requestOperation = isToolKind
		? null
		: resolveRequestOperation({
				kind: filterKind,
				protocol,
				imageOperation,
				geminiAction,
			});
	const matchingRoutes = useMemo(
		() =>
			isToolKind
				? []
				: filterMatchingActiveRoutes(
						routes,
						selectedModelId,
						routeGroup,
						protocol,
						requestOperation ?? undefined
					),
		[routes, selectedModelId, routeGroup, protocol, requestOperation, isToolKind]
	);

	const sendBlockReason = useMemo((): SendBlockReason => {
		const parsed = tryParseProxyBaseUrl(proxyBaseUrl);
		if (!parsed.ok) return 'proxyBaseUrl';
		if (isToolKind) {
			if (!selectedToolId) return 'tool';
		} else {
			if (!selectedModelId) return 'model';
			if (selectedModelIsAudio && protocol !== 'openai') return 'audioProtocol';
			if (selectedModelIsImage && !selectedModelIsAudio && protocol !== 'openai') {
				return 'imageProtocol';
			}
			if (selectedModelIsAudio && protocol === 'openai') {
				const validated = validateAudioTranscriptionFile(audioFile);
				if (!validated.ok) return 'audioFile';
			}
			if (
				selectedModelIsImage &&
				!selectedModelIsAudio &&
				protocol === 'openai' &&
				imageOperation === 'edits'
			) {
				const validated = validateEditImageFiles(editFiles);
				if (!validated.ok) return 'editImages';
			}
		}
		if (revealLoading && selectedKeyId) return 'keyLoading';
		if (!revealedSk || !revealedSk.startsWith('sk-')) return 'key';
		return null;
	}, [
		proxyBaseUrl,
		isToolKind,
		selectedToolId,
		selectedModelId,
		selectedModelIsImage,
		selectedModelIsAudio,
		protocol,
		imageOperation,
		editFiles,
		audioFile,
		revealLoading,
		selectedKeyId,
		revealedSk,
	]);

	const sendBlockedHint = useMemo(() => {
		switch (sendBlockReason) {
			case 'proxyBaseUrl':
				return t('readyNeedProxyUrl');
			case 'model':
				return t('readyNeedModel');
			case 'tool':
				return t('readyNeedTool');
			case 'imageProtocol':
				return t('readyNeedOpenaiForImage');
			case 'audioProtocol':
				return t('protocolLockedAudio');
			case 'audioFile': {
				if (!audioFile) return null;
				const validated = validateAudioTranscriptionFile(audioFile);
				return validated.ok ? null : validated.error;
			}
			case 'editImages': {
				// Empty-file hint is shown under the reference-images control; only surface size/count errors here.
				if (editFiles.length === 0) return null;
				const validated = validateEditImageFiles(editFiles);
				return validated.ok ? null : validated.error;
			}
			case 'keyLoading':
				return t('readyNeedKeyLoading');
			case 'key':
				return t('readyNeedKey');
			default:
				return null;
		}
	}, [sendBlockReason, editFiles, audioFile, t]);

	const liveWirePreview = useMemo((): WirePreview | null => {
		const parsed = tryParseProxyBaseUrl(proxyBaseUrl);
		if (!parsed.ok || !revealedSk?.startsWith('sk-')) return null;
		if (isToolKind) {
			if (!selectedToolId) return null;
		} else if (!selectedModelId) {
			return null;
		}
		let bodyObj: Record<string, unknown>;
		try {
			bodyObj = JSON.parse(bodyText) as Record<string, unknown>;
			if (bodyObj === null || typeof bodyObj !== 'object' || Array.isArray(bodyObj)) return null;
		} catch {
			return null;
		}
		const routing = modelRoutingString;
		if (!isToolKind && (protocol === 'openai' || protocol === 'anthropic')) {
			bodyObj = { ...bodyObj, model: routing };
		}
		try {
			const useAudio = !isToolKind && selectedModelIsAudio && protocol === 'openai';
			const useImages =
				!isToolKind && selectedModelIsImage && !selectedModelIsAudio && protocol === 'openai';
			const built = buildSimulatorRequest({
				baseUrl: parsed.base,
				kind: filterKind,
				toolId: isToolKind ? selectedToolId : undefined,
				protocol,
				modelForRouting: routing || selectedToolId,
				geminiAction: protocol === 'gemini' ? geminiAction : undefined,
				openaiSurface: protocol === 'openai' ? openaiSurface : undefined,
				body: bodyObj,
				apiKey: revealedSk,
				audioTranscriptions: useAudio || undefined,
				audioFile: useAudio ? audioFile : undefined,
				imageOperation: useImages ? imageOperation : undefined,
				editImages: useImages && imageOperation === 'edits' ? editFiles : undefined,
			});
			return {
				method: 'POST',
				url: built.url,
				headers: redactHeaders(built.headers),
				bodyText: built.formData ? (built.multipartSummary ?? '(multipart)') : built.bodyText,
				isMultipart: Boolean(built.formData),
			};
		} catch {
			return null;
		}
	}, [
		proxyBaseUrl,
		openaiSurface,
		isToolKind,
		selectedToolId,
		selectedModelId,
		revealedSk,
		bodyText,
		modelRoutingString,
		protocol,
		geminiAction,
		filterKind,
		selectedModelIsImage,
		selectedModelIsAudio,
		imageOperation,
		editFiles,
		audioFile,
	]);

	const displayWire = wirePreview ?? liveWirePreview;

	const mergedAssistantParts = useMemo(() => {
		const mode = inferPlaygroundParseMode(responseMeta?.contentType ?? null);
		if (!responseText.trim() || !mode) {
			return { reasoning: '', body: '' };
		}
		return mergeAssistantTextParts(responseText, responseProtocol, mode);
	}, [responseText, responseProtocol, responseMeta?.contentType]);

	const { mergedReasoningDisplay, mergedBodyDisplay } = useMemo(() => {
		const hasRaw = responseText.trim().length > 0;
		const p = mergedAssistantParts;
		const reasoningDisplay =
			p.reasoning ||
			(sending && hasRaw ? t('receiving') : '') ||
			(!sending && hasRaw && !p.reasoning ? '—' : '');
		const bodyDisplay =
			p.body ||
			(sending && hasRaw ? t('receiving') : '') ||
			(!sending && hasRaw && !p.body ? (!p.reasoning ? t('couldNotExtractBody') : '—') : '');
		return { mergedReasoningDisplay: reasoningDisplay, mergedBodyDisplay: bodyDisplay };
	}, [mergedAssistantParts, responseText, sending, t]);

	const scrollStreamToBottom = useCallback(() => {
		streamEndRef.current?.scrollIntoView({ behavior: 'smooth' });
		mergedStreamEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, []);

	useEffect(() => {
		try {
			const u = localStorage.getItem(LS_PROXY);
			if (u) setProxyBaseUrl(u);
			const p = localStorage.getItem(LS_PROTOCOL);
			if (p === 'openai' || p === 'anthropic' || p === 'gemini') {
				setProtocolState(p);
				setBodyText(BODY_TEMPLATES[p]);
			}
			const kindRaw = localStorage.getItem(LS_INVOKE_KIND);
			if (kindRaw && isInvokeKind(kindRaw)) {
				setFilterKind(kindRaw);
			}
			const toolRaw = localStorage.getItem(LS_TOOL_ID);
			const toolParsed = parseGatewayToolId(toolRaw);
			if (toolParsed) {
				setSelectedToolId(toolParsed);
				if (kindRaw === 'tool') {
					setBodyText(bodyTemplateForTool(toolParsed));
				}
			}
			const mid = localStorage.getItem(LS_MODEL_ID);
			if (mid) setSelectedModelId(mid);
			const rg = localStorage.getItem(LS_ROUTE_GROUP);
			if (rg != null) setRouteGroup(rg);
			const kid = localStorage.getItem(LS_KEY_ID);
			if (kid) setSelectedKeyId(kid);
		} catch {
			// ignore
		}
		setHydrated(true);
	}, []);

	useEffect(() => {
		if (!hydrated) return;
		try {
			localStorage.setItem(LS_PROXY, proxyBaseUrl);
		} catch {
			// ignore
		}
	}, [proxyBaseUrl, hydrated]);

	useEffect(() => {
		if (!hydrated) return;
		try {
			localStorage.setItem(LS_PROTOCOL, protocol);
		} catch {
			// ignore
		}
	}, [protocol, hydrated]);

	useEffect(() => {
		if (!hydrated) return;
		try {
			if (selectedModelId) localStorage.setItem(LS_MODEL_ID, selectedModelId);
			else localStorage.removeItem(LS_MODEL_ID);
		} catch {
			// ignore
		}
	}, [selectedModelId, hydrated]);

	useEffect(() => {
		if (!hydrated) return;
		try {
			localStorage.setItem(LS_ROUTE_GROUP, routeGroup);
		} catch {
			// ignore
		}
	}, [routeGroup, hydrated]);

	useEffect(() => {
		if (!hydrated) return;
		try {
			if (selectedKeyId) localStorage.setItem(LS_KEY_ID, selectedKeyId);
			else localStorage.removeItem(LS_KEY_ID);
		} catch {
			// ignore
		}
	}, [selectedKeyId, hydrated]);

	useEffect(() => {
		if (!hydrated) return;
		try {
			localStorage.setItem(LS_INVOKE_KIND, filterKind);
		} catch {
			// ignore
		}
	}, [filterKind, hydrated]);

	useEffect(() => {
		if (!hydrated) return;
		try {
			localStorage.setItem(LS_TOOL_ID, selectedToolId);
		} catch {
			// ignore
		}
	}, [selectedToolId, hydrated]);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			setLoadingCatalog(true);
			setCatalogError(null);
			try {
				const [mRes, rRes] = await Promise.all([fetch('/api/admin/models'), fetch('/api/admin/routes')]);
				const mData = await readApiJson<AdminModelRow[]>(mRes);
				const rData = await readApiJson<RouteListRow[]>(rRes);
				if (cancelled) return;
				if (mData.success && Array.isArray(mData.data)) {
					setModels(mData.data);
				} else {
					setCatalogError(mData.message ?? tCommon('failedToLoadModels'));
				}
				if (rData.success && Array.isArray(rData.data)) {
					setRoutes(rData.data);
				} else if (!cancelled) {
					setCatalogError((prev) => prev ?? rData.message ?? tCommon('failedToLoadRoutes'));
				}
			} catch (e) {
				if (!cancelled) setCatalogError(e instanceof Error ? e.message : tCommon('failedToLoadModels'));
			} finally {
				if (!cancelled) setLoadingCatalog(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [tCommon]);

	useEffect(() => {
		if (!selectedModelId) return;
		if (routeGroup && !routeGroupsForModel.includes(routeGroup) && routeGroupsForModel.length > 0) {
			setRouteGroup('');
		}
	}, [selectedModelId, routeGroup, routeGroupsForModel]);

	/**
	 * localStorage 恢复的模型可能是 Image/Audio：把 Kind 对齐到该模型，
	 * 避免默认 LLM 视图立刻把选中项清掉。Tools 模式不跟模型对齐。
	 */
	useEffect(() => {
		if (isToolKind) return;
		if (!selectedModelId || models.length === 0) return;
		const m = models.find((x) => x.id === selectedModelId);
		if (!m) return;
		const k = resolveModelKind(m);
		if (k !== filterKind) {
			setFilterKind(k);
		}
	}, [models, selectedModelId, filterKind, isToolKind]);

	const prevSelectedSpecialKindRef = useRef<'none' | 'image' | 'audio'>('none');

	/** Image / Audio models: force openai + kind template; leaving restores chat template. */
	useEffect(() => {
		if (selectedModelIsAudio) {
			if (protocol !== 'openai') {
				setProtocolState('openai');
			}
			setBodyText(bodyTemplateForSelection('openai', false, 'generations', true));
			setBodyError(null);
			setImagePreviews([]);
			setEditFiles([]);
			setAudioFile(null);
			prevSelectedSpecialKindRef.current = 'audio';
			return;
		}
		if (selectedModelIsImage) {
			if (protocol !== 'openai') {
				setProtocolState('openai');
			}
			setBodyText(bodyTemplateForSelection('openai', true, imageOperation, false));
			setBodyError(null);
			setImagePreviews([]);
			setAudioFile(null);
			prevSelectedSpecialKindRef.current = 'image';
			return;
		}
		if (prevSelectedSpecialKindRef.current !== 'none') {
			setImageOperationState('generations');
			setEditFiles([]);
			setAudioFile(null);
			setBodyText(bodyTemplateForSelection(protocol, false, 'generations', false));
			setBodyError(null);
			setImagePreviews([]);
			prevSelectedSpecialKindRef.current = 'none';
		}
	}, [selectedModelId, selectedModelIsImage, selectedModelIsAudio]); // eslint-disable-line react-hooks/exhaustive-deps -- template only on model kind switch

	const setImageOperation = useCallback(
		(next: ImageOperation) => {
			if (next === imageOperation) return;
			setImageOperationState(next);
			if (selectedModelIsImage && protocol === 'openai') {
				setBodyText(bodyTemplateForSelection('openai', true, next));
				setBodyError(null);
			}
			if (next === 'generations') {
				setEditFiles([]);
			}
		},
		[imageOperation, selectedModelIsImage, protocol]
	);

	const loadKeys = useCallback(async () => {
		setLoadingKeys(true);
		setKeysError(null);
		try {
			const sp = new URLSearchParams({
				page: '1',
				page_size: String(KEYS_PAGE_SIZE),
			});
			if (filterKeyEmail.trim()) sp.set('email', filterKeyEmail.trim());
			const res = await fetch(`/api/admin/keys?${sp.toString()}`);
			const data = await readApiJson<AdminKeyListItem[]>(res);
			if (data.success && Array.isArray(data.data) && typeof data.total === 'number') {
				setKeys(data.data);
				setKeysTotal(data.total);
			} else {
				setKeysError(data.message ?? tCommon('failedToLoadApiKeys'));
			}
		} catch (e) {
			setKeysError(e instanceof Error ? e.message : tCommon('failedToLoadApiKeys'));
		} finally {
			setLoadingKeys(false);
		}
	}, [filterKeyEmail, tCommon]);

	useEffect(() => {
		void loadKeys();
	}, [loadKeys]);

	useEffect(() => {
		if (!selectedKeyId) {
			setRevealedSk(null);
			setRevealError(null);
			setRevealLoading(false);
			return;
		}
		let cancelled = false;
		setRevealLoading(true);
		setRevealError(null);
		setRevealedSk(null);
		void (async () => {
			try {
				const res = await fetch(`/api/admin/keys/${encodeURIComponent(selectedKeyId)}`);
				const data = await readApiJson<{ key: string }>(res);
				if (cancelled) return;
				if (data.success && data.data && typeof data.data.key === 'string') {
					setRevealedSk(data.data.key);
				} else {
					setRevealError(data.message ?? tCommon('failedToLoadApiKeys'));
				}
			} catch (e) {
				if (!cancelled) setRevealError(e instanceof Error ? e.message : tCommon('failedToLoadApiKeys'));
			} finally {
				if (!cancelled) setRevealLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [selectedKeyId, tCommon]);

	const applyProtocolTemplate = useCallback(
		(next: SimulatorProtocol, isImage = selectedModelIsImage, isAudio = selectedModelIsAudio) => {
			setProtocolState(next);
			setBodyText(
				bodyTemplateForSelection(
					next,
					isImage && !isAudio && next === 'openai',
					imageOperation,
					isAudio && next === 'openai',
					null,
					next === 'openai' ? openaiSurface : 'chat'
				)
			);
			setBodyError(null);
		},
		[selectedModelIsImage, selectedModelIsAudio, imageOperation, openaiSurface]
	);

	const requestProtocolChange = useCallback(
		(next: SimulatorProtocol) => {
			if (next === protocol) return;
			if (selectedModelIsAudio && next !== 'openai') {
				setInfoHint(t('protocolLockedAudio'));
				return;
			}
			if (selectedModelIsImage && !selectedModelIsAudio && next !== 'openai') {
				setInfoHint(t('readyNeedOpenaiForImage'));
				return;
			}
			if (
				isBodyDirty(
					bodyText,
					protocol,
					selectedModelIsImage && !selectedModelIsAudio,
					imageOperation,
					selectedModelIsAudio
				)
			) {
				const ok = window.confirm(t('protocolSwitchConfirm'));
				if (!ok) return;
			}
			applyProtocolTemplate(next);
		},
		[
			protocol,
			bodyText,
			t,
			applyProtocolTemplate,
			selectedModelIsImage,
			selectedModelIsAudio,
			imageOperation,
		]
	);

	const requestOpenaiSurfaceChange = useCallback(
		(next: SimulatorOpenAiSurface) => {
			if (next === openaiSurface) return;
			if (
				isBodyDirty(
					bodyText,
					protocol,
					selectedModelIsImage && !selectedModelIsAudio,
					imageOperation,
					selectedModelIsAudio,
					null,
					openaiSurface
				)
			) {
				const ok = window.confirm(t('protocolSwitchConfirm'));
				if (!ok) return;
			}
			setOpenaiSurfaceState(next);
			setBodyText(
				bodyTemplateForSelection('openai', false, imageOperation, false, null, next)
			);
			setBodyError(null);
		},
		[openaiSurface, bodyText, protocol, selectedModelIsImage, selectedModelIsAudio, imageOperation, t]
	);

	const applyCurrentTemplate = useCallback(() => {
		setBodyText(
			isToolKind
				? bodyTemplateForTool(selectedToolId)
				: bodyTemplateForSelection(
						protocol,
						selectedModelIsImage && !selectedModelIsAudio,
						imageOperation,
						selectedModelIsAudio,
						null,
						protocol === 'openai' ? openaiSurface : 'chat'
					)
		);
		setBodyError(null);
	}, [
		isToolKind,
		selectedToolId,
		protocol,
		selectedModelIsImage,
		selectedModelIsAudio,
		imageOperation,
		openaiSurface,
	]);

	const stop = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
	}, []);

	const send = useCallback(async () => {
		setInfoHint(null);
		const parsed = tryParseProxyBaseUrl(proxyBaseUrl);
		if (!parsed.ok) {
			setBodyError(parsed.reason === 'empty' ? t('errProxyUrlRequired') : t('errProxyUrlInvalid'));
			return;
		}
		const base = parsed.base;

		if (isToolKind) {
			if (!selectedToolId) {
				setBodyError(t('errSelectTool'));
				return;
			}
		} else if (!selectedModelId) {
			setBodyError(t('errSelectModel'));
			return;
		}
		if (revealLoading) {
			setBodyError(t('errKeyLoading'));
			return;
		}
		if (!revealedSk || !revealedSk.startsWith('sk-')) {
			setBodyError(t('errSelectKey'));
			return;
		}

		let bodyObj: Record<string, unknown>;
		try {
			bodyObj = JSON.parse(bodyText) as Record<string, unknown>;
			if (bodyObj === null || typeof bodyObj !== 'object' || Array.isArray(bodyObj)) {
				setBodyError(t('errBodyMustBeObject'));
				return;
			}
		} catch {
			setBodyError(tCommon('invalidJson'));
			return;
		}

		const protoNorm = normalizeProtocol(protocol);
		setResponseProtocol(protoNorm);

		const routing = modelRoutingString;
		if (!isToolKind && (protocol === 'openai' || protocol === 'anthropic')) {
			const prev = bodyObj.model;
			bodyObj = { ...bodyObj, model: routing };
			if (prev !== routing) {
				setInfoHint(t('infoModelOverwritten', { model: routing }));
			}
		}

		const useAudio = !isToolKind && selectedModelIsAudio && protocol === 'openai';
		const useImages =
			!isToolKind && selectedModelIsImage && !selectedModelIsAudio && protocol === 'openai';
		if (useAudio) {
			const validated = validateAudioTranscriptionFile(audioFile);
			if (!validated.ok) {
				setBodyError(validated.error);
				return;
			}
		}
		if (useImages && imageOperation === 'edits') {
			const validated = validateEditImageFiles(editFiles);
			if (!validated.ok) {
				setBodyError(validated.error);
				return;
			}
		}

		let built;
		try {
			built = buildSimulatorRequest({
				baseUrl: base,
				kind: filterKind,
				toolId: isToolKind ? selectedToolId : undefined,
				protocol,
				modelForRouting: routing || selectedToolId,
				geminiAction: protocol === 'gemini' ? geminiAction : undefined,
				openaiSurface: protocol === 'openai' ? openaiSurface : undefined,
				body: bodyObj,
				apiKey: revealedSk,
				audioTranscriptions: useAudio || undefined,
				audioFile: useAudio ? audioFile : undefined,
				imageOperation: useImages ? imageOperation : undefined,
				editImages: useImages && imageOperation === 'edits' ? editFiles : undefined,
			});
		} catch (e) {
			setBodyError(e instanceof Error ? e.message : tCommon('requestFailed'));
			return;
		}

		setBodyError(null);
		setSending(true);
		setResponseText('');
		setUsageHint(null);
		setImagePreviews([]);
		setResponseMeta(null);
		setResponseTab('merged');
		setWirePreview({
			method: 'POST',
			url: built.url,
			headers: redactHeaders(built.headers),
			bodyText: built.formData ? (built.multipartSummary ?? '(multipart)') : built.bodyText,
			isMultipart: Boolean(built.formData),
		});
		setWireOpen(true);

		const ac = new AbortController();
		abortRef.current = ac;
		const t0 = performance.now();

		try {
			const res = await fetch(built.url, {
				method: 'POST',
				headers: built.headers,
				body: built.formData ?? built.bodyText,
				signal: ac.signal,
			});

			const latencyMs = String(Math.round(performance.now() - t0));
			const ct = res.headers.get('Content-Type') ?? '';

			setResponseMeta({
				status: res.status,
				latencyMs,
				requestUrl: built.url,
				contentType: ct,
			});

			const jsonErr = ct.includes('application/json') && !ct.includes('text/event-stream');
			if (jsonErr) {
				const j = (await res.json()) as ApiResponse<unknown> & {
					error?: string | { message?: string };
					message?: string;
				};
				setResponseText(JSON.stringify(j, null, 2));
				if (!res.ok) {
					setUsageHint(null);
					const errObj = j.error;
					const nestedMsg =
						errObj && typeof errObj === 'object' && 'message' in errObj
							? String((errObj as { message?: unknown }).message ?? '')
							: '';
					const nestedUrl =
						errObj && typeof errObj === 'object' && 'upstream_url' in errObj
							? String((errObj as { upstream_url?: unknown }).upstream_url ?? '')
							: '';
					let msg = (j.message ?? '').trim();
					if (!msg && typeof errObj === 'string') msg = errObj;
					if (!msg) msg = nestedMsg.trim();
					if (!msg) msg = tCommon('requestFailed');
					if (nestedUrl) msg = `${msg}\nupstream: ${nestedUrl}`;
					setBodyError(msg);
				} else if (useImages) {
					const parsedImg = parseImagesGenerationsResponse(
						JSON.stringify(j),
						imageRequestMetaFromBody(bodyObj)
					);
					setImagePreviews(parsedImg.images);
					setUsageHint(parsedImg.usageHint);
				} else {
					setUsageHint(tryParseUsageSummary(JSON.stringify(j), protoNorm));
				}
				setSending(false);
				return;
			}

			if (ct.includes('text/event-stream') && res.body) {
				const reader = res.body.getReader();
				const dec = new TextDecoder();
				let acc = '';
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					acc += dec.decode(value, { stream: true });
					flushSync(() => {
						setResponseText(acc);
					});
					scrollStreamToBottom();
				}
				acc += dec.decode();
				flushSync(() => {
					setResponseText(acc);
				});
				setUsageHint(parseLastStreamUsage(acc, protoNorm));
				setSending(false);
				return;
			}

			const text = await res.text();
			setResponseText(text);
			if (useImages && res.ok) {
				const parsedImg = parseImagesGenerationsResponse(text, imageRequestMetaFromBody(bodyObj));
				setImagePreviews(parsedImg.images);
				setUsageHint(parsedImg.usageHint);
			} else {
				let summary: string | null = null;
				try {
					summary = tryParseUsageSummary(text, protoNorm);
				} catch {
					summary = null;
				}
				setUsageHint(summary);
			}
			if (!res.ok) {
				setBodyError(text.slice(0, 500) || `HTTP ${res.status}`);
			}
		} catch (e) {
			if (e instanceof DOMException && e.name === 'AbortError') {
				setBodyError(tCommon('requestCancelled'));
				setResponseText('');
			} else {
				setResponseText('');
				setBodyError(e instanceof Error ? e.message : tCommon('requestFailed'));
			}
		} finally {
			setSending(false);
			abortRef.current = null;
		}
	}, [
		proxyBaseUrl,
		openaiSurface,
		isToolKind,
		filterKind,
		selectedToolId,
		selectedModelId,
		selectedModelIsImage,
		selectedModelIsAudio,
		imageOperation,
		editFiles,
		audioFile,
		revealLoading,
		revealedSk,
		bodyText,
		protocol,
		modelRoutingString,
		geminiAction,
		t,
		tCommon,
		scrollStreamToBottom,
	]);

	const selectModel = useCallback((id: string) => {
		setSelectedModelId(id);
		setRouteGroup('');
	}, []);

	return {
		loadingCatalog,
		catalogError,
		proxyBaseUrl,
		setProxyBaseUrl,
		protocol,
		requestProtocolChange,
		applyCurrentTemplate,
		bodyDirty: isBodyDirty(
			bodyText,
			protocol,
			selectedModelIsImage && !selectedModelIsAudio,
			imageOperation,
			selectedModelIsAudio,
			isToolKind ? selectedToolId : null,
			protocol === 'openai' ? openaiSurface : 'chat'
		),
		geminiAction,
		setGeminiAction,
		openaiSurface,
		requestOpenaiSurfaceChange,
		imageOperation,
		setImageOperation,
		editFiles,
		setEditFiles,
		audioFile,
		setAudioFile,
		filterKind,
		setFilterKind: setFilterKindAndClear,
		isToolKind,
		kindCounts,
		filterModel,
		setFilterModel,
		filteredModels,
		models,
		modelsInKind,
		modelIdsWithActiveRouter,
		selectedModelId,
		selectModel,
		selectedToolId,
		selectTool,
		gatewayTools: listGatewayTools(),
		routeGroup,
		setRouteGroup,
		routeGroupsForModel,
		selectedModel,
		selectedModelIsImage,
		selectedModelIsAudio,
		modelRoutingString,
		matchingRoutes,
		imagePreviews,
		keys,
		keysTotal,
		filterKeyEmail,
		setFilterKeyEmail,
		loadingKeys,
		keysError,
		loadKeys,
		selectedKeyId,
		setSelectedKeyId,
		revealedSk,
		revealLoading,
		revealError,
		bodyText,
		setBodyText,
		bodyError,
		infoHint,
		sending,
		send,
		stop,
		sendBlockReason,
		sendBlockedHint,
		canSend: sendBlockReason === null && !sending,
		responseMeta,
		responseText,
		usageHint,
		displayWire,
		wireOpen,
		setWireOpen,
		responseTab,
		setResponseTab,
		mergedReasoningDisplay,
		mergedBodyDisplay,
		streamEndRef,
		mergedStreamEndRef,
	};
}

export type SimulatorPageState = ReturnType<typeof useSimulatorPageState>;
