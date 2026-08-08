'use client';

import {
	CheckIcon,
	ClipboardDocumentIcon,
	ExclamationTriangleIcon,
	PowerIcon,
} from '@heroicons/react/24/outline';
import { useTranslations } from 'next-intl';
import { VendorIcon } from '@/components/model-vendor-icon';
import type { GatewayProvider } from '../types';
import { getProviderProtocolSummaries } from '../provider-utils';
import { ProviderProtocolIcon } from './provider-protocol-icon';

type ProviderCardProps = {
	provider: GatewayProvider;
	copiedId: string | null;
	statusTogglingId: string | null;
	onEdit: (provider: GatewayProvider) => void;
	onToggleStatus: (provider: GatewayProvider) => void;
	onCopyApiKey: (provider: GatewayProvider) => void;
};

export function ProviderCard(props: ProviderCardProps) {
	const {
		provider,
		copiedId,
		statusTogglingId,
		onEdit,
		onToggleStatus,
		onCopyApiKey,
	} = props;

	const t = useTranslations('providers.card');
	const tCommon = useTranslations('common');

	const protocols = getProviderProtocolSummaries(provider);
	const pendingKey = Boolean(provider.has_pending_key);
	const isActive = provider.status !== 'disabled';
	const maskedKey = provider.api_key?.trim() || '';
	const noKey = !maskedKey || maskedKey === '(empty)' || pendingKey;
	const apiKeyFeedbackId = `provider-api-key:${provider.id}`;

	return (
		<article
			className="group relative grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-3 px-4 py-3 lg:h-[72px] lg:grid-cols-[auto_minmax(210px,0.9fr)_minmax(340px,1.7fr)_minmax(180px,0.72fr)] lg:items-center lg:gap-5"
		>
			<button
				type="button"
				onClick={() => onEdit(provider)}
				className="absolute inset-0 z-0 cursor-pointer bg-transparent transition-colors group-hover:bg-slate-50/80 focus-visible:bg-blue-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
				title={t('editProvider', { name: provider.name })}
				aria-label={t('editProvider', { name: provider.name })}
			/>
			<div className="pointer-events-none relative z-10 col-start-1 row-start-1 flex items-center">
				<button
					type="button"
					role="switch"
					aria-checked={isActive}
					disabled={statusTogglingId === provider.id}
					onClick={() => void onToggleStatus(provider)}
					className={`pointer-events-auto inline-flex h-8 w-8 items-center justify-center rounded-lg ring-1 ring-inset transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-wait disabled:opacity-50 ${
						isActive
							? 'bg-emerald-50 text-emerald-700 ring-emerald-200 hover:bg-emerald-100'
							: 'bg-red-50 text-red-600 ring-red-200 hover:bg-red-100'
					}`}
					title={isActive ? t('providerEnabled') : t('providerDisabled')}
					aria-label={isActive ? t('providerEnabled') : t('providerDisabled')}
				>
					<PowerIcon className="h-4 w-4" aria-hidden />
				</button>
			</div>

			<div className="pointer-events-none relative z-10 col-start-2 row-start-1 flex min-w-0 items-start gap-3">
				<VendorIcon vendor={provider.vendor_key} iconKey={provider.icon_key} size="compact" />
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-1.5">
						<h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900" title={provider.name}>
							{provider.name}
						</h2>
						{pendingKey ? (
							<span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
								<ExclamationTriangleIcon className="h-3 w-3" aria-hidden />
								{t('pending')}
							</span>
						) : null}
						{isActive && noKey && !pendingKey ? (
							<span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700 ring-1 ring-inset ring-red-200">
								<ExclamationTriangleIcon className="h-3 w-3" aria-hidden />
								{t('noKey')}
							</span>
						) : null}
					</div>
					<p className="mt-0.5 truncate font-mono text-[10px] text-gray-500" title={provider.id}>
						{provider.id}
					</p>
				</div>
			</div>

			<div className="pointer-events-none relative z-10 col-span-2 row-start-2 min-w-0 lg:col-span-1 lg:col-start-3 lg:row-start-1">
				<p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 lg:hidden">
					{t('supportedEndpoints')}
				</p>
				{protocols.length > 0 ? (
					<div className="grid h-8 min-w-0 grid-flow-col auto-cols-fr gap-1.5 overflow-hidden">
						{protocols.map((protocol) => {
							const badgeLabels = protocol.badges.map((badge) => t(`cap.${badge}`));
							const capabilitySummary =
								badgeLabels.length > 0
									? badgeLabels.join(' / ')
									: t('endpointCount', { count: protocol.endpoints.length });

							return (
								<span
									key={protocol.key}
									className="inline-flex min-w-0 items-center gap-1.5 overflow-hidden rounded-lg border border-slate-200 bg-white px-2 text-slate-600"
									title={`${protocol.label} · ${capabilitySummary}`}
								>
									<span className="h-4 w-4 shrink-0">
										<ProviderProtocolIcon protocol={protocol.key} />
									</span>
									<span className="min-w-0 truncate text-[10px] font-medium">
										<span className="font-semibold text-slate-800">{protocol.label}</span>
										<span className="text-slate-400"> · </span>
										{capabilitySummary}
									</span>
								</span>
							);
						})}
					</div>
				) : (
					<div className="flex h-8 items-center rounded-lg border border-dashed border-gray-200 bg-white px-3 text-xs text-gray-400">
						{t('noEndpoint')}
					</div>
				)}
			</div>

			<div className="pointer-events-none relative z-10 col-span-2 row-start-3 min-w-0 lg:col-span-1 lg:col-start-4 lg:row-start-1">
				<p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 lg:hidden">
					{t('apiKey')}
				</p>
				<div
					className={`flex h-8 min-w-0 items-center gap-2 rounded-lg border px-2.5 ${
						pendingKey
							? 'border-amber-200 bg-amber-50/60'
							: noKey
								? 'border-red-200 bg-red-50/50'
								: 'border-slate-200 bg-white'
					}`}
				>
					<p className="min-w-0 flex-1 truncate font-mono text-[11px] text-gray-700" title={maskedKey || t('noKey')}>
						{maskedKey || t('noKey')}
					</p>
					<button
						type="button"
						onClick={() => void onCopyApiKey(provider)}
						disabled={noKey}
						className="pointer-events-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-slate-100 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-35"
						title={copiedId === apiKeyFeedbackId ? tCommon('copied') : t('copyApiKey')}
						aria-label={copiedId === apiKeyFeedbackId ? tCommon('copied') : t('copyApiKey')}
					>
						{copiedId === apiKeyFeedbackId ? (
							<CheckIcon className="h-4 w-4 text-emerald-600" aria-hidden />
						) : (
							<ClipboardDocumentIcon className="h-4 w-4" aria-hidden />
						)}
					</button>
				</div>
			</div>
		</article>
	);
}
