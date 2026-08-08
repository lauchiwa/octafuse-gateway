import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	DEFAULT_STICKY_IDLE_TTL_SECONDS,
	MAX_STICKY_IDLE_TTL_SECONDS,
	MIN_STICKY_IDLE_TTL_SECONDS,
	clampStickyIdleTtlSeconds,
	coerceStickyEnabled,
	formatStickyIdleTtlShort,
	normalizeStickyRoutingInput,
	parseRoutePoolStickyConfig,
} from './route-pool-sticky-types';

describe('route-pool-sticky-types', () => {
	it('coerces sticky enabled from boolean/number/string', () => {
		assert.equal(coerceStickyEnabled(true), true);
		assert.equal(coerceStickyEnabled(1), true);
		assert.equal(coerceStickyEnabled('true'), true);
		assert.equal(coerceStickyEnabled(false), false);
		assert.equal(coerceStickyEnabled(0), false);
		assert.equal(coerceStickyEnabled('off'), false);
	});

	it('clamps idle TTL into allowed range', () => {
		assert.equal(clampStickyIdleTtlSeconds(30), MIN_STICKY_IDLE_TTL_SECONDS);
		assert.equal(clampStickyIdleTtlSeconds(999_999), MAX_STICKY_IDLE_TTL_SECONDS);
		assert.equal(clampStickyIdleTtlSeconds('3600'), 3600);
		assert.equal(clampStickyIdleTtlSeconds('x'), DEFAULT_STICKY_IDLE_TTL_SECONDS);
	});

	it('parses pool sticky config defaults', () => {
		assert.deepEqual(parseRoutePoolStickyConfig({}), {
			enabled: false,
			idleTtlSeconds: DEFAULT_STICKY_IDLE_TTL_SECONDS,
			epoch: 0,
		});
		assert.deepEqual(
			parseRoutePoolStickyConfig({
				stickyEnabled: 1,
				stickyIdleTtlSeconds: 7200,
				stickyEpoch: 3,
			}),
			{ enabled: true, idleTtlSeconds: 7200, epoch: 3 }
		);
	});

	it('normalizes sticky_routing admin input', () => {
		assert.deepEqual(normalizeStickyRoutingInput({ enabled: true }), {
			enabled: true,
			idle_ttl_seconds: DEFAULT_STICKY_IDLE_TTL_SECONDS,
		});
		assert.deepEqual(
			normalizeStickyRoutingInput({ enabled: false, idle_ttl_seconds: 120 }),
			{ enabled: false, idle_ttl_seconds: 120 }
		);
		assert.throws(() => normalizeStickyRoutingInput(null), /object/);
		assert.throws(() => normalizeStickyRoutingInput({ enabled: true, idle_ttl_seconds: 10 }), /between/);
	});

	it('formats short TTL labels', () => {
		assert.equal(formatStickyIdleTtlShort(3600), '1h');
		assert.equal(formatStickyIdleTtlShort(1800), '30m');
		assert.equal(formatStickyIdleTtlShort(90), '90s');
	});
});
