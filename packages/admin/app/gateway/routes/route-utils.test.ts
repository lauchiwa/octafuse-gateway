import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayModel, GatewayProvider } from '@/lib/types';
import {
	factorChipClassForValue,
	factorLevelForValue,
	hasBasePricingInversion,
	requestOperationsForModel,
	resolveEffectiveRouteStrategy,
	splitRoutesByProtocolAndRouteGroup,
	upstreamOperationsForProviderModel,
} from './route-utils';

function model(overrides: Partial<GatewayModel> = {}): GatewayModel {
	return {
		id: 'model-1',
		display_name: 'Model 1',
		vendor: 'other',
		context_window: 128_000,
		max_tokens: 4096,
		tags: '[]',
		description: null,
		metadata: null,
		created_at: '',
		...overrides,
	};
}

function provider(endpoints: object): GatewayProvider {
	return {
		id: 'provider-1',
		name: 'Provider 1',
		endpoints: JSON.stringify(endpoints),
		description: null,
		created_at: '',
	};
}

describe('route form capability filters', () => {
	it('limits public operations by model modality', () => {
		assert.deepEqual(requestOperationsForModel(model(), 'openai'), ['chat', 'responses']);
		assert.deepEqual(
			requestOperationsForModel(
				model({ input_modalities: '["text","image"]', output_modalities: '["image"]' }),
				'openai'
			),
			['images.generations', 'images.edits']
		);
		assert.deepEqual(
			requestOperationsForModel(
				model({
					input_modalities: '["audio"]',
					output_modalities: '["text"]',
					pricing_profile: JSON.stringify({
						audio_billing_mode: 'per_second',
						audio: { price_per_second: 0.0001, minimum_seconds: 1 },
					}),
				}),
				'openai'
			),
			['audio.transcriptions']
		);
	});

	it('intersects provider endpoint capabilities with the model modality', () => {
		const baseProvider = provider({ openai: { base: 'https://example.com/v1' } });
		assert.deepEqual(upstreamOperationsForProviderModel(baseProvider, model(), 'openai'), [
			'chat',
		]);
		assert.deepEqual(
			upstreamOperationsForProviderModel(
				baseProvider,
				model({ input_modalities: '["text","image"]', output_modalities: '["image"]' }),
				'openai'
			),
			['images.generations', 'images.edits']
		);

		const endpointOnlyProvider = provider({
			openai: {
				endpoints: {
					'images.edits': 'https://example.com/v1/images/edits',
				},
			},
		});
		assert.deepEqual(
			upstreamOperationsForProviderModel(
				endpointOnlyProvider,
				model({ input_modalities: '["text","image"]', output_modalities: '["image"]' }),
				'openai'
			),
			['images.edits']
		);
	});
});

describe('route factor presentation', () => {
	it('classifies distance from the catalog baseline', () => {
		assert.equal(factorLevelForValue(Number.NaN), 'invalid');
		assert.equal(factorLevelForValue(-1), 'invalid');
		assert.equal(factorLevelForValue(0), 'zero');
		assert.equal(factorLevelForValue(0.79), 'veryLow');
		assert.equal(factorLevelForValue(0.8), 'low');
		assert.equal(factorLevelForValue(0.95), 'baseline');
		assert.equal(factorLevelForValue(1.05), 'baseline');
		assert.equal(factorLevelForValue(1.06), 'high');
		assert.equal(factorLevelForValue(1.2), 'high');
		assert.equal(factorLevelForValue(1.21), 'veryHigh');
	});

	it('uses different low-factor semantics for charged price and metered cost', () => {
		assert.match(factorChipClassForValue(0.9, 'charged'), /bg-sky-100/);
		assert.match(factorChipClassForValue(0.9, 'metered'), /bg-emerald-100/);
		assert.match(factorChipClassForValue(0.5, 'charged'), /bg-orange-100/);
		assert.match(factorChipClassForValue(0.5, 'metered'), /bg-emerald-200/);
		assert.match(factorChipClassForValue(1, 'charged'), /bg-zinc-100/);
		assert.match(factorChipClassForValue(1.1, 'metered'), /bg-amber-100/);
		assert.match(factorChipClassForValue(1.5, 'metered'), /bg-rose-100/);
	});

	it('flags a base-price inversion only when charged is below metered', () => {
		assert.equal(hasBasePricingInversion(0.9, 1), true);
		assert.equal(hasBasePricingInversion(1, 1), false);
		assert.equal(hasBasePricingInversion(1.1, 1), false);
		assert.equal(hasBasePricingInversion(Number.NaN, 1), false);
	});
});

