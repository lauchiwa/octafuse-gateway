/**
 * Provider 自定义上游 header 的类型。
 * 权威列为 `providers.custom_headers`（JSON），按协议粒度存储。
 * 解析 / 校验 / 序列化见 `provider-custom-headers.ts`。
 */
import type { UpstreamProtocol } from './upstream-protocol';

/**
 * 解析后的 `providers.custom_headers` 对象（仅含已配置协议）。
 * 结构：`{ openai?: { 'User-Agent': '...' }, anthropic?: {...}, gemini?: {...} }`。
 */
export type ProviderCustomHeadersMap = Partial<Record<UpstreamProtocol, Record<string, string>>>;

/** 供 `parseProviderCustomHeaders` 读取的 provider 行字段。 */
export type ProviderCustomHeadersSource = {
	custom_headers?: string | ProviderCustomHeadersMap | null;
};
