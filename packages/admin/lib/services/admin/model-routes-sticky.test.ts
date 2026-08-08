import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import { updateRoutePoolPolicyService } from './model-routes-service';

describe('updateRoutePoolPolicyService sticky_routing', () => {
	it('accepts sticky_routing and writes sticky fields', async () => {
		const updateRoutePoolPolicy = mock.fn(async () => 1);
		const repos = {
			routes: { updateRoutePoolPolicy },
		} as unknown as GatewayRepositories;

		await updateRoutePoolPolicyService(repos, 'pool-1', {
			sticky_routing: { enabled: true, idle_ttl_seconds: 7200 },
		});

		assert.equal(updateRoutePoolPolicy.mock.callCount(), 1);
		// mock.fn() 推导出的 arguments 元组为空，索引访问会报 TS2493；
		// 上游不对 test 文件做 typecheck，故未暴露。断言语义不变。
		const [, policyArg] = updateRoutePoolPolicy.mock.calls[0]?.arguments as unknown as [
			unknown,
			unknown,
		];
		assert.deepEqual(policyArg, {
			stickyEnabled: true,
			stickyIdleTtlSeconds: 7200,
		});
	});

	it('rejects out-of-range idle_ttl_seconds', async () => {
		const repos = {
			routes: { updateRoutePoolPolicy: mock.fn(async () => 1) },
		} as unknown as GatewayRepositories;

		await assert.rejects(
			() =>
				updateRoutePoolPolicyService(repos, 'pool-1', {
					sticky_routing: { enabled: true, idle_ttl_seconds: 10 },
				}),
			(err: unknown) => {
				assert.ok(err && typeof err === 'object' && 'status' in err);
				assert.equal((err as { status: number }).status, 400);
				return true;
			}
		);
	});
});
