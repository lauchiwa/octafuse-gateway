/**
 * `route_pools.tier_strategies` JSON：按 priority 层覆盖同层路由策略。
 *
 * 结构：
 * ```json
 * { "10": "hash_affinity", "0": "weight_priority" }
 * ```
 * - key 为整数 priority（字符串形式亦可）
 * - value 须为合法 `RouteStrategyName`
 * - 解析时非法条目忽略；normalize（Admin 写入）时非法则抛错
 */

import type { RouteStrategyName } from '../types';
import { isRouteStrategyName, ROUTE_STRATEGY_NAMES } from './model-route-policy';

function parsePriorityKey(key: string): number | null {
	const trimmed = key.trim();
	if (!trimmed) return null;
	if (!/^-?\d+$/.test(trimmed)) return null;
	const n = Number(trimmed);
	if (!Number.isSafeInteger(n)) return null;
	return n;
}

/**
 * 宽松解析：非法 JSON / 非对象 / 非法 key / 非法 strategy 均忽略；
 * 整体失败返回空 Map。
 */
export function parseRoutePoolTierStrategies(
	raw: string | null | undefined
): Map<number, RouteStrategyName> {
	const out = new Map<number, RouteStrategyName>();
	if (raw == null || raw.trim() === '') return out;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return out;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return out;
	}
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		const priority = parsePriorityKey(key);
		if (priority == null) continue;
		if (typeof value !== 'string' || !isRouteStrategyName(value)) continue;
		out.set(priority, value);
	}
	return out;
}

/**
 * Admin 写入前校验 + 规范化。
 * - null / 空串 / 空对象 → `null`（清列）
 * - 非法输入抛 Error
 * @returns 规范化 JSON 字符串或 null
 */
export function normalizeRoutePoolTierStrategiesInput(
	raw: string | null | undefined | Record<string, unknown>
): string | null {
	if (raw == null) return null;

	let obj: Record<string, unknown>;
	if (typeof raw === 'string') {
		if (raw.trim() === '') return null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error('tier_strategies must be valid JSON');
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('tier_strategies must be a JSON object');
		}
		obj = parsed as Record<string, unknown>;
	} else if (typeof raw === 'object' && !Array.isArray(raw)) {
		obj = raw;
	} else {
		throw new Error('tier_strategies must be a JSON object');
	}

	const out: Record<string, RouteStrategyName> = {};
	for (const [key, value] of Object.entries(obj)) {
		const priority = parsePriorityKey(key);
		if (priority == null) {
			throw new Error(`tier_strategies key "${key}" must be an integer priority`);
		}
		if (typeof value !== 'string' || !isRouteStrategyName(value)) {
			throw new Error(
				`tier_strategies["${priority}"] must be one of ${ROUTE_STRATEGY_NAMES.join(', ')}`
			);
		}
		out[String(priority)] = value;
	}

	if (Object.keys(out).length === 0) return null;
	return JSON.stringify(out);
}
