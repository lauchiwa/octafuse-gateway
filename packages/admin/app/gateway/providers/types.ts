import type { GatewayProvider } from '@/lib/types';
import type {
	ProviderEndpointCapability,
	ProviderEndpointsMap,
} from '@octafuse/core/provider-endpoints';

/** 卡片上紧凑展示的能力标签（OpenAI images.* 合并为 images）。 */
export type ProviderCapabilityBadge =
	| 'chat'
	| 'images'
	| 'messages'
	| 'generateContent'
	| 'streamGenerateContent';

/** `GET /admin/providers/import/catalog` */
export type ProviderImportCatalogRow = {
	id: string;
	name: string;
	vendor_key: string;
	icon_key: string;
	vendor_label: string;
	protocols: Array<'openai' | 'anthropic' | 'gemini'>;
	endpoints: string | null;
	description: string | null;
};

export type ProviderKeyRow = {
	id: string;
	provider_id: string;
	label: string;
	status: string;
	weight: number;
	priority: number;
	/** 限流配置 JSON（`{"rpm":…,"tpm":…,"max_concurrency":…}`）；null=不限流 */
	limit_config: string | null;
	masked_api_key: string;
	is_pending_import: boolean;
	created_at: string;
	updated_at: string;
};

export type ProviderProtocolSummary = {
	key: 'openai' | 'anthropic' | 'gemini';
	label: string;
	url: string;
	/** 与 runtime 一致的已配置 capability（完整 key）。 */
	capabilities: ProviderEndpointCapability[];
	/** 卡片紧凑标签（images.* → images）。 */
	badges: ProviderCapabilityBadge[];
};

/** 单协议自定义上游 header 编辑行（键值对）。 */
export type CustomHeaderRow = {
	name: string;
	value: string;
};

/** 单协议表单：base + Advanced capability 覆盖 + 自定义上游 header */
export type ProtocolEndpointForm = {
	base: string;
	chat: string;
	images_generations: string;
	images_edits: string;
	messages: string;
	generateContent: string;
	streamGenerateContent: string;
	/** 自定义上游 header（键值对行）；空行在提交时会被过滤 */
	customHeaders: CustomHeaderRow[];
};

export type ProviderFormData = {
	id: string;
	name: string;
	openai: ProtocolEndpointForm;
	anthropic: ProtocolEndpointForm;
	gemini: ProtocolEndpointForm;
	description: string;
};

export type ProviderKeyFormData = {
	label: string;
	api_key: string;
	weight: string;
	priority: string;
	rpm: string;
	tpm: string;
	max_concurrency: string;
	status: string;
};

export type EditingProviderKeyState = {
	providerId: string;
	key: ProviderKeyRow;
};

export type ProviderImportResult = {
	created: number;
	failed: Array<{ id: string; message: string }>;
};

export const EMPTY_PROTOCOL_FORM: ProtocolEndpointForm = {
	base: '',
	chat: '',
	images_generations: '',
	images_edits: '',
	messages: '',
	generateContent: '',
	streamGenerateContent: '',
	customHeaders: [],
};

/** 全新单协议表单：customHeaders 独立数组，避免三协议共享同一引用。 */
export function emptyProtocolForm(): ProtocolEndpointForm {
	return { ...EMPTY_PROTOCOL_FORM, customHeaders: [] };
}

export const EMPTY_PROVIDER_FORM: ProviderFormData = {
	id: '',
	name: '',
	openai: emptyProtocolForm(),
	anthropic: emptyProtocolForm(),
	gemini: emptyProtocolForm(),
	description: '',
};

export const EMPTY_KEY_EDIT_FORM: ProviderKeyFormData = {
	label: '',
	api_key: '',
	weight: '1',
	priority: '0',
	rpm: '',
	tpm: '',
	max_concurrency: '',
	status: 'active',
};

export type { GatewayProvider, ProviderEndpointsMap };
