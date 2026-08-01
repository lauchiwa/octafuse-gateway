/**
 * Build Proxy-facing requests from the browser: URL, headers, and JSON body per protocol
 * (including OpenAI/Anthropic `model` field).
 */
import { applyGeminiStreamQueryParams } from '@octafuse/core/gemini-upstream-url';
import type { ImageOperation } from '@/lib/image-generations';

export type SimulatorProtocol = 'openai' | 'anthropic' | 'gemini';

export type SimulatorGeminiAction = 'generateContent' | 'streamGenerateContent';

/**
 * Which OpenAI-family Proxy surface to call. `chat` → `/v1/chat/completions`,
 * `responses` → `/v1/responses` (item-centred; what Codex CLI speaks).
 * Image models ignore this and use `/v1/images/*`.
 */
export type SimulatorOpenAiSurface = 'chat' | 'responses';

export type BuildSimulatorRequestInput = {
	/** Trimmed Proxy root URL without a trailing slash, e.g. https://gateway.example.com */
	baseUrl: string;
	protocol: SimulatorProtocol;
	/**
	 * OpenAI/Anthropic `body.model`, or the Gemini path model segment (may include `id:route_group`).
	 * Matches Proxy `resolveModelRouting`: full id, or `baseId:group`.
	 */
	modelForRouting: string;
	geminiAction?: SimulatorGeminiAction;
	/** OpenAI non-image models: chat completions (default) or the Responses API. */
	openaiSurface?: SimulatorOpenAiSurface;
	/** User-edited JSON object (`model` is overwritten for OpenAI/Anthropic before send) */
	body: Record<string, unknown>;
	/** Full `sk-…` or already prefixed with Bearer */
	apiKey: string;
	/**
	 * OpenAI image models: Proxy `POST /v1/images/generations` or `/v1/images/edits`.
	 * Prefer over legacy `imagesGenerations`.
	 */
	imageOperation?: ImageOperation;
	/**
	 * @deprecated Use `imageOperation: 'generations'` instead.
	 * OpenAI only: use Proxy `POST /v1/images/generations` instead of chat completions.
	 */
	imagesGenerations?: boolean;
	/** Required when `imageOperation === 'edits'`: reference image files for multipart. */
	editImages?: File[];
	/**
	 * OpenAI audio models: Proxy `POST /v1/audio/transcriptions` (multipart).
	 * When true, prefer over chat / images.
	 */
	audioTranscriptions?: boolean;
	/** Required when `audioTranscriptions`: audio file for multipart. */
	audioFile?: File | null;
};

export type BuildSimulatorRequestResult = {
	url: string;
	headers: Record<string, string>;
	/** JSON.stringify result (empty string when `formData` is set) */
	bodyText: string;
	/** Multipart body for images/edits; when set, caller must not set Content-Type. */
	formData?: FormData;
	/** Human-readable summary for wire preview when body is multipart. */
	multipartSummary?: string;
};

function stripTrailingSlash(u: string): string {
	return u.replace(/\/$/, '');
}

function bearerHeader(apiKey: string): string {
	const t = apiKey.trim();
	if (t.toLowerCase().startsWith('bearer ')) return t;
	return `Bearer ${t}`;
}

function resolveImageOperation(input: BuildSimulatorRequestInput): ImageOperation | null {
	if (input.imageOperation === 'generations' || input.imageOperation === 'edits') {
		return input.imageOperation;
	}
	if (input.imagesGenerations) return 'generations';
	return null;
}

function appendOptionalFormField(fd: FormData, key: string, value: unknown): void {
	if (value == null) return;
	if (typeof value === 'string') {
		const t = value.trim();
		if (t !== '') fd.append(key, t);
		return;
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		fd.append(key, String(value));
	}
}

/**
 * Build `fetch` arguments for the Proxy (no `signal`).
 */
