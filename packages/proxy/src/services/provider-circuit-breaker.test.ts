import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	getProviderCircuitRemainingMs,
	isProviderCircuitOpen,
	markProviderFailure,
	markProviderSuccess,
	parseRetryAfterMs,
	resetProviderCircuitStateForTests,
} from './provider-circuit-breaker';

beforeEach(() => {
	resetProviderCircuitStateForTests();
});

describe('parseRetryAfterMs', () => {
	it('parses seconds form', () => {
		assert.equal(parseRetryAfterMs('30'), 30_000);
		assert.equal(parseRetryAfterMs('0'), 0);
	});

	it('parses HTTP date form relative to now', () => {
		const now = Date.parse('2026-01-01T00:00:00Z');
		assert.equal(parseRetryAfterMs(new Date(now + 45_000).toUTCString(), now), 45_000);
		assert.equal(parseRetryAfterMs(new Date(now - 45_000).toUTCString(), now), 0);
	});

	it('returns null for missing or invalid values', () => {
		assert.equal(parseRetryAfterMs(null), null);
		assert.equal(parseRetryAfterMs(''), null);
		assert.equal(parseRetryAfterMs('soon'), null);
	});
});

describe('rate_limit failures', () => {
	it('honors upstream Retry-After when present', () => {
		const t0 = 1_000_000;
		const result = markProviderFailure('p', 'rate_limit', 5_000, t0);
		assert.equal(result.openedOrExtended, true);
		assert.equal(result.failureKind, 'rate_limit');
		assert.equal(result.cooldownMs, 5_000);
		assert.equal(getProviderCircuitRemainingMs('p', t0), 5_000);
		assert.equal(isProviderCircuitOpen('p', t0 + 5_001), false);
	});

	it('caps oversized Retry-After at 15min', () => {
		const t0 = 1_000_000;
		markProviderFailure('p', 'rate_limit', 3_600_000, t0);
		assert.equal(getProviderCircuitRemainingMs('p', t0), 900_000);
	});

	it('escalates backoff on consecutive 429s without Retry-After after each cooldown', () => {
		const t0 = 1_000_000;
		markProviderFailure('p', 'rate_limit', null, t0);
		assert.equal(getProviderCircuitRemainingMs('p', t0), 5_000);
		markProviderFailure('p', 'rate_limit', null, t0 + 5_001);
		assert.equal(getProviderCircuitRemainingMs('p', t0 + 5_001), 15_000);
		markProviderFailure('p', 'rate_limit', null, t0 + 20_002);
		assert.equal(getProviderCircuitRemainingMs('p', t0 + 20_002), 30_000);
		markProviderFailure('p', 'rate_limit', null, t0 + 50_003);
		assert.equal(getProviderCircuitRemainingMs('p', t0 + 50_003), 60_000);
		markProviderFailure('p', 'rate_limit', null, t0 + 110_004);
		assert.equal(getProviderCircuitRemainingMs('p', t0 + 110_004), 60_000);
	});

	it('does not escalate when multiple 429s arrive in the same open circuit window', () => {
		const t0 = 1_000_000;
		markProviderFailure('p', 'rate_limit', null, t0);
		assert.equal(getProviderCircuitRemainingMs('p', t0), 5_000);
		markProviderFailure('p', 'rate_limit', null, t0);
		markProviderFailure('p', 'rate_limit', null, t0);
		assert.equal(getProviderCircuitRemainingMs('p', t0), 5_000);
	});

	it('resets the escalation counter after a success', () => {
		const t0 = 1_000_000;
		markProviderFailure('p', 'rate_limit', null, t0);
		markProviderFailure('p', 'rate_limit', null, t0 + 5_001);
		markProviderSuccess('p', t0 + 20_002);
		markProviderFailure('p', 'rate_limit', null, t0 + 20_003);
		assert.equal(getProviderCircuitRemainingMs('p', t0 + 20_003), 5_000);
	});
});

describe('auth / server failures', () => {
	it('opens 5min for auth failures', () => {
		const t0 = 1_000_000;
		markProviderFailure('p', 'auth', null, t0);
		assert.equal(getProviderCircuitRemainingMs('p', t0), 300_000);
	});

	it('does not open circuit on first two server failures', () => {
		const t0 = 1_000_000;
		assert.equal(markProviderFailure('p', 'server', null, t0).openedOrExtended, false);
		assert.equal(getProviderCircuitRemainingMs('p', t0), 0);
		assert.equal(markProviderFailure('p', 'server', null, t0 + 1).openedOrExtended, false);
		assert.equal(getProviderCircuitRemainingMs('p', t0 + 1), 0);
	});

	it('opens 10s after three consecutive server failures', () => {
		const t0 = 1_000_000;
		markProviderFailure('p', 'server', null, t0);
		markProviderFailure('p', 'server', null, t0 + 1);
		const result = markProviderFailure('p', 'server', null, t0 + 2);
		assert.equal(result.openedOrExtended, true);
		assert.equal(result.cooldownMs, 10_000);
		assert.equal(getProviderCircuitRemainingMs('p', t0 + 2), 10_000);
		assert.equal(isProviderCircuitOpen('p', t0 + 12_001), false);
	});

	it('resets server failure count after a success', () => {
		const t0 = 1_000_000;
		markProviderFailure('p', 'server', null, t0);
		markProviderFailure('p', 'server', null, t0 + 1);
		markProviderSuccess('p', t0 + 2);
		markProviderFailure('p', 'server', null, t0 + 3);
		assert.equal(getProviderCircuitRemainingMs('p', t0 + 3), 0);
	});

	it('never shortens an already-open auth circuit when server failures arrive', () => {
		const t0 = 1_000_000;
		markProviderFailure('p', 'auth', null, t0);
		markProviderFailure('p', 'server', null, t0 + 1_000);
		markProviderFailure('p', 'server', null, t0 + 2_000);
		markProviderFailure('p', 'server', null, t0 + 3_000);
		assert.equal(getProviderCircuitRemainingMs('p', t0 + 3_000), 297_000);
	});
});

describe('markProviderSuccess', () => {
	it('is a no-op for unknown providers and clears expired entries', () => {
		markProviderSuccess('unknown');
		const t0 = 1_000_000;
		markProviderFailure('p', 'server', null, t0);
		markProviderFailure('p', 'server', null, t0 + 1);
		markProviderFailure('p', 'server', null, t0 + 2);
		markProviderSuccess('p', t0 + 12_001);
		assert.equal(isProviderCircuitOpen('p', t0 + 12_001), false);
	});
});
