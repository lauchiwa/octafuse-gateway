import type { GatewayProvider } from '@/lib/types';
import type {
	ProviderEndpointCapability,
	ProviderEndpointsMap,
} from '@octafuse/core/provider-endpoints';

/** 卡片上紧凑展示的能力标签（OpenAI images.* 合并为 images；audio.transcriptions → audio）。 */
export type ProviderCapabilityBadge =
	| 'chat'
	| 'responses'
	| 'images'
	| 'audio'
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

export type ProviderProtocolSummary = {
	key: 'openai' | 'anthropic' | 'gemini';
	label: string;
	baseUrl: string | null;
	overrideCount: number;
	/** 与 runtime 一致的已配置 capability（完整 key）。 */
	capabilities: ProviderEndpointCapability[];
	/** 卡片紧凑标签（images.* → images）。 */
	badges: ProviderCapabilityBadge[];
	endpoints: Array<{
		capability: ProviderEndpointCapability;
		url: string;
		source: 'base' | 'override';
	}>;
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
	/** Responses API：必须显式配置完整 URL（永不由 base 派生，见 core/provider-endpoints） */
	responses: string;
	images_generations: string;
	images_edits: string;
	audio_transcriptions: string;
	messages: string;
	generateContent: string;
	streamGenerateContent: string;
	/** 自定义上游 header（键值对行）；空行在提交时会被过滤 */
	customHeaders: CustomHeaderRow[];
};

export type ProviderFormData = {
	id: string;
	name: string;
	/** 创建必填；编辑时空 = 不改 */
	api_key: string;
	/** `active` | `disabled` */
	status: 'active' | 'disabled';
	openai: ProtocolEndpointForm;
	anthropic: ProtocolEndpointForm;
	gemini: ProtocolEndpointForm;
	description: string;
};

export type ProviderImportResult = {
	created: number;
	failed: Array<{ id: string; message: string }>;
};

export const EMPTY_PROTOCOL_FORM: ProtocolEndpointForm = {
	base: '',
	chat: '',
	responses: '',
	images_generations: '',
	images_edits: '',
	audio_transcriptions: '',
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
	api_key: '',
	status: 'active',
	openai: emptyProtocolForm(),
	anthropic: emptyProtocolForm(),
	gemini: emptyProtocolForm(),
	description: '',
};

export type { GatewayProvider, ProviderEndpointsMap };