export function buildSimulatorRequest(input: BuildSimulatorRequestInput): BuildSimulatorRequestResult {
	const base = stripTrailingSlash(input.baseUrl.trim());
	const auth = bearerHeader(input.apiKey);

	switch (input.protocol) {
		case 'openai': {
			if (input.audioTranscriptions) {
				const file = input.audioFile ?? null;
				const fd = new FormData();
				fd.append('model', input.modelForRouting);
				appendOptionalFormField(fd, 'language', input.body.language);
				appendOptionalFormField(fd, 'response_format', input.body.response_format);
				appendOptionalFormField(fd, 'prompt', input.body.prompt);
				appendOptionalFormField(fd, 'temperature', input.body.temperature);
				const fileLines: string[] = [];
				if (file) {
					fd.append('file', file, file.name || 'audio.webm');
					fileLines.push(`${file.name || 'audio.webm'} (${file.size} bytes)`);
				}
				const fieldParts = ['model', 'file'];
				if (input.body.language != null) fieldParts.push('language');
				if (input.body.response_format != null) fieldParts.push('response_format');
				if (input.body.prompt != null) fieldParts.push('prompt');
				if (input.body.temperature != null) fieldParts.push('temperature');
				const fileSummary =
					!file
						? 'file: (none selected yet — required before Send)'
						: [`file:`, ...fileLines.map((l) => `  - ${l}`)].join('\n');
				return {
					url: `${base}/v1/audio/transcriptions`,
					headers: {
						Authorization: auth,
					},
					bodyText: '',
					formData: fd,
					multipartSummary: [
						`multipart/form-data fields: ${fieldParts.join(', ')}`,
						fileSummary,
					].join('\n'),
				};
			}
			const imageOp = resolveImageOperation(input);
			if (imageOp === 'edits') {
				// Allow empty files for live URL preview; Send path validates before fetch.
				const files = input.editImages ?? [];
				const fd = new FormData();
				fd.append('model', input.modelForRouting);
				appendOptionalFormField(fd, 'prompt', input.body.prompt);
				appendOptionalFormField(fd, 'n', input.body.n);
				appendOptionalFormField(fd, 'size', input.body.size);
				appendOptionalFormField(fd, 'quality', input.body.quality);
				appendOptionalFormField(fd, 'background', input.body.background);
				const fileLines: string[] = [];
				for (const file of files) {
					fd.append('image', file, file.name || 'image.png');
					fileLines.push(`${file.name || 'image.png'} (${file.size} bytes)`);
				}
				const fieldParts = ['model', 'prompt'];
				if (input.body.n != null) fieldParts.push('n');
				if (input.body.size != null) fieldParts.push('size');
				if (input.body.quality != null) fieldParts.push('quality');
				if (input.body.background != null) fieldParts.push('background');
				const imageSummary =
					files.length === 0
						? 'images: (none selected yet — required before Send)'
						: [`images (${files.length}):`, ...fileLines.map((l) => `  - ${l}`)].join('\n');
				return {
					url: `${base}/v1/images/edits`,
					headers: {
						Authorization: auth,
					},
					bodyText: '',
					formData: fd,
					multipartSummary: [
						`multipart/form-data fields: ${fieldParts.join(', ')}`,
						imageSummary,
					].join('\n'),
				};
			}
			const merged = { ...input.body, model: input.modelForRouting };
			// 非图片模型时可选 Responses 面；图片模型仍走 /v1/images/*。
			const nonImagePath =
				input.openaiSurface === 'responses' ? '/v1/responses' : '/v1/chat/completions';
			const path = imageOp === 'generations' ? '/v1/images/generations' : nonImagePath;
			return {
				url: `${base}${path}`,
				headers: {
					'Content-Type': 'application/json',
					Authorization: auth,
				},
				bodyText: JSON.stringify(merged),
			};
		}
		case 'anthropic': {
			const merged = { ...input.body, model: input.modelForRouting };
			return {
				url: `${base}/v1/messages`,
				headers: {
					'Content-Type': 'application/json',
					Authorization: auth,
				},
				bodyText: JSON.stringify(merged),
			};
		}
		case 'gemini': {
			const action: SimulatorGeminiAction =
				input.geminiAction === 'generateContent' ? 'generateContent' : 'streamGenerateContent';
			const pathModel = encodeURIComponent(input.modelForRouting);
			const url = new URL(`${base}/v1beta/models/${pathModel}:${action}`);
			applyGeminiStreamQueryParams(url, action);
			return {
				url: url.toString(),
				headers: {
					'Content-Type': 'application/json',
					Authorization: auth,
				},
				bodyText: JSON.stringify(input.body),
			};
		}
		default: {
			const _exhaustive: never = input.protocol;
			throw new Error(`Unsupported protocol: ${String(_exhaustive)}`);
		}
	}
}
