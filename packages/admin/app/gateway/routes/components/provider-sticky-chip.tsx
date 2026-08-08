'use client';

import { formatStickyIdleTtlShort } from '@octafuse/core/db/route-pool-sticky-types';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { fetchStickyBindingsSummary } from '../route-api';

type Props = {
	enabled: boolean;
	idleTtlSeconds: number;
	poolId?: string | null;
	disabled?: boolean;
	onClick: () => void;
};

export function ProviderStickyChip(props: Props) {
	const { enabled, idleTtlSeconds, poolId, disabled, onClick } = props;
	const t = useTranslations('routes.providerSticky');
	const ttl = formatStickyIdleTtlShort(idleTtlSeconds);
	const [activeCount, setActiveCount] = useState<number | null>(null);

	useEffect(() => {
		if (!enabled || !poolId) {
			setActiveCount(null);
			return;
		}
		let cancelled = false;
		void fetchStickyBindingsSummary(poolId).then((result) => {
			if (cancelled) return;
			if (result.success) setActiveCount(result.data.total_active);
			else setActiveCount(null);
		});
		return () => {
			cancelled = true;
		};
	}, [enabled, poolId]);

	const label =
		enabled && activeCount != null
			? t('chipOnWithCount', { ttl, count: activeCount })
			: enabled
				? t('chipOn', { ttl })
				: t('chipOff');

	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={t('tooltip')}
			className={
				enabled
					? 'inline-flex max-w-full items-center rounded-md bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 shadow-sm ring-1 ring-inset ring-emerald-300 transition hover:bg-emerald-200/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50'
					: 'inline-flex max-w-full items-center rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500 shadow-sm ring-1 ring-inset ring-slate-300 transition hover:bg-slate-200/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50'
			}
		>
			<span className="truncate">{label}</span>
		</button>
	);
}
