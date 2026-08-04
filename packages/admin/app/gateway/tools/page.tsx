'use client';

/**
 * Tools 配置：产品工具（`/v1/tools/*`）的 per-provider catalog + active；写入 `system_config`。
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ConfigCardShell } from '@/components/ConfigCardShell';
import { readApiJson } from '@/lib/api-json';
import type { SystemConfigRow } from '@/lib/types';
import { useBillingCurrency } from '@/lib/use-billing-currency';
import {
	DEFAULT_WEB_SEARCH_COST,
	DEFAULT_WEB_SEARCH_PROVIDER,
	getWebSearchProviderOptions,
	WEB_SEARCH_ACTIVE_KEY,
	WEB_SEARCH_API_KEY_KEY,
	WEB_SEARCH_CATALOG_KEY,
	WEB_SEARCH_COST_KEY,
	WEB_SEARCH_PROVIDER_DOCS_URL,
	WEB_SEARCH_PROVIDER_KEY,
	WEB_SEARCH_PROVIDERS,
	type WebSearchProvider,
} from '@/lib/web-search-options';
import {
	DEFAULT_WEB_FETCH_COST,
	DEFAULT_WEB_FETCH_PROVIDER,
	getWebFetchProviderOptions,
	WEB_FETCH_ACTIVE_KEY,
	WEB_FETCH_API_KEY_KEY,
	WEB_FETCH_CATALOG_KEY,
	WEB_FETCH_COST_KEY,
	WEB_FETCH_PROVIDER_DOCS_URL,
	WEB_FETCH_PROVIDER_KEY,
	WEB_FETCH_PROVIDERS,
	type WebFetchProvider,
} from '@/lib/web-fetch-options';
import {
	DEFAULT_WEB_DEEP_SEARCH_COST,
	DEFAULT_WEB_DEEP_SEARCH_PROVIDER,
	getWebDeepSearchProviderOptions,
	WEB_DEEP_SEARCH_ACTIVE_KEY,
	WEB_DEEP_SEARCH_CATALOG_KEY,
	WEB_DEEP_SEARCH_PROVIDER_DOCS_URL,
	WEB_DEEP_SEARCH_PROVIDERS,
	type WebDeepSearchProvider,
} from '@/lib/web-deep-search-options';
import {
	AI_DETECTION_ACTIVE_KEY,
	AI_DETECTION_CATALOG_KEY,
	AI_DETECTION_PROVIDER_DOCS_URL,
	AI_DETECTION_PROVIDERS,
	DEFAULT_AI_DETECTION_BILLING_UNIT_CHARS,
	DEFAULT_AI_DETECTION_COST,
	DEFAULT_AI_DETECTION_PROVIDER,
	getAiDetectionCredentialFields,
	getAiDetectionProviderOptions,
	isAiDetectionImplementedProvider,
	type AiDetectionCredentialField,
	type AiDetectionProvider,
} from '@/lib/ai-detection-options';
import {
	parseWebFetchCatalogLenient,
	serializeWebFetchCatalog,
	type WebFetchCatalog,
} from '@octafuse/core/lib/web-fetch-system-config';
import {
	parseWebSearchCatalogLenient,
	serializeWebSearchCatalog,
	type WebSearchCatalog,
} from '@octafuse/core/lib/web-search-system-config';
import {
	parseWebDeepSearchCatalogLenient,
	serializeWebDeepSearchCatalog,
	type WebDeepSearchCatalog,
} from '@octafuse/core/lib/web-deep-search-system-config';
import {
	entryHasRequiredCredentials as aiEntryHasRequiredCredentials,
	parseAiDetectionCatalogLenient,
	serializeAiDetectionCatalog,
	AI_DETECTION_PROVIDER_REQUIRED_CREDENTIALS,
	type AiDetectionCatalog,
	type AiDetectionCatalogEntry,
} from '@octafuse/core/lib/ai-detection-system-config';
import { toToolPricingFields } from '@octafuse/core/lib/tool-pricing';
import { WebSearchProviderGuideModal } from './components/web-search-provider-guide-modal';

type ProviderDraft = {
	apiKey: string;
	metered: string;
	standard: string;
	charged: string;
};

type AiDetectionProviderDraft = {
	apiKey: string;
	secretId: string;
	secretKey: string;
	email: string;
	region: string;
	bizType: string;
	metered: string;
	standard: string;
	charged: string;
	billingUnitChars: string;
};

function defaultPriceTriple(defaultCost: number): Pick<ProviderDraft, 'metered' | 'standard' | 'charged'> {
	const s = String(defaultCost);
	return { metered: s, standard: s, charged: s };
}

function parseDraftMoney(raw: string): number | null {
	if (!raw.trim()) return null;
	const n = Number(raw.trim());
	if (!Number.isFinite(n) || n < 0) return null;
	return n;
}

function draftPricesOk(d: Pick<ProviderDraft, 'metered' | 'standard' | 'charged'>): boolean {
	return parseDraftMoney(d.metered) != null && parseDraftMoney(d.standard) != null && parseDraftMoney(d.charged) != null;
}

function entryToDraftPrices(entry: {
	metered: number;
	standard: number;
	charged: number;
	cost: number;
}): Pick<ProviderDraft, 'metered' | 'standard' | 'charged'> {
	const charged = entry.charged ?? entry.cost;
	return {
		metered: String(entry.metered ?? charged),
		standard: String(entry.standard ?? charged),
		charged: String(charged),
	};
}

function emptySearchDrafts(): Record<WebSearchProvider, ProviderDraft> {
	const out = {} as Record<WebSearchProvider, ProviderDraft>;
	for (const p of WEB_SEARCH_PROVIDERS) {
		out[p] = { apiKey: '', ...defaultPriceTriple(DEFAULT_WEB_SEARCH_COST) };
	}
	return out;
}

function emptyFetchDrafts(): Record<WebFetchProvider, ProviderDraft> {
	const out = {} as Record<WebFetchProvider, ProviderDraft>;
	for (const p of WEB_FETCH_PROVIDERS) {
		out[p] = { apiKey: '', ...defaultPriceTriple(DEFAULT_WEB_FETCH_COST) };
	}
	return out;
}

function emptyDeepSearchDrafts(): Record<WebDeepSearchProvider, ProviderDraft> {
	const out = {} as Record<WebDeepSearchProvider, ProviderDraft>;
	for (const p of WEB_DEEP_SEARCH_PROVIDERS) {
		out[p] = { apiKey: '', ...defaultPriceTriple(DEFAULT_WEB_DEEP_SEARCH_COST) };
	}
	return out;
}

function emptyAiDetectionDrafts(): Record<AiDetectionProvider, AiDetectionProviderDraft> {
	const out = {} as Record<AiDetectionProvider, AiDetectionProviderDraft>;
	for (const p of AI_DETECTION_PROVIDERS) {
		out[p] = {
			apiKey: '',
			secretId: '',
			secretKey: '',
			email: '',
			region: p === 'tencent_tms' ? 'ap-guangzhou' : '',
			bizType: '',
			...defaultPriceTriple(DEFAULT_AI_DETECTION_COST),
			billingUnitChars: String(DEFAULT_AI_DETECTION_BILLING_UNIT_CHARS),
		};
	}
	return out;
}

function draftToAiEntry(d: AiDetectionProviderDraft): AiDetectionCatalogEntry {
	const prices = toToolPricingFields({
		metered: Number(d.metered.trim()),
		standard: Number(d.standard.trim()),
		charged: Number(d.charged.trim()),
	});
	const entry: AiDetectionCatalogEntry = { ...prices };
	const billing = Number(d.billingUnitChars.trim());
	if (Number.isFinite(billing) && billing >= 1) {
		entry.billingUnitChars = Math.floor(billing);
	}
	if (d.apiKey.trim()) entry.apiKey = d.apiKey.trim();
	if (d.secretId.trim()) entry.secretId = d.secretId.trim();
	if (d.secretKey.trim()) entry.secretKey = d.secretKey.trim();
	if (d.email.trim()) entry.email = d.email.trim();
	if (d.region.trim()) entry.region = d.region.trim();
	if (d.bizType.trim()) entry.bizType = d.bizType.trim();
	return entry;
}

function aiDraftHasRequiredCredentials(provider: AiDetectionProvider, d: AiDetectionProviderDraft): boolean {
	if (!isAiDetectionImplementedProvider(provider)) {
		return false;
	}
	return aiEntryHasRequiredCredentials(
		draftToAiEntry(d),
		AI_DETECTION_PROVIDER_REQUIRED_CREDENTIALS[provider]
	);
}

function syncWebSearchFromRows(
	rows: SystemConfigRow[]
): { active: WebSearchProvider; drafts: Record<WebSearchProvider, ProviderDraft>; savedActive: WebSearchProvider | null } {
	const drafts = emptySearchDrafts();
	const catalogRaw = rows.find((r) => r.key === WEB_SEARCH_CATALOG_KEY)?.value ?? null;
	const catalogPresent = catalogRaw != null && String(catalogRaw).trim().length > 0;

	if (catalogPresent) {
		const catalog = parseWebSearchCatalogLenient(catalogRaw) ?? {};
		for (const p of WEB_SEARCH_PROVIDERS) {
			const entry = catalog[p];
			if (entry) {
				drafts[p] = { apiKey: entry.apiKey, ...entryToDraftPrices(entry) };
			}
		}
		const activeRaw = rows.find((r) => r.key === WEB_SEARCH_ACTIVE_KEY)?.value?.trim().toLowerCase() ?? '';
		const active = (WEB_SEARCH_PROVIDERS as readonly string[]).includes(activeRaw)
			? (activeRaw as WebSearchProvider)
			: DEFAULT_WEB_SEARCH_PROVIDER;
		const savedActive = (WEB_SEARCH_PROVIDERS as readonly string[]).includes(activeRaw)
			? (activeRaw as WebSearchProvider)
			: null;
		return { active, drafts, savedActive };
	}

	// 旧三键 seed
	const providerRaw = rows.find((r) => r.key === WEB_SEARCH_PROVIDER_KEY)?.value?.trim().toLowerCase() ?? '';
	const provider = (WEB_SEARCH_PROVIDERS as readonly string[]).includes(providerRaw)
		? (providerRaw as WebSearchProvider)
		: DEFAULT_WEB_SEARCH_PROVIDER;
	const apiKey = rows.find((r) => r.key === WEB_SEARCH_API_KEY_KEY)?.value ?? '';
	const costRaw = rows.find((r) => r.key === WEB_SEARCH_COST_KEY)?.value?.trim() ?? '';
	const legacyCost = costRaw || String(DEFAULT_WEB_SEARCH_COST);
	drafts[provider] = {
		apiKey,
		metered: legacyCost,
		standard: legacyCost,
		charged: legacyCost,
	};
	return { active: provider, drafts, savedActive: null };
}

function syncWebFetchFromRows(
	rows: SystemConfigRow[]
): { active: WebFetchProvider; drafts: Record<WebFetchProvider, ProviderDraft>; savedActive: WebFetchProvider | null } {
	const drafts = emptyFetchDrafts();
	const catalogRaw = rows.find((r) => r.key === WEB_FETCH_CATALOG_KEY)?.value ?? null;
	const catalogPresent = catalogRaw != null && String(catalogRaw).trim().length > 0;

	if (catalogPresent) {
		const catalog = parseWebFetchCatalogLenient(catalogRaw) ?? {};
		for (const p of WEB_FETCH_PROVIDERS) {
			const entry = catalog[p];
			if (entry) {
				drafts[p] = { apiKey: entry.apiKey, ...entryToDraftPrices(entry) };
			}
		}
		const activeRaw = rows.find((r) => r.key === WEB_FETCH_ACTIVE_KEY)?.value?.trim().toLowerCase() ?? '';
		const active = (WEB_FETCH_PROVIDERS as readonly string[]).includes(activeRaw)
			? (activeRaw as WebFetchProvider)
			: DEFAULT_WEB_FETCH_PROVIDER;
		const savedActive = (WEB_FETCH_PROVIDERS as readonly string[]).includes(activeRaw)
			? (activeRaw as WebFetchProvider)
			: null;
		return { active, drafts, savedActive };
	}

	const providerRaw = rows.find((r) => r.key === WEB_FETCH_PROVIDER_KEY)?.value?.trim().toLowerCase() ?? '';
	const provider = (WEB_FETCH_PROVIDERS as readonly string[]).includes(providerRaw)
		? (providerRaw as WebFetchProvider)
		: DEFAULT_WEB_FETCH_PROVIDER;
	const apiKey = rows.find((r) => r.key === WEB_FETCH_API_KEY_KEY)?.value ?? '';
	const costRaw = rows.find((r) => r.key === WEB_FETCH_COST_KEY)?.value?.trim() ?? '';
	const legacyCost = costRaw || String(DEFAULT_WEB_FETCH_COST);
	drafts[provider] = {
		apiKey,
		metered: legacyCost,
		standard: legacyCost,
		charged: legacyCost,
	};
	return { active: provider, drafts, savedActive: null };
}

function buildSearchCatalog(drafts: Record<WebSearchProvider, ProviderDraft>): WebSearchCatalog | null {
	const catalog: WebSearchCatalog = {};
	for (const p of WEB_SEARCH_PROVIDERS) {
		const d = drafts[p];
		if (!draftPricesOk(d)) {
			return null;
		}
		catalog[p] = {
			apiKey: d.apiKey.trim(),
			...toToolPricingFields({
				metered: parseDraftMoney(d.metered)!,
				standard: parseDraftMoney(d.standard)!,
				charged: parseDraftMoney(d.charged)!,
			}),
		};
	}
	return catalog;
}

function buildFetchCatalog(drafts: Record<WebFetchProvider, ProviderDraft>): WebFetchCatalog | null {
	const catalog: WebFetchCatalog = {};
	for (const p of WEB_FETCH_PROVIDERS) {
		const d = drafts[p];
		if (!draftPricesOk(d)) {
			return null;
		}
		catalog[p] = {
			apiKey: d.apiKey.trim(),
			...toToolPricingFields({
				metered: parseDraftMoney(d.metered)!,
				standard: parseDraftMoney(d.standard)!,
				charged: parseDraftMoney(d.charged)!,
			}),
		};
	}
	return catalog;
}

function syncWebDeepSearchFromRows(
	rows: SystemConfigRow[]
): {
	active: WebDeepSearchProvider;
	drafts: Record<WebDeepSearchProvider, ProviderDraft>;
	savedActive: WebDeepSearchProvider | null;
} {
	const drafts = emptyDeepSearchDrafts();
	const catalogRaw = rows.find((r) => r.key === WEB_DEEP_SEARCH_CATALOG_KEY)?.value ?? null;
	const catalogPresent = catalogRaw != null && String(catalogRaw).trim().length > 0;
	if (catalogPresent) {
		const catalog = parseWebDeepSearchCatalogLenient(catalogRaw) ?? {};
		for (const p of WEB_DEEP_SEARCH_PROVIDERS) {
			const entry = catalog[p];
			if (entry) {
				drafts[p] = { apiKey: entry.apiKey, ...entryToDraftPrices(entry) };
			}
		}
		const activeRaw = rows.find((r) => r.key === WEB_DEEP_SEARCH_ACTIVE_KEY)?.value?.trim().toLowerCase() ?? '';
		const active = (WEB_DEEP_SEARCH_PROVIDERS as readonly string[]).includes(activeRaw)
			? (activeRaw as WebDeepSearchProvider)
			: DEFAULT_WEB_DEEP_SEARCH_PROVIDER;
		const savedActive = (WEB_DEEP_SEARCH_PROVIDERS as readonly string[]).includes(activeRaw)
			? (activeRaw as WebDeepSearchProvider)
			: null;
		return { active, drafts, savedActive };
	}
	return { active: DEFAULT_WEB_DEEP_SEARCH_PROVIDER, drafts, savedActive: null };
}

function buildDeepSearchCatalog(
	drafts: Record<WebDeepSearchProvider, ProviderDraft>
): WebDeepSearchCatalog | null {
	const catalog: WebDeepSearchCatalog = {};
	for (const p of WEB_DEEP_SEARCH_PROVIDERS) {
		const d = drafts[p];
		if (!draftPricesOk(d)) {
			return null;
		}
		catalog[p] = {
			apiKey: d.apiKey.trim(),
			...toToolPricingFields({
				metered: parseDraftMoney(d.metered)!,
				standard: parseDraftMoney(d.standard)!,
				charged: parseDraftMoney(d.charged)!,
			}),
		};
	}
	return catalog;
}

function syncAiDetectionFromRows(rows: SystemConfigRow[]): {
	active: AiDetectionProvider;
	drafts: Record<AiDetectionProvider, AiDetectionProviderDraft>;
	savedActive: AiDetectionProvider | null;
} {
	const drafts = emptyAiDetectionDrafts();
	const catalogRaw = rows.find((r) => r.key === AI_DETECTION_CATALOG_KEY)?.value ?? null;
	const catalogPresent = catalogRaw != null && String(catalogRaw).trim().length > 0;
	if (catalogPresent) {
		const catalog = parseAiDetectionCatalogLenient(catalogRaw) ?? {};
		for (const p of AI_DETECTION_PROVIDERS) {
			const entry = catalog[p];
			if (entry) {
				drafts[p] = {
					apiKey: entry.apiKey ?? '',
					secretId: entry.secretId ?? '',
					secretKey: entry.secretKey ?? '',
					email: entry.email ?? '',
					region: entry.region ?? drafts[p].region,
					bizType: entry.bizType ?? '',
					...entryToDraftPrices(entry),
					billingUnitChars: String(
						entry.billingUnitChars ?? DEFAULT_AI_DETECTION_BILLING_UNIT_CHARS
					),
				};
			}
		}
		const activeRaw =
			rows.find((r) => r.key === AI_DETECTION_ACTIVE_KEY)?.value?.trim().toLowerCase() ?? '';
		const active = (AI_DETECTION_PROVIDERS as readonly string[]).includes(activeRaw)
			? (activeRaw as AiDetectionProvider)
			: DEFAULT_AI_DETECTION_PROVIDER;
		const savedActive = (AI_DETECTION_PROVIDERS as readonly string[]).includes(activeRaw)
			? (activeRaw as AiDetectionProvider)
			: null;
		return { active, drafts, savedActive };
	}
	return { active: DEFAULT_AI_DETECTION_PROVIDER, drafts, savedActive: null };
}

function buildAiDetectionCatalog(
	drafts: Record<AiDetectionProvider, AiDetectionProviderDraft>
): AiDetectionCatalog | null {
	const catalog: AiDetectionCatalog = {};
	for (const p of AI_DETECTION_PROVIDERS) {
		const d = drafts[p];
		if (!draftPricesOk(d)) {
			return null;
		}
		const unitChars = Number(d.billingUnitChars.trim());
		if (
			!d.billingUnitChars.trim() ||
			!Number.isFinite(unitChars) ||
			unitChars < 1 ||
			!Number.isInteger(unitChars)
		) {
			return null;
		}
		catalog[p] = draftToAiEntry(d);
	}
	return catalog;
}

async function putConfig(key: string, value: string): Promise<{ ok: true; message?: string } | { ok: false; message: string }> {
	const response = await fetch('/api/admin/config', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ key, value }),
	});
	const data = await readApiJson(response);
	if (!data.success) {
		return { ok: false, message: data.message || 'save failed' };
	}
	return { ok: true, message: data.message };
}

type ToolCardKey = 'webSearch' | 'webFetch' | 'webDeepSearch' | 'aiDetection';
type CardFeedback = { kind: 'success' | 'error'; message: string };

const AI_DETECTION_FIELD_I18N: Record<AiDetectionCredentialField, `aiDetection.fields.${AiDetectionCredentialField}`> = {
	apiKey: 'aiDetection.fields.apiKey',
	secretId: 'aiDetection.fields.secretId',
	secretKey: 'aiDetection.fields.secretKey',
	email: 'aiDetection.fields.email',
};

function CardSaveFeedback({ feedback }: { feedback?: CardFeedback }) {
	if (!feedback) {
		return null;
	}
	return (
		<span
			className={
				feedback.kind === 'success'
					? 'text-sm text-green-700'
					: 'text-sm text-red-700'
			}
			role={feedback.kind === 'success' ? 'status' : undefined}
		>
			{feedback.message}
		</span>
	);
}

function isLossPricing(value: Pick<ProviderDraft, 'metered' | 'charged'>): boolean {
	const metered = parseDraftMoney(value.metered);
	const charged = parseDraftMoney(value.charged);
	if (metered == null || charged == null) {
		return false;
	}
	return charged < metered;
}

function ToolPriceTripleInputs({
	value,
	onChange,
}: {
	value: Pick<ProviderDraft, 'metered' | 'standard' | 'charged'>;
	onChange: (patch: Partial<Pick<ProviderDraft, 'metered' | 'standard' | 'charged'>>) => void;
}) {
	const t = useTranslations('tools');
	/** 展示顺序：标准价 → 用户扣费 → 供应价（与 Routes 语义对齐，运营先看目录/扣费） */
	const fields: Array<{ key: 'standard' | 'charged' | 'metered'; labelKey: 'unitPrices.standard' | 'unitPrices.charged' | 'unitPrices.metered' }> = [
		{ key: 'standard', labelKey: 'unitPrices.standard' },
		{ key: 'charged', labelKey: 'unitPrices.charged' },
		{ key: 'metered', labelKey: 'unitPrices.metered' },
	];
	const loss = isLossPricing(value);
	return (
		<div
			className={
				loss
					? 'rounded-md border border-amber-400 bg-amber-50/80 p-2 ring-1 ring-amber-300'
					: 'rounded-md border border-transparent p-2'
			}
		>
			<div className="flex flex-col gap-1.5">
				{fields.map(({ key, labelKey }) => {
					const highlightCharged = loss && key === 'charged';
					const highlightMetered = loss && key === 'metered';
					return (
						<label key={key} className="flex items-center gap-1.5">
							<span
								className={
									highlightCharged || highlightMetered
										? 'w-[4.5rem] shrink-0 text-[10px] font-semibold text-amber-800'
										: 'w-[4.5rem] shrink-0 text-[10px] font-semibold text-gray-500'
								}
							>
								{t(labelKey)}
							</span>
							<input
								type="number"
								min={0}
								step="0.0001"
								value={value[key]}
								onChange={(e) => onChange({ [key]: e.target.value })}
								className={
									highlightCharged
										? 'w-full max-w-[7rem] rounded-md border border-amber-500 bg-white px-2 py-1 font-mono text-sm text-amber-950 shadow-sm'
										: 'w-full max-w-[7rem] rounded-md border border-gray-300 bg-white px-2 py-1 font-mono text-sm shadow-sm'
								}
							/>
						</label>
					);
				})}
			</div>
			{loss ? (
				<p className="mt-1.5 text-[10px] font-medium leading-snug text-amber-800">
					{t('unitPrices.lossHint')}
				</p>
			) : null}
		</div>
	);
}

