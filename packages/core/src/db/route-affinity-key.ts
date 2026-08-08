/**
 * Affinity key helpers shared by Proxy sticky routing and Admin lookup.
 * affinityKey = userId|baseModelId|routeGroup|protocol (no capability).
 */

/** Build the plaintext affinity key used for sticky + hash_affinity scoring. */
export function buildAffinityKey(
	userId: string,
	baseModelId: string,
	routeGroup: string,
	protocol: string
): string {
	return `${userId}|${baseModelId}|${routeGroup}|${protocol}`;
}

/** SHA-256 hex digest of an affinity key (stored as `affinity_hash`). */
export async function hashAffinityKey(affinityKey: string): Promise<string> {
	const data = new TextEncoder().encode(affinityKey);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
