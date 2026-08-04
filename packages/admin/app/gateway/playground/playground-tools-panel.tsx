'use client';

/**
 * Playground Tools：工具 + 引擎两级下拉，直连 catalog 引擎（不计费、不写 logs）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PaperAirplaneIcon } from '@heroicons/react/24/outline';
import { GATEWAY_TOOLS } from '@/lib/gateway-tools';
import { parseGatewayToolId, type GatewayToolId } from '@/lib/invoke-kind';
import {
	AI_DETECTION_IMPLEMENTED_PROVIDERS,
} from '@/lib/ai-detection-options';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search-options';
import { WEB_FETCH_PROVIDERS } from '@/lib/web-fetch-options';
import { WEB_DEEP_SEARCH_PROVIDERS } from '@/lib/web-deep-search-options';
import {
	TOOL_BODY_TEMPLATES,
	bodyTemplateForTool,
} from '../simulator/simulator-utils';

const inputClass =
	'w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white';
const labelClass = 'block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1';
const codeBlockClass =
	'p-3 text-xs overflow-x-auto whitespace-pre-wrap bg-gray-50 border border-gray-200 rounded-md font-mono text-gray-900';

function providersForTool(toolId: GatewayToolId): readonly string[] {
	switch (toolId) {
		case 'web-search':
			return WEB_SEARCH_PROVIDERS;
		case 'web-fetch':
			return WEB_FETCH_PROVIDERS;
		case 'web-deep-search':
			return WEB_DEEP_SEARCH_PROVIDERS;
		case 'ai-detection':
			return AI_DETECTION_IMPLEMENTED_PROVIDERS;
		default:
			return [];
	}
}

type Props = {
	/** Deep-link from Tools config Test button */
	initialToolId?: string | null;
	initialProvider?: string | null;
};

