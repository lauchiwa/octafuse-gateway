import {
	createD1StorageContext,
	createProviderKeyCrypto,
	resolveWorkerDatabaseConfig,
	type StorageContext,
} from '@octafuse/core';
import type { Context } from 'hono';
import { createProxyApp, type Env } from '../app';

async function resolveWorkersStorage(context: Context<Env>): Promise<StorageContext> {
	const config = resolveWorkerDatabaseConfig(context.env);
	// provider 上游密钥静态加密；未配置 secret 时历史明文仍可读（见 provider-key-crypto）。
	const secret = (context.env as { PROVIDER_KEY_ENCRYPTION_KEY?: string }).PROVIDER_KEY_ENCRYPTION_KEY;
	return createD1StorageContext(config.db, {
		providerKeyCrypto: createProviderKeyCrypto(secret),
	});
}

export const workerApp = createProxyApp(resolveWorkersStorage, {
	beforeAll: (c, next) => {
		resolveWorkerDatabaseConfig(c.env);
		return next();
	},
});
