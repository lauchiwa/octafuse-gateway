/**
 * 合并 provider 自定义上游 header 与驱动内置 header。
 *
 * 安全边界：`{ ...custom, ...base }` —— 驱动内置的鉴权/协议 header（Authorization /
 * x-api-key / anthropic-version / Content-Type 等）永远覆盖自定义 header。
 * 因此自定义 header 只能补充中性字段（如 User-Agent），无法篡改鉴权或传输语义。
 *
 * 纯函数、无 `node:*` 依赖，Worker / Node 双运行时安全。
 */
export function mergeUpstreamHeaders(
	base: Record<string, string>,
	custom: Record<string, string> | undefined | null
): Record<string, string> {
	if (!custom || Object.keys(custom).length === 0) {
		return base;
	}
	return { ...custom, ...base };
}