export default function GatewayToolsConfigPage() {
	const t = useTranslations('tools');
	const tCommon = useTranslations('common');
	const { currency: billingCurrency } = useBillingCurrency();
	const webSearchProviderOptions = getWebSearchProviderOptions((k) => t(k));
	const webFetchProviderOptions = getWebFetchProviderOptions((k) => t(k));
	const webDeepSearchProviderOptions = getWebDeepSearchProviderOptions((k) => t(k));
	const aiDetectionProviderOptions = getAiDetectionProviderOptions((k) => t(k));

	const [isLoading, setIsLoading] = useState(true);
	/** 各卡片 Save 旁的反馈；放按钮右侧，避免顶部横幅撑开布局抖动 */
	const [cardFeedback, setCardFeedback] = useState<Partial<Record<ToolCardKey, CardFeedback>>>({});
	const successTimersRef = useRef<Partial<Record<ToolCardKey, ReturnType<typeof setTimeout>>>>({});

	const [webSearchActive, setWebSearchActive] = useState<WebSearchProvider>(DEFAULT_WEB_SEARCH_PROVIDER);
	const [webSearchSavedActive, setWebSearchSavedActive] = useState<WebSearchProvider | null>(null);
	const [webSearchDrafts, setWebSearchDrafts] = useState(emptySearchDrafts);
	const [webSearchSaving, setWebSearchSaving] = useState(false);
	const [providerGuideOpen, setProviderGuideOpen] = useState(false);

	const [webFetchActive, setWebFetchActive] = useState<WebFetchProvider>(DEFAULT_WEB_FETCH_PROVIDER);
	const [webFetchSavedActive, setWebFetchSavedActive] = useState<WebFetchProvider | null>(null);
	const [webFetchDrafts, setWebFetchDrafts] = useState(emptyFetchDrafts);
	const [webFetchSaving, setWebFetchSaving] = useState(false);

	const [webDeepSearchActive, setWebDeepSearchActive] = useState<WebDeepSearchProvider>(
		DEFAULT_WEB_DEEP_SEARCH_PROVIDER
	);
	const [webDeepSearchSavedActive, setWebDeepSearchSavedActive] = useState<WebDeepSearchProvider | null>(null);
	const [webDeepSearchDrafts, setWebDeepSearchDrafts] = useState(emptyDeepSearchDrafts);
	const [webDeepSearchSaving, setWebDeepSearchSaving] = useState(false);

	const [aiDetectionActive, setAiDetectionActive] =
		useState<AiDetectionProvider>(DEFAULT_AI_DETECTION_PROVIDER);
	const [aiDetectionSavedActive, setAiDetectionSavedActive] = useState<AiDetectionProvider | null>(null);
	const [aiDetectionDrafts, setAiDetectionDrafts] = useState(emptyAiDetectionDrafts);
	const [aiDetectionSaving, setAiDetectionSaving] = useState(false);

	/** 全页密钥明文开关；默认隐藏 */
	const [secretsVisible, setSecretsVisible] = useState(false);

	const clearCardSuccessTimer = useCallback((card: ToolCardKey) => {
		const timer = successTimersRef.current[card];
		if (timer != null) {
			clearTimeout(timer);
			delete successTimersRef.current[card];
		}
	}, []);

	const setCardError = useCallback(
		(card: ToolCardKey, message: string) => {
			clearCardSuccessTimer(card);
			setCardFeedback((prev) => ({ ...prev, [card]: { kind: 'error', message } }));
		},
		[clearCardSuccessTimer]
	);

	const flashCardSuccess = useCallback(
		(card: ToolCardKey, message?: string) => {
			clearCardSuccessTimer(card);
			setCardFeedback((prev) => ({
				...prev,
				[card]: { kind: 'success', message: message ?? tCommon('configUpdated') },
			}));
			successTimersRef.current[card] = setTimeout(() => {
				setCardFeedback((prev) => {
					const next = { ...prev };
					if (next[card]?.kind === 'success') {
						delete next[card];
					}
					return next;
				});
				delete successTimersRef.current[card];
			}, 2500);
		},
		[clearCardSuccessTimer, tCommon]
	);

	const clearCardFeedback = useCallback(
		(card: ToolCardKey) => {
			clearCardSuccessTimer(card);
			setCardFeedback((prev) => {
				const next = { ...prev };
				delete next[card];
				return next;
			});
		},
		[clearCardSuccessTimer]
	);

	const fetchConfig = useCallback(async () => {
		try {
			setIsLoading(true);
			const response = await fetch('/api/admin/config');
			const data = await readApiJson<SystemConfigRow[]>(response);
			if (data.success && Array.isArray(data.data)) {
				const search = syncWebSearchFromRows(data.data);
				setWebSearchActive(search.active);
				setWebSearchDrafts(search.drafts);
				setWebSearchSavedActive(search.savedActive);
				const fetch = syncWebFetchFromRows(data.data);
				setWebFetchActive(fetch.active);
				setWebFetchDrafts(fetch.drafts);
				setWebFetchSavedActive(fetch.savedActive);
				const deep = syncWebDeepSearchFromRows(data.data);
				setWebDeepSearchActive(deep.active);
				setWebDeepSearchDrafts(deep.drafts);
				setWebDeepSearchSavedActive(deep.savedActive);
				const ai = syncAiDetectionFromRows(data.data);
				setAiDetectionActive(ai.active);
				setAiDetectionDrafts(ai.drafts);
				setAiDetectionSavedActive(ai.savedActive);
			}
		} catch (error) {
			console.error('Fetch tools config error:', error);
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		void fetchConfig();
	}, [fetchConfig]);

	useEffect(() => {
		return () => {
			for (const timer of Object.values(successTimersRef.current)) {
				if (timer != null) {
					clearTimeout(timer);
				}
			}
		};
	}, []);

	const webSearchActivatable = useMemo(
		() => WEB_SEARCH_PROVIDERS.filter((p) => webSearchDrafts[p].apiKey.trim().length > 0),
		[webSearchDrafts]
	);
	const webFetchActivatable = useMemo(
		() => WEB_FETCH_PROVIDERS.filter((p) => webFetchDrafts[p].apiKey.trim().length > 0),
		[webFetchDrafts]
	);
	const webDeepSearchActivatable = useMemo(
		() => WEB_DEEP_SEARCH_PROVIDERS.filter((p) => webDeepSearchDrafts[p].apiKey.trim().length > 0),
		[webDeepSearchDrafts]
	);
	const aiDetectionActivatable = useMemo(
		() =>
			AI_DETECTION_PROVIDERS.filter(
				(p) => isAiDetectionImplementedProvider(p) && aiDraftHasRequiredCredentials(p, aiDetectionDrafts[p])
			),
		[aiDetectionDrafts]
	);

	useEffect(() => {
		if (webSearchActivatable.length > 0 && !webSearchActivatable.includes(webSearchActive)) {
			setWebSearchActive(webSearchActivatable[0]!);
		}
	}, [webSearchActivatable, webSearchActive]);

	useEffect(() => {
		if (webFetchActivatable.length > 0 && !webFetchActivatable.includes(webFetchActive)) {
			setWebFetchActive(webFetchActivatable[0]!);
		}
	}, [webFetchActivatable, webFetchActive]);

	useEffect(() => {
		if (webDeepSearchActivatable.length > 0 && !webDeepSearchActivatable.includes(webDeepSearchActive)) {
			setWebDeepSearchActive(webDeepSearchActivatable[0]!);
		}
	}, [webDeepSearchActivatable, webDeepSearchActive]);

	useEffect(() => {
		if (aiDetectionActivatable.length > 0 && !aiDetectionActivatable.includes(aiDetectionActive)) {
			setAiDetectionActive(aiDetectionActivatable[0]!);
		}
	}, [aiDetectionActivatable, aiDetectionActive]);

	const handleSaveWebSearch = async () => {
		const catalog = buildSearchCatalog(webSearchDrafts);
		if (!catalog) {
			setCardError('webSearch', t('errors.invalidWebSearchCost'));
			return;
		}
		if (!webSearchDrafts[webSearchActive].apiKey.trim()) {
			setCardError('webSearch', t('errors.noKeyCannotActivate'));
			return;
		}

		if (
			webSearchSavedActive &&
			webSearchSavedActive !== webSearchActive &&
			!catalog[webSearchSavedActive]?.apiKey?.trim()
		) {
			setCardError('webSearch', t('errors.switchActiveBeforeClearingKey'));
			return;
		}

		clearCardFeedback('webSearch');
		setWebSearchSaving(true);
		try {
			const catRes = await putConfig(WEB_SEARCH_CATALOG_KEY, serializeWebSearchCatalog(catalog));
			if (!catRes.ok) {
				setCardError('webSearch', catRes.message || tCommon('saveFailed'));
				return;
			}
			const actRes = await putConfig(WEB_SEARCH_ACTIVE_KEY, webSearchActive);
			if (!actRes.ok) {
				setCardError('webSearch', actRes.message || tCommon('saveFailed'));
				return;
			}
			setWebSearchSavedActive(webSearchActive);
			flashCardSuccess('webSearch', actRes.message ?? catRes.message);
		} catch {
			setCardError('webSearch', tCommon('requestFailed'));
		} finally {
			setWebSearchSaving(false);
		}
	};

	const handleSaveWebFetch = async () => {
		const catalog = buildFetchCatalog(webFetchDrafts);
		if (!catalog) {
			setCardError('webFetch', t('errors.invalidWebFetchCost'));
			return;
		}
		if (!webFetchDrafts[webFetchActive].apiKey.trim()) {
			setCardError('webFetch', t('errors.noKeyCannotActivate'));
			return;
		}
		if (
			webFetchSavedActive &&
			webFetchSavedActive !== webFetchActive &&
			!catalog[webFetchSavedActive]?.apiKey?.trim()
		) {
			setCardError('webFetch', t('errors.switchActiveBeforeClearingKey'));
			return;
		}

		clearCardFeedback('webFetch');
		setWebFetchSaving(true);
		try {
			const catRes = await putConfig(WEB_FETCH_CATALOG_KEY, serializeWebFetchCatalog(catalog));
			if (!catRes.ok) {
				setCardError('webFetch', catRes.message || tCommon('saveFailed'));
				return;
			}
			const actRes = await putConfig(WEB_FETCH_ACTIVE_KEY, webFetchActive);
			if (!actRes.ok) {
				setCardError('webFetch', actRes.message || tCommon('saveFailed'));
				return;
			}
			setWebFetchSavedActive(webFetchActive);
			flashCardSuccess('webFetch', actRes.message ?? catRes.message);
		} catch {
			setCardError('webFetch', tCommon('requestFailed'));
		} finally {
			setWebFetchSaving(false);
		}
	};

	const handleSaveWebDeepSearch = async () => {
		const catalog = buildDeepSearchCatalog(webDeepSearchDrafts);
		if (!catalog) {
			setCardError('webDeepSearch', t('errors.invalidWebDeepSearchCost'));
			return;
		}
		if (!webDeepSearchDrafts[webDeepSearchActive].apiKey.trim()) {
			setCardError('webDeepSearch', t('errors.noKeyCannotActivate'));
			return;
		}
		if (
			webDeepSearchSavedActive &&
			webDeepSearchSavedActive !== webDeepSearchActive &&
			!catalog[webDeepSearchSavedActive]?.apiKey?.trim()
		) {
			setCardError('webDeepSearch', t('errors.switchActiveBeforeClearingKey'));
			return;
		}

		clearCardFeedback('webDeepSearch');
		setWebDeepSearchSaving(true);
		try {
			const catRes = await putConfig(WEB_DEEP_SEARCH_CATALOG_KEY, serializeWebDeepSearchCatalog(catalog));
			if (!catRes.ok) {
				setCardError('webDeepSearch', catRes.message || tCommon('saveFailed'));
				return;
			}
			const actRes = await putConfig(WEB_DEEP_SEARCH_ACTIVE_KEY, webDeepSearchActive);
			if (!actRes.ok) {
				setCardError('webDeepSearch', actRes.message || tCommon('saveFailed'));
				return;
			}
			setWebDeepSearchSavedActive(webDeepSearchActive);
			flashCardSuccess('webDeepSearch', actRes.message ?? catRes.message);
		} catch {
			setCardError('webDeepSearch', tCommon('requestFailed'));
		} finally {
			setWebDeepSearchSaving(false);
		}
	};

	const handleSaveAiDetection = async () => {
		const catalog = buildAiDetectionCatalog(aiDetectionDrafts);
		if (!catalog) {
			setCardError('aiDetection', t('errors.invalidAiDetectionCost'));
			return;
		}
		if (!isAiDetectionImplementedProvider(aiDetectionActive)) {
			setCardError('aiDetection', t('errors.aiDetectionNotImplemented'));
			return;
		}
		if (!aiDraftHasRequiredCredentials(aiDetectionActive, aiDetectionDrafts[aiDetectionActive])) {
			setCardError('aiDetection', t('errors.noKeyCannotActivate'));
			return;
		}
		if (
			aiDetectionSavedActive &&
			aiDetectionSavedActive !== aiDetectionActive &&
			isAiDetectionImplementedProvider(aiDetectionSavedActive) &&
			!aiEntryHasRequiredCredentials(
				catalog[aiDetectionSavedActive],
				AI_DETECTION_PROVIDER_REQUIRED_CREDENTIALS[aiDetectionSavedActive]
			)
		) {
			setCardError('aiDetection', t('errors.switchActiveBeforeClearingKey'));
			return;
		}

		clearCardFeedback('aiDetection');
		setAiDetectionSaving(true);
		try {
			const catRes = await putConfig(AI_DETECTION_CATALOG_KEY, serializeAiDetectionCatalog(catalog));
			if (!catRes.ok) {
				setCardError('aiDetection', catRes.message || tCommon('saveFailed'));
				return;
			}
			const actRes = await putConfig(AI_DETECTION_ACTIVE_KEY, aiDetectionActive);
			if (!actRes.ok) {
				setCardError('aiDetection', actRes.message || tCommon('saveFailed'));
				return;
			}
			setAiDetectionSavedActive(aiDetectionActive);
			flashCardSuccess('aiDetection', actRes.message ?? catRes.message);
		} catch {
			setCardError('aiDetection', tCommon('requestFailed'));
		} finally {
			setAiDetectionSaving(false);
		}
	};

	if (isLoading) {
		return (
			<div className="flex h-full items-center justify-center">
				<div className="text-gray-600">{tCommon('loading')}</div>
			</div>
		);
	}

	return (
		<div className="p-8">
			<div className="mb-6 flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 className="text-3xl font-bold text-gray-900">{t('config.title')}</h1>
					<p className="mt-1 text-sm text-gray-500">{t('config.subtitle')}</p>
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<button
						type="button"
						onClick={() => setSecretsVisible((v) => !v)}
						className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
						aria-pressed={secretsVisible}
					>
						{secretsVisible ? (
							<>
								<EyeSlashIcon className="h-4 w-4" aria-hidden />
								{t('config.hideSecrets')}
							</>
						) : (
							<>
								<EyeIcon className="h-4 w-4" aria-hidden />
								{t('config.showSecrets')}
							</>
						)}
					</button>
					<Link
						href="/gateway/tools/invocations"
						className="text-sm font-medium text-blue-600 hover:underline"
					>
						{t('config.viewInvocations')}
					</Link>
				</div>
			</div>

			<div className="flex flex-col gap-6">
				<ConfigCardShell
					id="web-search"
					title={t('webSearch.title')}
					description={t('webSearch.descriptionCatalog')}
				>
					<div className="flex flex-col gap-4">
						<div className="flex flex-wrap items-end gap-3">
							<div>
								<div className="mb-1 flex items-center gap-2">
									<label className="block text-xs font-medium text-gray-600">{t('webSearch.active')}</label>
									<button
										type="button"
										onClick={() => setProviderGuideOpen(true)}
										className="text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline"
									>
										{t('webSearch.providerGuideLink')}
									</button>
								</div>
								<select
									value={webSearchActive}
									onChange={(e) => setWebSearchActive(e.target.value as WebSearchProvider)}
									className="min-w-[16rem] rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm"
								>
									{webSearchProviderOptions.map((o) => (
										<option key={o.value} value={o.value} disabled={!webSearchActivatable.includes(o.value)}>
											{o.label}
											{!webSearchActivatable.includes(o.value) ? ` (${t('webSearch.noKey')})` : ''}
										</option>
									))}
								</select>
								{webSearchActivatable.length === 0 && (
									<p className="mt-1 text-xs text-amber-700">{t('webSearch.needKeyToActivate')}</p>
								)}
							</div>
						</div>

						<div className="overflow-x-auto rounded-md border border-gray-200">
							{/* table-fixed + 统一 col 宽，与 Web fetch 表对齐 */}
							<table className="w-full min-w-[44rem] table-fixed text-left text-sm">
								<colgroup>
									<col className="w-[14rem]" />
									<col className="w-[15rem]" />
									<col />
								</colgroup>
								<thead className="bg-gray-50 text-xs font-medium text-gray-600">
									<tr>
										<th className="px-3 py-2">{t('webSearch.catalogProvider')}</th>
										<th className="px-3 py-2">
											<div>{t('unitPrices.title', { currency: billingCurrency })}</div>
											<div className="mt-0.5 font-normal text-[10px] text-gray-500">
												{t('unitPrices.legend')}
											</div>
										</th>
										<th className="px-3 py-2">{t('webSearch.apiKey')}</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-gray-100">
									{WEB_SEARCH_PROVIDERS.map((p) => (
										<tr
											key={p}
											className={
												isLossPricing(webSearchDrafts[p])
													? 'bg-amber-50/70'
													: p === webSearchActive
														? 'bg-blue-50/40'
														: undefined
											}
										>
											<td className="px-3 py-2 align-top">
												<div className="truncate font-medium text-gray-900" title={webSearchProviderOptions.find((o) => o.value === p)?.label ?? p}>
													{webSearchProviderOptions.find((o) => o.value === p)?.label ?? p}
												</div>
												<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
													<a
														href={WEB_SEARCH_PROVIDER_DOCS_URL[p]}
														target="_blank"
														rel="noopener noreferrer"
														className="text-xs font-medium text-blue-600 hover:underline"
													>
														{t('webSearch.providerDocs')}
													</a>
													<Link
														href={`/gateway/playground?mode=tools&tool=web-search&provider=${encodeURIComponent(p)}`}
														className="text-xs font-medium text-slate-700 hover:underline"
													>
														{t('config.testInPlayground')}
													</Link>
												</div>
											</td>
											<td className="px-3 py-2 align-top">
												<ToolPriceTripleInputs
													value={webSearchDrafts[p]}
													onChange={(patch) =>
														setWebSearchDrafts((prev) => ({
															...prev,
															[p]: { ...prev[p], ...patch },
														}))
													}
												/>
											</td>
											<td className="px-3 py-2 align-top">
												<input
													type={secretsVisible ? 'text' : 'password'}
													value={webSearchDrafts[p].apiKey}
													onChange={(e) =>
														setWebSearchDrafts((prev) => ({
															...prev,
															[p]: { ...prev[p], apiKey: e.target.value },
														}))
													}
													placeholder={t('webSearch.apiKeyPlaceholder')}
													autoComplete="off"
													spellCheck={false}
													className="w-full min-w-0 rounded-md border border-gray-300 bg-white px-2 py-1.5 font-mono text-sm text-gray-900 shadow-sm"
												/>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>

						<div className="flex flex-wrap items-center gap-3">
							<button
								type="button"
								onClick={() => void handleSaveWebSearch()}
								disabled={webSearchSaving || webSearchActivatable.length === 0}
								className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
							>
								{webSearchSaving ? tCommon('saving') : t('config.saveWebSearch')}
							</button>
							<CardSaveFeedback feedback={cardFeedback.webSearch} />
						</div>
					</div>
				</ConfigCardShell>

				<ConfigCardShell
					id="web-fetch"
					title={t('webFetch.title')}
					description={t('webFetch.descriptionCatalog')}
				>
					<div className="flex flex-col gap-4">
						<div>
							<label className="mb-1 block text-xs font-medium text-gray-600">{t('webFetch.active')}</label>
							<select
								value={webFetchActive}
								onChange={(e) => setWebFetchActive(e.target.value as WebFetchProvider)}
								className="min-w-[16rem] rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm"
							>
								{webFetchProviderOptions.map((o) => (
									<option key={o.value} value={o.value} disabled={!webFetchActivatable.includes(o.value)}>
										{o.label}
										{!webFetchActivatable.includes(o.value) ? ` (${t('webFetch.noKey')})` : ''}
									</option>
								))}
							</select>
							{webFetchActivatable.length === 0 && (
								<p className="mt-1 text-xs text-amber-700">{t('webFetch.needKeyToActivate')}</p>
							)}
						</div>

						<div className="overflow-x-auto rounded-md border border-gray-200">
							{/* 与 Web search 相同 col 宽，上下两表列对齐 */}
							<table className="w-full min-w-[44rem] table-fixed text-left text-sm">
								<colgroup>
									<col className="w-[14rem]" />
									<col className="w-[15rem]" />
									<col />
								</colgroup>
								<thead className="bg-gray-50 text-xs font-medium text-gray-600">
									<tr>
										<th className="px-3 py-2">{t('webFetch.catalogProvider')}</th>
										<th className="px-3 py-2">
											<div>{t('unitPrices.title', { currency: billingCurrency })}</div>
											<div className="mt-0.5 font-normal text-[10px] text-gray-500">
												{t('unitPrices.legend')}
											</div>
										</th>
										<th className="px-3 py-2">{t('webFetch.apiKey')}</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-gray-100">
									{WEB_FETCH_PROVIDERS.map((p) => (
										<tr
											key={p}
											className={
												isLossPricing(webFetchDrafts[p])
													? 'bg-amber-50/70'
													: p === webFetchActive
														? 'bg-blue-50/40'
														: undefined
											}
										>
											<td className="px-3 py-2 align-top">
												<div className="truncate font-medium text-gray-900" title={webFetchProviderOptions.find((o) => o.value === p)?.label ?? p}>
													{webFetchProviderOptions.find((o) => o.value === p)?.label ?? p}
												</div>
												<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
													<a
														href={WEB_FETCH_PROVIDER_DOCS_URL[p]}
														target="_blank"
														rel="noopener noreferrer"
														className="text-xs font-medium text-blue-600 hover:underline"
													>
														{t('webFetch.providerDocs')}
													</a>
													<Link
														href={`/gateway/playground?mode=tools&tool=web-fetch&provider=${encodeURIComponent(p)}`}
														className="text-xs font-medium text-slate-700 hover:underline"
													>
														{t('config.testInPlayground')}
													</Link>
												</div>
											</td>
											<td className="px-3 py-2 align-top">
												<ToolPriceTripleInputs
													value={webFetchDrafts[p]}
													onChange={(patch) =>
														setWebFetchDrafts((prev) => ({
															...prev,
															[p]: { ...prev[p], ...patch },
														}))
													}
												/>
											</td>
											<td className="px-3 py-2 align-top">
												<input
													type={secretsVisible ? 'text' : 'password'}
													value={webFetchDrafts[p].apiKey}
													onChange={(e) =>
														setWebFetchDrafts((prev) => ({
															...prev,
															[p]: { ...prev[p], apiKey: e.target.value },
														}))
													}
													placeholder={t('webFetch.apiKeyPlaceholder')}
													autoComplete="off"
													spellCheck={false}
													className="w-full min-w-0 rounded-md border border-gray-300 bg-white px-2 py-1.5 font-mono text-sm text-gray-900 shadow-sm"
												/>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>

						<div className="flex flex-wrap items-center gap-3">
							<button
								type="button"
								onClick={() => void handleSaveWebFetch()}
								disabled={webFetchSaving || webFetchActivatable.length === 0}
								className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
							>
								{webFetchSaving ? tCommon('saving') : t('config.saveWebFetch')}
							</button>
							<CardSaveFeedback feedback={cardFeedback.webFetch} />
						</div>
					</div>
				</ConfigCardShell>

				<ConfigCardShell
					id="web-deep-search"
					title={t('webDeepSearch.title')}
					description={t('webDeepSearch.descriptionCatalog')}
				>
					<div className="flex flex-col gap-4">
						<div>
							<label className="mb-1 block text-xs font-medium text-gray-600">
								{t('webDeepSearch.active')}
							</label>
							<select
								value={webDeepSearchActive}
								onChange={(e) => setWebDeepSearchActive(e.target.value as WebDeepSearchProvider)}
								className="min-w-[16rem] rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm"
							>
								{webDeepSearchProviderOptions.map((o) => (
									<option
										key={o.value}
										value={o.value}
										disabled={!webDeepSearchActivatable.includes(o.value)}
									>
										{o.label}
										{!webDeepSearchActivatable.includes(o.value)
											? ` (${t('webDeepSearch.noKey')})`
											: ''}
									</option>
								))}
							</select>
							{webDeepSearchActivatable.length === 0 && (
								<p className="mt-1 text-xs text-amber-700">{t('webDeepSearch.needKeyToActivate')}</p>
							)}
						</div>

						<div className="overflow-x-auto rounded-md border border-gray-200">
							<table className="w-full min-w-[44rem] table-fixed text-left text-sm">
								<colgroup>
									<col className="w-[14rem]" />
									<col className="w-[15rem]" />
									<col />
								</colgroup>
								<thead className="bg-gray-50 text-xs font-medium text-gray-600">
									<tr>
										<th className="px-3 py-2">{t('webDeepSearch.catalogProvider')}</th>
										<th className="px-3 py-2">
											<div>{t('unitPrices.title', { currency: billingCurrency })}</div>
											<div className="mt-0.5 font-normal text-[10px] text-gray-500">
												{t('unitPrices.legend')}
											</div>
										</th>
										<th className="px-3 py-2">{t('webDeepSearch.apiKey')}</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-gray-100">
									{WEB_DEEP_SEARCH_PROVIDERS.map((p) => (
										<tr
											key={p}
											className={
												isLossPricing(webDeepSearchDrafts[p])
													? 'bg-amber-50/70'
													: p === webDeepSearchActive
														? 'bg-blue-50/40'
														: undefined
											}
										>
											<td className="px-3 py-2 align-top">
												<div
													className="truncate font-medium text-gray-900"
													title={
														webDeepSearchProviderOptions.find((o) => o.value === p)?.label ?? p
													}
												>
													{webDeepSearchProviderOptions.find((o) => o.value === p)?.label ?? p}
												</div>
												<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
													<a
														href={WEB_DEEP_SEARCH_PROVIDER_DOCS_URL[p]}
														target="_blank"
														rel="noopener noreferrer"
														className="text-xs font-medium text-blue-600 hover:underline"
													>
														{t('webDeepSearch.providerDocs')}
													</a>
													<Link
														href={`/gateway/playground?mode=tools&tool=web-deep-search&provider=${encodeURIComponent(p)}`}
														className="text-xs font-medium text-slate-700 hover:underline"
													>
														{t('config.testInPlayground')}
													</Link>
												</div>
											</td>
											<td className="px-3 py-2 align-top">
												<ToolPriceTripleInputs
													value={webDeepSearchDrafts[p]}
													onChange={(patch) =>
														setWebDeepSearchDrafts((prev) => ({
															...prev,
															[p]: { ...prev[p], ...patch },
														}))
													}
												/>
											</td>
											<td className="px-3 py-2 align-top">
												<input
													type={secretsVisible ? 'text' : 'password'}
													value={webDeepSearchDrafts[p].apiKey}
													onChange={(e) =>
														setWebDeepSearchDrafts((prev) => ({
															...prev,
															[p]: { ...prev[p], apiKey: e.target.value },
														}))
													}
													placeholder={t('webDeepSearch.apiKeyPlaceholder')}
													autoComplete="off"
													spellCheck={false}
													className="w-full min-w-0 rounded-md border border-gray-300 bg-white px-2 py-1.5 font-mono text-sm text-gray-900 shadow-sm"
												/>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>

						<div className="flex flex-wrap items-center gap-3">
							<button
								type="button"
								onClick={() => void handleSaveWebDeepSearch()}
								disabled={webDeepSearchSaving || webDeepSearchActivatable.length === 0}
								className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
							>
								{webDeepSearchSaving ? tCommon('saving') : t('config.saveWebDeepSearch')}
							</button>
							<CardSaveFeedback feedback={cardFeedback.webDeepSearch} />
						</div>
					</div>
				</ConfigCardShell>

				<ConfigCardShell
					id="ai-detection"
					title={t('aiDetection.title')}
					description={t('aiDetection.descriptionCatalog')}
				>
					<div className="flex flex-col gap-4">
						<div>
							<label className="mb-1 block text-xs font-medium text-gray-600">
								{t('aiDetection.active')}
							</label>
							<select
								value={aiDetectionActive}
								onChange={(e) => setAiDetectionActive(e.target.value as AiDetectionProvider)}
								className="min-w-[16rem] rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm"
							>
								{aiDetectionProviderOptions.map((o) => {
									const canActivate = aiDetectionActivatable.includes(o.value);
									const disabled = !o.implemented || !canActivate;
									return (
										<option key={o.value} value={o.value} disabled={disabled}>
											{o.label}
											{!canActivate ? ` (${t('aiDetection.noKey')})` : ''}
										</option>
									);
								})}
							</select>
							{aiDetectionActivatable.length === 0 && (
								<p className="mt-1 text-xs text-amber-700">{t('aiDetection.needKeyToActivate')}</p>
							)}
						</div>

						<div className="overflow-x-auto rounded-md border border-gray-200">
							<table className="w-full min-w-[52rem] table-fixed text-left text-sm">
								<colgroup>
									<col className="w-[12rem]" />
									<col className="w-[15rem]" />
									<col className="w-[7rem]" />
									<col />
								</colgroup>
								<thead className="bg-gray-50 text-xs font-medium text-gray-600">
									<tr>
										<th className="px-3 py-2">{t('aiDetection.catalogProvider')}</th>
										<th className="px-3 py-2">
											<div>{t('unitPrices.title', { currency: billingCurrency })}</div>
											<div className="mt-0.5 font-normal text-[10px] text-gray-500">
												{t('unitPrices.legend')}
											</div>
										</th>
										<th className="px-3 py-2">{t('aiDetection.billingUnitChars')}</th>
										<th className="px-3 py-2">{t('aiDetection.credentials')}</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-gray-100">
									{AI_DETECTION_PROVIDERS.map((p) => {
										const fields = getAiDetectionCredentialFields(p);
										const draft = aiDetectionDrafts[p];
										return (
											<tr
												key={p}
												className={
													isLossPricing(draft)
														? 'bg-amber-50/70'
														: p === aiDetectionActive
															? 'bg-blue-50/40'
															: undefined
												}
											>
												<td className="px-3 py-2 align-top">
													<div
														className="truncate font-medium text-gray-900"
														title={
															aiDetectionProviderOptions.find((o) => o.value === p)?.label ?? p
														}
													>
														{aiDetectionProviderOptions.find((o) => o.value === p)?.label ?? p}
													</div>
													<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
														<a
															href={AI_DETECTION_PROVIDER_DOCS_URL[p]}
															target="_blank"
															rel="noopener noreferrer"
															className="text-xs font-medium text-blue-600 hover:underline"
														>
															{t('aiDetection.providerDocs')}
														</a>
														{isAiDetectionImplementedProvider(p) ? (
															<Link
																href={`/gateway/playground?mode=tools&tool=ai-detection&provider=${encodeURIComponent(p)}`}
																className="text-xs font-medium text-slate-700 hover:underline"
															>
																{t('config.testInPlayground')}
															</Link>
														) : null}
													</div>
												</td>
												<td className="px-3 py-2 align-top">
													<ToolPriceTripleInputs
														value={draft}
														onChange={(patch) =>
															setAiDetectionDrafts((prev) => ({
																...prev,
																[p]: { ...prev[p], ...patch },
															}))
														}
													/>
												</td>
												<td className="px-3 py-2 align-top">
													<input
														type="number"
														min={1}
														step={1}
														value={draft.billingUnitChars}
														onChange={(e) =>
															setAiDetectionDrafts((prev) => ({
																...prev,
																[p]: { ...prev[p], billingUnitChars: e.target.value },
															}))
														}
														className="w-full max-w-[6rem] rounded-md border border-gray-300 px-2 py-1.5 font-mono text-sm shadow-sm"
													/>
												</td>
												<td className="px-3 py-2 align-top">
													<div className="flex flex-col gap-2">
														{fields.map((field) => (
															<div key={field} className="flex min-w-0 items-center gap-2">
																<span className="w-20 shrink-0 text-xs text-gray-500">
																	{t(AI_DETECTION_FIELD_I18N[field])}
																</span>
																<input
																	type={
																		field === 'email'
																			? 'email'
																			: secretsVisible
																				? 'text'
																				: 'password'
																	}
																	value={draft[field]}
																	onChange={(e) =>
																		setAiDetectionDrafts((prev) => ({
																			...prev,
																			[p]: { ...prev[p], [field]: e.target.value },
																		}))
																	}
																	placeholder={t(AI_DETECTION_FIELD_I18N[field])}
																	autoComplete="off"
																	spellCheck={false}
																	className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1.5 font-mono text-sm text-gray-900 shadow-sm"
																/>
															</div>
														))}
														{p === 'tencent_tms' && (
															<>
																<div className="flex min-w-0 items-center gap-2">
																	<span className="w-20 shrink-0 text-xs text-gray-500">
																		{t('aiDetection.fields.region')}
																	</span>
																	<input
																		type="text"
																		value={draft.region}
																		onChange={(e) =>
																			setAiDetectionDrafts((prev) => ({
																				...prev,
																				[p]: { ...prev[p], region: e.target.value },
																			}))
																		}
																		placeholder={t('aiDetection.fields.region')}
																		autoComplete="off"
																		spellCheck={false}
																		className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1.5 font-mono text-sm text-gray-900 shadow-sm"
																	/>
																</div>
																<div className="flex min-w-0 items-center gap-2">
																	<span className="w-20 shrink-0 text-xs text-gray-500">
																		{t('aiDetection.fields.bizType')}
																	</span>
																	<input
																		type="text"
																		value={draft.bizType}
																		onChange={(e) =>
																			setAiDetectionDrafts((prev) => ({
																				...prev,
																				[p]: { ...prev[p], bizType: e.target.value },
																			}))
																		}
																		placeholder={t('aiDetection.fields.bizTypeOptional')}
																		autoComplete="off"
																		spellCheck={false}
																		className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1.5 font-mono text-sm text-gray-900 shadow-sm"
																	/>
																</div>
															</>
														)}
													</div>
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>

						<div className="flex flex-wrap items-center gap-3">
							<button
								type="button"
								onClick={() => void handleSaveAiDetection()}
								disabled={aiDetectionSaving || aiDetectionActivatable.length === 0}
								className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
							>
								{aiDetectionSaving ? tCommon('saving') : t('config.saveAiDetection')}
							</button>
							<CardSaveFeedback feedback={cardFeedback.aiDetection} />
						</div>
					</div>
				</ConfigCardShell>
			</div>

			<WebSearchProviderGuideModal
				open={providerGuideOpen}
				activeProvider={webSearchActive}
				onClose={() => setProviderGuideOpen(false)}
			/>
		</div>
	);
}
