'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
	deleteProvider,
	fetchImportCatalog,
	fetchProviderApiKeyPlaintext,
	fetchProvidersList,
	importProviderPresets,
	saveProvider,
	toggleProviderStatus,
} from './provider-api';
import {
	getProviderProtocolSummaries,
	providerToFormData,
	suggestDuplicateProviderId,
} from './provider-utils';
import type { GatewayProvider, ProviderFormData, ProviderImportCatalogRow } from './types';
import { EMPTY_PROTOCOL_FORM, EMPTY_PROVIDER_FORM } from './types';

export function useProvidersPageState() {
	const [providers, setProviders] = useState<GatewayProvider[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [providerSearch, setProviderSearch] = useState('');
	const [showModal, setShowModal] = useState(false);
	const [editingProvider, setEditingProvider] = useState<GatewayProvider | null>(null);
	const [duplicateSourceId, setDuplicateSourceId] = useState<string | null>(null);
	const [formData, setFormData] = useState<ProviderFormData>(EMPTY_PROVIDER_FORM);
	const [saveError, setSaveError] = useState('');
	const [isSaving, setIsSaving] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [showImportModal, setShowImportModal] = useState(false);
	const [importCatalogRows, setImportCatalogRows] = useState<ProviderImportCatalogRow[]>([]);
	const [importCatalogSearch, setImportCatalogSearch] = useState('');
	const [importCatalogLoading, setImportCatalogLoading] = useState(false);
	const [importCatalogError, setImportCatalogError] = useState('');
	const [importSelected, setImportSelected] = useState<Record<string, boolean>>({});
	const [importSubmitting, setImportSubmitting] = useState(false);
	const [statusTogglingId, setStatusTogglingId] = useState<string | null>(null);

	const existingProviderIds = useMemo(() => new Set(providers.map((p) => p.id)), [providers]);
	const filteredProviders = useMemo(() => {
		const query = providerSearch.trim().toLowerCase();
		if (!query) return providers;
		return providers.filter((provider) => {
			const endpointSearch = getProviderProtocolSummaries(provider)
				.flatMap((protocol) => [
					protocol.label,
					protocol.baseUrl ?? '',
					...protocol.capabilities,
					...protocol.endpoints.map((endpoint) => endpoint.url),
				])
				.join(' ');
			return [
				provider.name,
				provider.id,
				provider.description ?? '',
				provider.status ?? '',
				endpointSearch,
			]
				.join(' ')
				.toLowerCase()
				.includes(query);
		});
	}, [providerSearch, providers]);
	const importSelectedCount = useMemo(
		() => Object.values(importSelected).filter(Boolean).length,
		[importSelected]
	);
	const filteredImportCatalogRows = useMemo(() => {
		const query = importCatalogSearch.trim().toLowerCase();
		if (!query) return importCatalogRows;
		return importCatalogRows.filter((row) => row.name.toLowerCase().includes(query));
	}, [importCatalogSearch, importCatalogRows]);

	const refreshProviders = useCallback(async () => {
		try {
			const rows = await fetchProvidersList();
			setProviders(rows);
		} catch (error) {
			console.error('Fetch providers error:', error);
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		void refreshProviders();
	}, [refreshProviders]);

	const handleCopyApiKey = useCallback(
		async (provider: GatewayProvider) => {
			try {
				const apiKey = await fetchProviderApiKeyPlaintext(provider.id);
				await navigator.clipboard.writeText(apiKey);
				setCopiedId(`provider-api-key:${provider.id}`);
				setTimeout(() => setCopiedId(null), 2000);
			} catch (error) {
				console.error('Copy provider API key error:', error);
				alert(error instanceof Error ? error.message : 'Failed to copy API key');
			}
		},
		[]
	);

	const handleToggleStatus = useCallback(
		async (provider: GatewayProvider) => {
			const nextStatus = provider.status === 'disabled' ? 'active' : 'disabled';
			setStatusTogglingId(provider.id);
			try {
				const result = await toggleProviderStatus(provider.id, nextStatus);
				if (result.success) {
					void refreshProviders();
				} else {
					alert(result.message);
				}
			} catch (error) {
				console.error('Toggle provider status error:', error);
				alert('Update failed');
			} finally {
				setStatusTogglingId(null);
			}
		},
		[refreshProviders]
	);

	const handleCreate = useCallback(() => {
		setEditingProvider(null);
		setDuplicateSourceId(null);
		setFormData({
			...EMPTY_PROVIDER_FORM,
			id: '',
			api_key: '',
			status: 'active',
			openai: { ...EMPTY_PROTOCOL_FORM },
			anthropic: { ...EMPTY_PROTOCOL_FORM },
			gemini: { ...EMPTY_PROTOCOL_FORM },
		});
		setShowModal(true);
		setSaveError('');
	}, []);

	const handleEdit = useCallback((provider: GatewayProvider) => {
		setEditingProvider(provider);
		setDuplicateSourceId(null);
		setFormData({
			id: provider.id,
			name: provider.name,
			...providerToFormData(provider),
			description: provider.description ?? '',
		});
		setShowModal(true);
		setSaveError('');
	}, []);

	const handleDuplicate = useCallback(
		(provider: GatewayProvider) => {
			setEditingProvider(null);
			setDuplicateSourceId(provider.id);
			setFormData({
				id: suggestDuplicateProviderId(provider.id, existingProviderIds),
				name: `${provider.name} (copy)`,
				...providerToFormData(provider),
				api_key: '',
				status: provider.status === 'disabled' ? 'disabled' : 'active',
				description: provider.description ?? '',
			});
			setShowModal(true);
			setSaveError('');
		},
		[existingProviderIds]
	);

	const handleDelete = useCallback(
		async (id: string) => {
			if (!confirm('Are you sure you want to delete this provider?')) return;

			setIsDeleting(true);
			try {
				const result = await deleteProvider(id);
				if (result.success) {
					setShowModal(false);
					setEditingProvider(null);
					void refreshProviders();
				} else {
					alert(result.message);
				}
			} catch (error) {
				console.error('Delete error:', error);
				alert('Delete failed');
			} finally {
				setIsDeleting(false);
			}
		},
		[refreshProviders]
	);

	const loadImportCatalog = useCallback(async () => {
		setImportCatalogLoading(true);
		setImportCatalogError('');
		try {
			const rows = await fetchImportCatalog();
			setImportCatalogRows(rows);
			setImportSelected({});
		} catch (error) {
			console.error('Load provider import catalog error:', error);
			setImportCatalogError(error instanceof Error ? error.message : 'Failed to load catalog');
			setImportCatalogRows([]);
		} finally {
			setImportCatalogLoading(false);
		}
	}, []);

	const openImportModal = useCallback(() => {
		setShowImportModal(true);
		setImportCatalogError('');
		setImportCatalogSearch('');
		setImportSelected({});
		void loadImportCatalog();
	}, [loadImportCatalog]);

	const toggleImportPreset = useCallback((id: string) => {
		setImportSelected((prev) => ({ ...prev, [id]: !prev[id] }));
	}, []);

	const selectAllImportPresets = useCallback(() => {
		setImportSelected((prev) => {
			const next = { ...prev };
			for (const row of filteredImportCatalogRows) {
				next[row.id] = true;
			}
			return next;
		});
	}, [filteredImportCatalogRows]);

	const clearImportPresetSelection = useCallback(() => {
		setImportSelected({});
	}, []);

	const runImportSelectedPresets = useCallback(async () => {
		const ids = Object.entries(importSelected)
			.filter(([, v]) => v)
			.map(([k]) => k);
		if (ids.length === 0) {
			alert('Select at least one template.');
			return;
		}
		setImportSubmitting(true);
		try {
			const result = await importProviderPresets(ids);
			if (result.success) {
				const { created, failed } = result.data;
				const failLines =
					failed.length > 0
						? `\nFailed:\n${failed.map((f) => `  ${f.id}: ${f.message}`).join('\n')}`
						: '';
				alert(`Import finished.\nCreated: ${created}${failLines}`);
				setShowImportModal(false);
				void refreshProviders();
			} else {
				alert(result.message);
			}
		} catch (error) {
			console.error('Import providers error:', error);
			alert('Import failed');
		} finally {
			setImportSubmitting(false);
		}
	}, [importSelected, refreshProviders]);

	const handleSave = useCallback(async () => {
		if (!editingProvider && !formData.api_key.trim()) {
			setSaveError('API key is required');
			return;
		}
		setSaveError('');
		setIsSaving(true);
		try {
			const result = await saveProvider(formData, editingProvider?.id ?? null);
			if (result.success) {
				setShowModal(false);
				void refreshProviders();
			} else {
				setSaveError(result.message);
			}
		} catch (error) {
			console.error('Save error:', error);
			setSaveError('Save failed, please try again');
		} finally {
			setIsSaving(false);
		}
	}, [editingProvider, formData, refreshProviders]);

	const closeProviderModal = useCallback(() => {
		if (isSaving || isDeleting) return;
		setShowModal(false);
	}, [isDeleting, isSaving]);

	return {
		isLoading,
		providers,
		providerSearch,
		setProviderSearch,
		filteredProviders,
		copiedId,
		statusTogglingId,
		showModal,
		editingProvider,
		duplicateSourceId,
		formData,
		setFormData,
		saveError,
		isSaving,
		isDeleting,
		showImportModal,
		setShowImportModal,
		importCatalogRows,
		importCatalogSearch,
		setImportCatalogSearch,
		filteredImportCatalogRows,
		importCatalogLoading,
		importCatalogError,
		importSelected,
		importSelectedCount,
		importSubmitting,
		handleCreate,
		handleEdit,
		handleDuplicate,
		handleDelete,
		handleSave,
		closeProviderModal,
		openImportModal,
		toggleImportPreset,
		selectAllImportPresets,
		clearImportPresetSelection,
		runImportSelectedPresets,
		handleCopyApiKey,
		handleToggleStatus,
	};
}
