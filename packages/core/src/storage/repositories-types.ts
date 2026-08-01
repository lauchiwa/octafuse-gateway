import type { ProviderKeyCrypto } from '../services/provider-key-crypto';
import type { GatewayDatabaseClient } from './database-client';
import type {
	AdminAnalyticsRepository,
	ApiKeysRepository,
	ModelRoutesRepository,
	ModelRoutingRepository,
	ModelsRepository,
	ProvidersRepository,
	RequestLogsRepository,
	SystemConfigRepository,
	UserAuditLogsRepository,
	UsersRepository,
} from './gateway-repository-interfaces';
import type { ApiKeysD1Statements, RequestLogsD1Statements } from '../db/d1/d1-repository-extras';

export type ApiKeysRepositoryHandle = ApiKeysRepository & Partial<ApiKeysD1Statements>;
export type RequestLogsRepositoryHandle = RequestLogsRepository & Partial<RequestLogsD1Statements>;

export interface GatewayRepositories {
	readonly client: GatewayDatabaseClient;
	readonly users: UsersRepository;
	readonly apiKeys: ApiKeysRepositoryHandle;
	readonly requestLogs: RequestLogsRepositoryHandle;
	readonly providers: ProvidersRepository;
	readonly models: ModelsRepository;
	readonly routes: ModelRoutesRepository;
	readonly systemConfig: SystemConfigRepository;
	readonly analytics: AdminAnalyticsRepository;
	readonly modelRouting: ModelRoutingRepository;
	readonly userAuditLogs: UserAuditLogsRepository;
}

/** 统一取 Hono 上下文中的 `GatewayDatabaseClient`。 */
export function getGatewayDatabaseClient(repositories: GatewayRepositories): GatewayDatabaseClient {
	return repositories.client;
}

/** 存储层可选能力：注入后 provider 上游密钥在库中以密文存取，对调用方透明。 */
export interface GatewayRepositoriesOptions {
	providerKeyCrypto?: ProviderKeyCrypto;
}
