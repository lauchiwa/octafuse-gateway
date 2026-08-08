'use client';

/**
 * 上游供应商：CRUD、各协议 base URL 与单键 API Key；对应 Worker `/admin/providers`。
 */
import { ArrowDownTrayIcon, PlusIcon } from '@heroicons/react/24/outline';
import { useTranslations } from 'next-intl';
import { ProviderCard } from './components/provider-card';
import { ProviderImportModal } from './components/provider-import-modal';
import { ProviderModal } from './components/provider-modal';
import { ProviderToolbar } from './components/provider-toolbar';
import { useProvidersPageState } from './use-providers-page-state';

export default function GatewayProvidersPage() {
	const t = useTranslations('providers');
	const tBrand = useTranslations('brand');
	const tCommon = useTranslations('common');
	const state = useProvidersPageState();

	if (state.isLoading) {
		return (
			<div className="flex items-center justify-center h-full">
				<div className="text-gray-600">{tCommon('loading')}</div>
			</div>
		);
	}

	return (
		<div className="p-8">
			<div className="flex justify-between items-center mb-6">
				<div>
					<h1 className="text-3xl font-bold text-gray-900">{t('title')}</h1>
					<p className="text-sm text-gray-500 mt-1">
						{t('subtitle', { product: tBrand('product') })}
					</p>
					<p className="text-xs text-gray-400 mt-1">{t('importHint')}</p>
				</div>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={state.openImportModal}
						className="flex items-center gap-2 px-4 py-2 border border-gray-300 bg-white text-gray-800 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
					>
						<ArrowDownTrayIcon className="h-5 w-5" />
						{tCommon('import')}
					</button>
					<button
						type="button"
						onClick={state.handleCreate}
						className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
					>
						<PlusIcon className="h-5 w-5" />
						{tCommon('new')}
					</button>
				</div>
			</div>

			<ProviderToolbar
				providerSearch={state.providerSearch}
				filteredCount={state.filteredProviders.length}
				totalCount={state.providers.length}
				onSearchChange={state.setProviderSearch}
			/>

			{state.filteredProviders.length === 0 ? (
				<div className="rounded-lg border border-gray-200 bg-white py-12 text-center text-gray-500 shadow-sm">
					{state.providerSearch.trim() ? t('emptySearch') : t('empty')}
				</div>
			) : (
				<section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
					<div className="hidden grid-cols-[auto_minmax(210px,0.9fr)_minmax(340px,1.7fr)_minmax(180px,0.72fr)] items-center gap-5 border-b border-slate-200 bg-slate-50/80 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 lg:grid">
						<span>{tCommon('status')}</span>
						<span>{tCommon('provider')}</span>
						<span>{t('card.supportedEndpoints')}</span>
						<span>{t('card.apiKey')}</span>
					</div>
					<div className="divide-y divide-slate-200">
						{state.filteredProviders.map((provider) => (
							<ProviderCard
								key={provider.id}
								provider={provider}
								copiedId={state.copiedId}
								statusTogglingId={state.statusTogglingId}
								onEdit={state.handleEdit}
								onToggleStatus={state.handleToggleStatus}
								onCopyApiKey={state.handleCopyApiKey}
							/>
						))}
					</div>
				</section>
			)}

			<ProviderImportModal
				open={state.showImportModal}
				catalogRows={state.importCatalogRows}
				filteredCatalogRows={state.filteredImportCatalogRows}
				catalogSearch={state.importCatalogSearch}
				catalogLoading={state.importCatalogLoading}
				catalogError={state.importCatalogError}
				selected={state.importSelected}
				selectedCount={state.importSelectedCount}
				submitting={state.importSubmitting}
				onClose={() => state.setShowImportModal(false)}
				onCatalogSearchChange={state.setImportCatalogSearch}
				onSelectAll={state.selectAllImportPresets}
				onClearSelection={state.clearImportPresetSelection}
				onTogglePreset={state.toggleImportPreset}
				onImport={state.runImportSelectedPresets}
			/>

			<ProviderModal
				open={state.showModal}
				editingProvider={state.editingProvider}
				duplicateSourceId={state.duplicateSourceId}
				formData={state.formData}
				saveError={state.saveError}
				isSaving={state.isSaving}
				isDeleting={state.isDeleting}
				onClose={state.closeProviderModal}
				onFormChange={state.setFormData}
				onSave={state.handleSave}
				onDelete={state.handleDelete}
				onDuplicate={state.handleDuplicate}
			/>
		</div>
	);
}