describe('resolveEffectiveRouteStrategy', () => {
	it('prefers tier override over pool strategy', () => {
		const effective = resolveEffectiveRouteStrategy({
			poolStrategy: 'weighted_random',
			poolTierStrategies: JSON.stringify({ '10': 'weight_priority' }),
			priority: 10,
			protocol: 'openai',
			requestOperation: 'chat',
			routeGroup: 'default',
			globalStrategy: 'hash_affinity',
		});
		assert.deepEqual(effective, {
			strategy: 'weight_priority',
			source: 'tier',
			inherited: false,
		});
	});

	it('inherits pool strategy when the tier has no override', () => {
		const effective = resolveEffectiveRouteStrategy({
			poolStrategy: 'weighted_random',
			poolTierStrategies: JSON.stringify({ '0': 'weight_priority' }),
			priority: 10,
			protocol: 'openai',
			requestOperation: 'chat',
			routeGroup: 'default',
			globalStrategy: 'hash_affinity',
		});
		assert.deepEqual(effective, {
			strategy: 'weighted_random',
			source: 'pool',
			inherited: true,
		});
	});

	it('falls back through model / global when pool is unset', () => {
		const effective = resolveEffectiveRouteStrategy({
			priority: 1,
			routePolicyRaw: JSON.stringify({ strategy: 'weighted_round_robin' }),
			protocol: 'openai',
			requestOperation: 'chat',
			routeGroup: 'default',
			globalStrategy: 'hash_affinity',
		});
		assert.deepEqual(effective, {
			strategy: 'weighted_round_robin',
			source: 'model',
			inherited: true,
		});
	});
});

describe('provider sticky pool mapping', () => {
	it('maps pool sticky columns onto protocol sections with defaults', () => {
		const sections = splitRoutesByProtocolAndRouteGroup([
			{
				id: 'r1',
				route_pool_id: 'pool-1',
				pool_name: 'Pool',
				route_group: 'default',
				upstream_protocol: 'openai',
				pool_sticky_enabled: 1,
				pool_sticky_idle_ttl_seconds: 1800,
				surfaces: JSON.stringify([
					{
						id: 'surf-1',
						request_protocol: 'openai',
						request_operation: 'chat',
						status: 'active',
					},
				]),
			},
			{
				id: 'r2',
				route_pool_id: 'pool-2',
				pool_name: 'Pool 2',
				route_group: 'default',
				upstream_protocol: 'openai',
				pool_sticky_enabled: 0,
				pool_sticky_idle_ttl_seconds: null,
				surfaces: JSON.stringify([
					{
						id: 'surf-2',
						request_protocol: 'openai',
						request_operation: 'chat',
						status: 'active',
					},
				]),
			},
		]);
		const stickyOn = sections.find((s) => s.poolId === 'pool-1');
		const stickyOff = sections.find((s) => s.poolId === 'pool-2');
		assert.equal(stickyOn?.poolStickyEnabled, true);
		assert.equal(stickyOn?.poolStickyIdleTtlSeconds, 1800);
		assert.equal(stickyOff?.poolStickyEnabled, false);
		assert.equal(stickyOff?.poolStickyIdleTtlSeconds, 3600);
	});
});