export function PlaygroundToolsPanel({ initialToolId, initialProvider }: Props) {
	const t = useTranslations('playground');
	const tTools = useTranslations('tools.catalog');
	const tCommon = useTranslations('common');

	const initialTool = parseGatewayToolId(initialToolId) ?? 'ai-detection';
	const [toolId, setToolId] = useState<GatewayToolId>(initialTool);
	const providers = useMemo(() => providersForTool(toolId), [toolId]);
	const [provider, setProvider] = useState(() => {
		const p = initialProvider?.trim() ?? '';
		if (p && (providersForTool(initialTool) as readonly string[]).includes(p)) return p;
		return providersForTool(initialTool)[0] ?? '';
	});
	const [bodyText, setBodyText] = useState(() => bodyTemplateForTool(initialTool));
	const [bodyError, setBodyError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const [responseMeta, setResponseMeta] = useState<{
		status: number;
		latencyMs: string | null;
		upstreamUrl: string | null;
	} | null>(null);
	const [responseText, setResponseText] = useState('');
	const [wireBody, setWireBody] = useState<string | null>(null);

	useEffect(() => {
		const nextProviders = providersForTool(toolId);
		if (!nextProviders.includes(provider)) {
			setProvider(nextProviders[0] ?? '');
		}
	}, [toolId, provider]);

	const onToolChange = useCallback((next: string) => {
		const parsed = parseGatewayToolId(next);
		if (!parsed) return;
		setToolId(parsed);
		setBodyText(TOOL_BODY_TEMPLATES[parsed] ?? bodyTemplateForTool(parsed));
		setBodyError(null);
		const nextProviders = providersForTool(parsed);
		setProvider(nextProviders[0] ?? '');
	}, []);

	const send = useCallback(async () => {
		setBodyError(null);
		let body: Record<string, unknown>;
		try {
			body = JSON.parse(bodyText) as Record<string, unknown>;
			if (body === null || typeof body !== 'object' || Array.isArray(body)) {
				setBodyError(t('toolsBodyMustBeObject'));
				return;
			}
		} catch {
			setBodyError(tCommon('invalidJson'));
			return;
		}
		if (!provider) {
			setBodyError(t('toolsNeedProvider'));
			return;
		}

		setSending(true);
		setResponseText('');
		setResponseMeta(null);
		setWireBody(null);
		try {
			const res = await fetch('/api/admin/playground', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ toolId, provider, body }),
			});
			const latency = res.headers.get('x-playground-latency-ms');
			const upstream = res.headers.get('x-playground-upstream-url');
			const wireRaw = res.headers.get('x-playground-request-body');
			if (wireRaw) {
				try {
					setWireBody(JSON.stringify(JSON.parse(decodeURIComponent(wireRaw)), null, 2));
				} catch {
					setWireBody(decodeURIComponent(wireRaw));
				}
			}
			const text = await res.text();
			setResponseMeta({
				status: res.status,
				latencyMs: latency,
				upstreamUrl: upstream,
			});
			try {
				setResponseText(JSON.stringify(JSON.parse(text), null, 2));
			} catch {
				setResponseText(text);
			}
			if (!res.ok) {
				setBodyError(text.slice(0, 400) || `HTTP ${res.status}`);
			}
		} catch (e) {
			setBodyError(e instanceof Error ? e.message : tCommon('requestFailed'));
		} finally {
			setSending(false);
		}
	}, [bodyText, provider, toolId, t, tCommon]);

	return (
		<div className="space-y-4">
			<section className="rounded-xl border border-gray-200/80 bg-white p-4 shadow-sm space-y-3">
				<h2 className="text-sm font-semibold text-gray-900">{t('toolsSection')}</h2>
				<p className="text-xs text-gray-500">{t('toolsHint')}</p>
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
					<div>
						<label className={labelClass}>{t('tool')}</label>
						<select
							value={toolId}
							onChange={(e) => onToolChange(e.target.value)}
							className={`${inputClass} font-mono`}
						>
							{GATEWAY_TOOLS.map((tool) => (
								<option key={tool.id} value={tool.id}>
									{tTools(tool.nameKey)} ({tool.id})
								</option>
							))}
						</select>
					</div>
					<div>
						<label className={labelClass}>{t('engineProvider')}</label>
						<select
							value={provider}
							onChange={(e) => setProvider(e.target.value)}
							className={`${inputClass} font-mono`}
						>
							{providers.map((p) => (
								<option key={p} value={p}>
									{p}
								</option>
							))}
						</select>
						<p className="mt-1 text-xs text-gray-500">{t('engineProviderHint')}</p>
					</div>
				</div>
			</section>

			<section className="rounded-xl border border-gray-200/80 bg-white p-4 shadow-sm space-y-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h2 className="text-sm font-semibold text-gray-900">{t('requestBody')}</h2>
					<button
						type="button"
						onClick={() => {
							setBodyText(bodyTemplateForTool(toolId));
							setBodyError(null);
						}}
						className="text-xs text-blue-700 hover:underline"
					>
						{t('applyTemplate')}
					</button>
				</div>
				<textarea
					value={bodyText}
					onChange={(e) => setBodyText(e.target.value)}
					rows={10}
					className={`${inputClass} font-mono text-xs`}
					spellCheck={false}
				/>
				{bodyError ? (
					<div className="p-2.5 rounded-md bg-red-50 border border-red-200 text-sm text-red-700 whitespace-pre-wrap">
						{bodyError}
					</div>
				) : null}
				<button
					type="button"
					disabled={sending}
					onClick={() => void send()}
					className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
				>
					<PaperAirplaneIcon className="h-4 w-4" />
					{sending ? tCommon('sending') : tCommon('send')}
				</button>
			</section>

			<section className="rounded-xl border border-gray-200/80 bg-white p-4 shadow-sm space-y-3">
				<h2 className="text-sm font-semibold text-gray-900">{t('response')}</h2>
				{responseMeta ? (
					<div className="flex flex-wrap gap-2 text-xs">
						<span className="rounded-full bg-gray-100 px-2.5 py-1 font-medium">
							HTTP {responseMeta.status}
						</span>
						{responseMeta.latencyMs ? (
							<span className="rounded-full bg-gray-100 px-2.5 py-1 font-medium">
								{responseMeta.latencyMs} ms
							</span>
						) : null}
						{responseMeta.upstreamUrl ? (
							<span className="rounded-full bg-gray-100 px-2.5 py-1 font-mono max-w-full truncate">
								{responseMeta.upstreamUrl}
							</span>
						) : null}
					</div>
				) : (
					<p className="text-sm text-gray-500">{t('emptyResponseHint')}</p>
				)}
				{wireBody ? (
					<details className="text-xs">
						<summary className="cursor-pointer text-gray-600">{t('sentBody')}</summary>
						<pre className={`${codeBlockClass} mt-2`}>{wireBody}</pre>
					</details>
				) : null}
				{responseText ? <pre className={codeBlockClass}>{responseText}</pre> : null}
			</section>
		</div>
	);
}
