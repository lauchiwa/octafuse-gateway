/**
 * 上游 header 合并：实现已上移到 `@octafuse/core/provider-custom-headers`，
 * 供 Proxy egress 驱动与 Admin playground 共用（admin 不依赖 proxy）。
 * 此处保留再导出，四驱动的导入路径不变。
 */
export { mergeUpstreamHeaders } from '@octafuse/core/provider-custom-headers';
