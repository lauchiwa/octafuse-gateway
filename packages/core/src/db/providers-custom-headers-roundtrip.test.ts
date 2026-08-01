/**
 * 三驱动 provider round-trip：insertProvider(customHeaders) → getProviderById/listProviders
 * 必须带出 `custom_headers`。用轻量假 client（无内存 DB 依赖），只校验列布线与
 * 行映射（camelCase `customHeaders` ↔ snake_case `custom_headers`），不校验真实 SQL 语义。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createD1ProvidersRepository } from './d1/providers.impl';
import { createPostgresProvidersRepository } from './postgres/providers.impl';
import { createMySqlProvidersRepository } from './mysql/providers.impl';
import type { D1DatabaseClient, PostgresDatabaseClient, MySqlDatabaseClient } from '../storage/database-client';

const CUSTOM_HEADERS_JSON = JSON.stringify({ openai: { 'User-Agent': 'myapp/1.0' } });

/** 假 D1 raw：按 INSERT 绑定顺序建行，SELECT * 回放 snake_case 行。 */
function fakeD1Client(): { client: D1DatabaseClient } {
	const store = new Map<string, Record<string, unknown>>();
	const raw = {
		prepare(sql: string) {
			let bound: unknown[] = [];
			const stmt = {
				bind(...args: unknown[]) {
					bound = args;
					return stmt;
				},
				async run() {
					if (/^\s*INSERT\s+INTO\s+providers/i.test(sql)) {
						// 列顺序：id, name, endpoints, api_key, status, description, custom_headers
						const [id, name, endpoints, apiKey, status, description, customHeaders] = bound;
						store.set(String(id), {
							id,
							name,
							endpoints,
							api_key: apiKey,
							status,
							description,
							custom_headers: customHeaders,
							created_at: '2026-01-01T00:00:00.000Z',
						});
					}
					return { meta: { changes: 1 } };
				},
				async first<T>() {
					if (/SELECT \* FROM providers WHERE id/i.test(sql)) {
						return (store.get(String(bound[0])) ?? null) as T | null;
					}
					return null;
				},
				async all<T>() {
					return { results: Array.from(store.values()) as T[] };
				},
			};
			return stmt;
		},
	};
	return { client: { driver: 'd1', raw, drizzle: {} } as unknown as D1DatabaseClient };
}

/**
 * 假 drizzle：`insert(table).values(obj)` 存 camelCase 行；`select().from().where().limit()`
 * 返回 thenable，await 得到已存行。忽略 eq/desc 条件（单行 round-trip 足够）。
 */
function fakeDrizzleClient(): { drizzle: unknown; rows: Record<string, unknown>[] } {
	const rows: Record<string, unknown>[] = [];
	const selectBuilder = () => {
		const builder: Record<string, unknown> = {};
		for (const m of ['from', 'where', 'limit', 'orderBy']) {
			builder[m] = () => builder;
		}
		builder.then = (resolve: (v: unknown) => unknown) => resolve(rows);
		return builder;
	};
	const drizzle = {
		insert() {
			return {
				async values(obj: Record<string, unknown>) {
					rows.push(obj);
				},
			};
		},
		select() {
			return selectBuilder();
		},
	};
	return { drizzle, rows };
}

describe('providers custom_headers round-trip (three drivers)', () => {
	it('D1: insertProvider carries custom_headers into getProviderById', async () => {
		const { client } = fakeD1Client();
		const repo = createD1ProvidersRepository(client);
		await repo.insertProvider({
			id: 'p1',
			name: 'P1',
			endpoints: null,
			description: null,
			customHeaders: CUSTOM_HEADERS_JSON,
		});
		const row = await repo.getProviderById('p1');
		assert.equal(row?.custom_headers, CUSTOM_HEADERS_JSON);
	});

	it('D1: insertProvider defaults custom_headers to null when omitted', async () => {
		const { client } = fakeD1Client();
		const repo = createD1ProvidersRepository(client);
		await repo.insertProvider({ id: 'p2', name: 'P2', endpoints: null, description: null });
		const row = await repo.getProviderById('p2');
		assert.equal(row?.custom_headers, null);
	});

	it('Postgres: insert + getProviderById maps customHeaders → custom_headers', async () => {
		const { drizzle } = fakeDrizzleClient();
		const repo = createPostgresProvidersRepository({ driver: 'postgres', drizzle } as unknown as PostgresDatabaseClient);
		await repo.insertProvider({
			id: 'p1',
			name: 'P1',
			endpoints: null,
			description: null,
			customHeaders: CUSTOM_HEADERS_JSON,
		});
		const row = await repo.getProviderById('p1');
		assert.equal(row?.custom_headers, CUSTOM_HEADERS_JSON);
		const listed = await repo.listProviders();
		assert.equal(listed[0]?.custom_headers, CUSTOM_HEADERS_JSON);
	});

	it('MySQL: insert + getProviderById maps customHeaders → custom_headers', async () => {
		const { drizzle } = fakeDrizzleClient();
		const repo = createMySqlProvidersRepository({
			driver: 'mysql',
			drizzle,
			raw: {},
		} as unknown as MySqlDatabaseClient);
		await repo.insertProvider({
			id: 'p1',
			name: 'P1',
			endpoints: null,
			description: null,
			customHeaders: CUSTOM_HEADERS_JSON,
		});
		const row = await repo.getProviderById('p1');
		assert.equal(row?.custom_headers, CUSTOM_HEADERS_JSON);
		const listed = await repo.listProviders();
		assert.equal(listed[0]?.custom_headers, CUSTOM_HEADERS_JSON);
	});
});
