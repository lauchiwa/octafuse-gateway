import type { GatewayModel } from '@/lib/types';

/** API returns models with tags parsed as string[] */
export type ModelListItem = Omit<GatewayModel, 'tags'> & {
	tags: string[];
	routes_count: number;
	active_routes_count: number;
};

/** `GET /admin/models/import/catalog` */
export type PresetCatalogRow = {
	id: string;
	display_name: string | null;
	vendor: string;
	/** `llm` | `image` | `audio` — same Kind as Models list filter */
	kind: 'llm' | 'image' | 'audio';
	context_window: number | null;
	max_tokens: number | null;
	description: string | null;
	i18n: {
		en: string;
		zh: string;
	} | null;
	/** Tier count for the billing-currency catalog branch. */
	tier_count: number;
	/** Short cell label (USD/CNY branch per `BILLING_CURRENCY`). */
	pricing_label: string | null;
	pricing_preview: string | null;
};

export type ModelFormData = {
	id: string;
	display_name: string;
	vendor: string;
	context_window: string;
	max_tokens: string;
	input_modalities: string[];
	output_modalities: string[];
	released_at: string;
	tags: string[];
	description: string;
	metadata: string;
};

export type MetadataSummary =
	| { kind: 'empty' }
	| { kind: 'object'; keyCount: number; keyPreview: string[]; formatted: string }
	| { kind: 'raw'; formatted: string; label: string };

export type MetadataPreviewState = {
	model: ModelListItem;
	summary: Exclude<MetadataSummary, { kind: 'empty' }>;
};

export type ModelImportResult = {
	billing_currency_used: string;
	created: number;
	skipped_existing: string[];
	failed: Array<{ id: string; message: string }>;
};

/** Sidebar filter: show models from every vendor (`?vendor=all`). */
export const ALL_VENDORS_KEY = 'all';

/**
 * Models / Routes Kind 视图（`?kind=llm|image|audio`）。
 * 无 All：始终只看一种；缺省 / 非法值回退 LLM。
 * 权威定义见 `@/lib/invoke-kind`（Simulator / Playground 另含 `tool`）。
 */
export {
	DEFAULT_KIND_FILTER,
	type ModelKindFilter,
	parseKindFilterParam,
} from '@/lib/invoke-kind';

export const EMPTY_MODEL_FORM: ModelFormData = {
	id: '',
	display_name: '',
	vendor: 'other',
	context_window: '',
	max_tokens: '8192',
	input_modalities: ['text'],
	output_modalities: ['text'],
	released_at: '',
	tags: [],
	description: '',
	metadata: '',
};

/** 手工新建 Image 模型时的模态默认值（对齐 gpt-image-2：text+image → image）。 */
export const EMPTY_IMAGE_MODEL_FORM: ModelFormData = {
	...EMPTY_MODEL_FORM,
	max_tokens: '',
	input_modalities: ['text', 'image'],
	output_modalities: ['image'],
};

/** 手工新建 Audio 转写模型时的模态默认值（对齐 whisper-1：audio → text）。 */
export const EMPTY_AUDIO_MODEL_FORM: ModelFormData = {
	...EMPTY_MODEL_FORM,
	max_tokens: '',
	context_window: '',
	input_modalities: ['audio'],
	output_modalities: ['text'],
};

export type ModelFormKind = 'llm' | 'image' | 'audio';
