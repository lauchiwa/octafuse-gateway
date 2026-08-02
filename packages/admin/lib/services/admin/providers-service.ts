/** 管理后台 `providers` CRUD：单键 `api_key` + `status`，`endpoints` JSON 校验与持久化。 */
import type { GatewayRepositories } from '@octafuse/core';
import {
	serializeProviderEndpoints,
	validateAndNormalizeProviderEndpoints,
	type ProviderEndpointsMap,
} from '@octafuse/core/provider-endpoints';
import {
	isPendingProviderImportApiKey,
	maskProviderApiKeyForAdmin,
	PROVIDER_IMPORT_PENDING_API_KEY,
} from '@octafuse/core/db/provider-key-utils';
import {
	serializeProviderCustomHeaders,
	validateAndNormalizeProviderCustomHeaders,
} from '@octafuse/core/provider-custom-headers';
import {
	inferStaticProviderIconKey,
	inferStaticProviderVendorKey,
	listStaticProviderImportPresets,
} from '@/lib/provider-import-preset';
import { badRequest, conflict, notFound } from './errors';
import type {
	AdminCreatedIdOutput,
	AdminProviderMutationInput,
	AdminProviderRow,
	AdminProvidersImportOutput,
} from './types';

function resolveEndpointsFromMutation(body: AdminProviderMutationInput): string | null {
	if (body.endpoints === undefined || body.endpoints === null) {
		return null;
	}
	let map: ProviderEndpointsMap;
	try {
		map = validateAndNormalizeProviderEndpoints(body.endpoints);
	} catch (e) {
		throw badRequest(e instanceof Error ? e.message : 'Invalid endpoints');
	}
	return serializeProviderEndpoints(map);
}

function normalizeProviderStatus(raw: unknown): 'active' | 'disabled' {
	if (raw === 'disabled') return 'disabled';
	if (raw === 'active' || raw === undefined || raw === null || raw === '') return 'active';
	throw badRequest('status must be active or disabled');
}

function resolveCustomHeadersFromMutation(body: AdminProviderMutationInput): string | null {
	if (body.customHeaders === undefined || body.customHeaders === null) {
		return null;
	}
	const result = validateAndNormalizeProviderCustomHeaders(body.customHeaders);
	if (!result.ok) {
		throw badRequest(result.error);
	}
	return serializeProviderCustomHeaders(result.value);
}

/** 列表/详情脱敏：明文 `api_key` → masked；附带 `has_pending_key`。 */
function enrichProviderRow(provider: AdminProviderRow): AdminProviderRow {
	const plaintext = typeof provider.api_key === 'string' ? provider.api_key : '';
	const vendorKey = inferStaticProviderVendorKey(provider);
	return {
		...provider,
		vendor_key: vendorKey,
		icon_key: inferStaticProviderIconKey({ ...provider, vendor_key: vendorKey }),
		api_key: maskProviderApiKeyForAdmin(plaintext),
		status: provider.status === 'disabled' ? 'disabled' : 'active',
		has_pending_key: isPendingProviderImportApiKey(plaintext),
	};
}

/** 供应商列表（脱敏 api_key）。 */
export async function listProvidersService(repos: GatewayRepositories): Promise<AdminProviderRow[]> {
	const providers = (await repos.providers.listProviders()) as AdminProviderRow[];
	return providers.map(enrichProviderRow);
}

/**
 * 创建供应商；可指定 `id`，冲突抛 `conflict`；`api_key` 必填；协议 endpoints 均可为空。
 */
export async function createProviderService(
	repos: GatewayRepositories,
	body: AdminProviderMutationInput
): Promise<AdminCreatedIdOutput> {
	const customId = String(body.id ?? '').trim();
	const name = String(body.name ?? '');
	const apiKey = String(body.api_key ?? '').trim();
	if (!name) {
		throw badRequest('name is required');
	}
	if (!apiKey) {
		throw badRequest('api_key is required');
	}

	const endpointsJson = resolveEndpointsFromMutation(body);
	const status = normalizeProviderStatus(body.status);
	const customHeadersJson = resolveCustomHeadersFromMutation(body);

	const id = customId || crypto.randomUUID();
	if (customId && (await repos.providers.providerIdExists(id))) {
		throw conflict('Provider ID already exists');
	}

	await repos.providers.insertProvider({
		id,
		name,
		endpoints: endpointsJson,
		description: body.description,
		apiKey,
		status,
		customHeaders: customHeadersJson,
	});

	return { id };
}

/** 单条供应商（脱敏）；不存在抛 `notFound`。 */
export async function getProviderService(repos: GatewayRepositories, id: string): Promise<AdminProviderRow> {
	const provider = await repos.providers.getProviderRowById(id);
	if (!provider) throw notFound('Provider not found');
	return enrichProviderRow(provider as AdminProviderRow);
}

