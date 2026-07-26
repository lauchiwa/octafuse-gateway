/**
 * D1：`provider_api_keys` 表。
 */
import type { D1DatabaseClient } from '../../storage/database-client';
import type { ProviderApiKeysRepository } from '../../storage/gateway-repository-interfaces';
import type {
	ActiveProviderApiKeyRow,
	InsertProviderApiKeyParams,
	ProviderApiKeyAdminRow,
	UpdateProviderApiKeyPatch,
} from '../provider-api-keys-types';
import { isPendingProviderImportApiKey, maskProviderApiKeyForAdmin } from '../provider-key-utils';
import { PROVIDER_API_KEY_PATCH_COLS } from '../patch-allowlists';
import { createProviderKeyCrypto, type ProviderKeyCrypto } from '../../services/provider-key-crypto';

function mapAdminRow(row: {
	id: string;
	provider_id: string;
	label: string;
	api_key: string;
	status: string;
	weight: number;
	priority: number;
	limit_config: string | null;
	created_at: string;
	updated_at: string;
}): ProviderApiKeyAdminRow {
	return {
		id: row.id,
		provider_id: row.provider_id,
		label: row.label,
		status: row.status,
		weight: row.weight,
		priority: row.priority,
		limit_config: row.limit_config,
		masked_api_key: maskProviderApiKeyForAdmin(row.api_key),
		is_pending_import: isPendingProviderImportApiKey(row.api_key),
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

export function createD1ProviderApiKeysRepository(
	db: D1DatabaseClient,
	crypto?: ProviderKeyCrypto
): ProviderApiKeysRepository {
	const raw = db.raw;
	// 未注入时按「历史明文」语义直通，便于既有单测与未配置 secret 的自托管场景。
	const keyCrypto: ProviderKeyCrypto = crypto ?? createProviderKeyCrypto(null);
	return {
		async listProviderKeys(providerId: string): Promise<ProviderApiKeyAdminRow[]> {
			const rows = await raw
				.prepare(
					`SELECT id, provider_id, label, api_key, status, weight, priority, limit_config, created_at, updated_at
					 FROM provider_api_keys WHERE provider_id = ? ORDER BY priority DESC, created_at ASC`
				)
				.bind(providerId)
				.all<{
					id: string;
					provider_id: string;
					label: string;
					api_key: string;
					status: string;
					weight: number;
					priority: number;
					limit_config: string | null;
					created_at: string;
					updated_at: string;
				}>();
			return Promise.all(
				(rows.results ?? []).map(async (row) => mapAdminRow({ ...row, api_key: await keyCrypto.decrypt(row.api_key) }))
			);
		},

		async getActiveProviderKeys(providerId: string): Promise<ActiveProviderApiKeyRow[]> {
			const rows = await raw
				.prepare(
					`SELECT id, label, api_key, weight, priority, limit_config FROM provider_api_keys
					 WHERE provider_id = ? AND status = 'active'
					 ORDER BY priority DESC, created_at ASC`
				)
				.bind(providerId)
				.all<ActiveProviderApiKeyRow>();
			return Promise.all(
				(rows.results ?? []).map(async (row) => ({ ...row, api_key: await keyCrypto.decrypt(row.api_key) }))
			);
		},

		async createProviderKey(params: InsertProviderApiKeyParams): Promise<void> {
			const now = new Date().toISOString();
			const storedApiKey = await keyCrypto.encrypt(params.apiKey);
			await raw
				.prepare(
					`INSERT INTO provider_api_keys (id, provider_id, label, api_key, status, weight, priority, limit_config, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					params.id,
					params.providerId,
					params.label,
					storedApiKey,
					params.status ?? 'active',
					params.weight ?? 1,
					params.priority ?? 0,
					params.limitConfig ?? null,
					now,
					now
				)
				.run();
		},

		async updateProviderKeyByPatch(keyId: string, patch: UpdateProviderApiKeyPatch): Promise<number> {
			const setCols: string[] = [];
			const bindValues: unknown[] = [];
			const fieldMap: Record<string, unknown> = {
				label: patch.label,
				api_key: patch.apiKey === undefined ? undefined : await keyCrypto.encrypt(patch.apiKey),
				status: patch.status,
				weight: patch.weight,
				priority: patch.priority,
				limit_config: patch.limitConfig,
			};
			for (const [key, value] of Object.entries(fieldMap)) {
				if (value === undefined) continue;
				if (!PROVIDER_API_KEY_PATCH_COLS.has(key)) continue;
				setCols.push(`${key} = ?`);
				bindValues.push(value);
			}
			if (setCols.length === 0) return 0;
			setCols.push('updated_at = ?');
			bindValues.push(new Date().toISOString());
			const result = await raw
				.prepare(`UPDATE provider_api_keys SET ${setCols.join(', ')} WHERE id = ?`)
				.bind(...bindValues, keyId)
				.run();
			return result.meta.changes;
		},

		async deleteProviderKeyById(keyId: string): Promise<number> {
			const deleted = await raw.prepare('DELETE FROM provider_api_keys WHERE id = ?').bind(keyId).run();
			return deleted.meta.changes;
		},

		async getProviderKeyById(keyId: string): Promise<ProviderApiKeyAdminRow | null> {
			const row = await raw
				.prepare(
					`SELECT id, provider_id, label, api_key, status, weight, priority, limit_config, created_at, updated_at
					 FROM provider_api_keys WHERE id = ?`
				)
				.bind(keyId)
				.first<{
					id: string;
					provider_id: string;
					label: string;
					api_key: string;
					status: string;
					weight: number;
					priority: number;
					limit_config: string | null;
					created_at: string;
					updated_at: string;
				}>();
			return row ? mapAdminRow({ ...row, api_key: await keyCrypto.decrypt(row.api_key) }) : null;
		},

		async getProviderKeyPlaintext(keyId: string): Promise<{ provider_id: string; api_key: string } | null> {
			const row = await raw
				.prepare(`SELECT provider_id, api_key FROM provider_api_keys WHERE id = ?`)
				.bind(keyId)
				.first<{ provider_id: string; api_key: string }>();
			if (!row) return null;
			return { provider_id: row.provider_id, api_key: await keyCrypto.decrypt(row.api_key) };
		},

		async countActiveProviderKeys(providerId: string): Promise<number> {
			const row = await raw
				.prepare(`SELECT COUNT(*) as cnt FROM provider_api_keys WHERE provider_id = ? AND status = 'active'`)
				.bind(providerId)
				.first<{ cnt: number }>();
			return row?.cnt ?? 0;
		},
	};
}