/** 揭示供应商明文 API Key。 */
export async function revealProviderApiKeyService(
	repos: GatewayRepositories,
	providerId: string
): Promise<{ api_key: string }> {
	const provider = await repos.providers.getProviderRowById(providerId);
	if (!provider) throw notFound('Provider not found');
	const row = await repos.providers.getProviderApiKeyPlaintext(providerId);
	if (!row) throw notFound('Provider not found');
	return { api_key: row.api_key };
}

/**
 * PATCH 供应商；`api_key` 空串/未传 = 不改；写 `endpoints`（权威）。
 */
export async function updateProviderService(
	repos: GatewayRepositories,
	id: string,
	body: AdminProviderMutationInput
): Promise<void> {
	const existing = await repos.providers.getProviderRowById(id);
	if (!existing) throw notFound('Provider not found');

	const patch: Record<string, unknown> = {};

	if (body.name !== undefined) {
		const name = String(body.name ?? '').trim();
		if (!name) throw badRequest('name cannot be empty');
		patch.name = name;
	}
	if (body.description !== undefined) {
		patch.description = body.description;
	}
	if ('endpoints' in body) {
		patch.endpoints = resolveEndpointsFromMutation(body);
	}
	if (body.status !== undefined) {
		patch.status = normalizeProviderStatus(body.status);
	}
	if (body.api_key !== undefined) {
		const apiKey = String(body.api_key ?? '').trim();
		if (apiKey) {
			patch.api_key = apiKey;
		}
	}
	// UI 传 camelCase `customHeaders`；patch 白名单为 snake_case `custom_headers`，需转换后再落库。
	// 注意：检查 `body` 而非 `patch` —— `patch` 只含显式逐字段添加的键，从不含 customHeaders；
	// 若检查 `patch`，custom_headers 永远不会写入（合并上游时重构引入的回归）。
	// 置于空 patch 检查之前，避免「仅修改 custom headers」被提前 return。
	if ('customHeaders' in body) {
		patch.custom_headers = resolveCustomHeadersFromMutation(body);
	}

	if (Object.keys(patch).length === 0) return;

	const changes = await repos.providers.updateProviderByPatch(id, patch);
	if (changes === 0) {
		throw notFound('Provider not found');
	}
}

/** 删除供应商；不存在抛 `notFound`。 */
export async function deleteProviderService(repos: GatewayRepositories, id: string): Promise<void> {
	const changes = await repos.providers.deleteProviderById(id);
	if (!changes) throw notFound('Provider not found');
}

/** 在 `providers.name` UNIQUE 约束下为模板导入生成唯一显示名。 */
function suggestUniqueProviderImportName(baseName: string, existingNameLower: Set<string>): string {
	const trimmed = baseName.trim();
	if (!existingNameLower.has(trimmed.toLowerCase())) {
		return trimmed;
	}
	for (let n = 2; n < 1000; n++) {
		const candidate = `${trimmed} (${n})`;
		if (!existingNameLower.has(candidate.toLowerCase())) {
			return candidate;
		}
	}
	throw badRequest(`Unable to allocate unique provider name for: ${trimmed}`);
}

/**
 * 从 `lib/provider-import-presets.json` 按 **catalog 键**导入 Provider：
 * 写入占位 `PROVIDER_IMPORT_PENDING_API_KEY`，须在 Admin 中替换为真实密钥。
 */
export async function importProvidersFromStaticPresetsService(
	repos: GatewayRepositories,
	input: { ids: string[] }
): Promise<AdminProvidersImportOutput> {
	const uniqueIds = [...new Set((input.ids ?? []).map((x) => String(x).trim()).filter((x) => x.length > 0))];
	if (uniqueIds.length === 0) {
		throw badRequest('ids must be a non-empty array of preset catalog keys');
	}

	const presetByKey = new Map(listStaticProviderImportPresets().map((p) => [p.catalog_key, p]));

	let created = 0;
	const failed: Array<{ id: string; message: string }> = [];

	const existingProviders = await listProvidersService(repos);
	const existingNameLower = new Set(existingProviders.map((p) => p.name.trim().toLowerCase()));

	for (const catalogKey of uniqueIds) {
		const preset = presetByKey.get(catalogKey);
		try {
			if (!preset) {
				throw badRequest(`Unknown static preset catalog key: ${catalogKey}`);
			}

			const baseName = String(preset.name ?? '').trim();
			if (!baseName) {
				throw badRequest(`Static preset catalog key "${catalogKey}": missing name`);
			}

			const name = suggestUniqueProviderImportName(baseName, existingNameLower);

			await createProviderService(repos, {
				name,
				endpoints: preset.endpoints,
				description: preset.description ?? null,
				api_key: PROVIDER_IMPORT_PENDING_API_KEY,
				status: 'active',
			});

			existingNameLower.add(name.toLowerCase());
			created++;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			failed.push({ id: catalogKey, message });
		}
	}

	return {
		created,
		updated: 0,
		skipped_existing: [],
		failed,
	};
}
