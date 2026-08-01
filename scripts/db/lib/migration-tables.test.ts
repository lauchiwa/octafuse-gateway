/**
 * Contract tests for the ETL table manifest.
 *
 * The D1 -> Postgres cutover scripts drive their `SELECT * FROM <t>` / TRUNCATE
 * statements off `ETL_TABLE_ORDER`. Nothing else forces that list to stay in sync
 * with the schema, so a migration that adds or drops a table silently breaks the
 * cutover: a dropped table makes the ETL throw, and a new table is skipped
 * outright, losing data with no error at all.
 *
 * These tests derive the expected table set from the migration SQL itself, so the
 * manifest can no longer drift from the schema unnoticed.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { ETL_TABLE_ORDER, TABLE_CONFLICT_KEYS } from './migration-tables';

const MIGRATIONS_DIR = join(import.meta.dirname, '../../../packages/core/migrations-d1');

/** Tables created by the migration runner itself, never part of application ETL. */
const RUNNER_OWNED_TABLES = new Set(['d1_migrations', '_cf_METADATA']);

function readMigrations(): string {
	return readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith('.sql'))
		.sort()
		.map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
		.join('\n');
}

function stripComments(sql: string): string {
	return sql.replace(/--[^\n]*/g, '');
}

/** Tables that exist after every migration has run: CREATEd minus DROPped. */
function liveTables(sql: string): Set<string> {
	const created = new Set<string>();
	const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z0-9_]+)["'`]?/gi;
	for (const m of sql.matchAll(createRe)) created.add(m[1]);

	const dropRe = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?([A-Za-z0-9_]+)["'`]?/gi;
	for (const m of sql.matchAll(dropRe)) created.delete(m[1]);

	for (const t of RUNNER_OWNED_TABLES) created.delete(t);
	return created;
}

/** child table -> set of parent tables it references via a foreign key. */
function foreignKeys(sql: string): Map<string, Set<string>> {
	const fks = new Map<string, Set<string>>();
	const add = (child: string, parent: string) => {
		if (child === parent) return; // self-reference imposes no ordering constraint
		if (!fks.has(child)) fks.set(child, new Set());
		fks.get(child)!.add(parent);
	};

	// REFERENCES inside a CREATE TABLE body.
	const createBlockRe =
		/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z0-9_]+)["'`]?\s*\(([\s\S]*?)\n\s*\);/gi;
	for (const block of sql.matchAll(createBlockRe)) {
		const child = block[1];
		for (const ref of block[2].matchAll(/REFERENCES\s+["'`]?([A-Za-z0-9_]+)["'`]?/gi)) {
			add(child, ref[1]);
		}
	}

	// REFERENCES introduced by a later ALTER TABLE ... ADD COLUMN.
	const alterRe =
		/ALTER\s+TABLE\s+["'`]?([A-Za-z0-9_]+)["'`]?\s+ADD\s+COLUMN[^;]*?REFERENCES\s+["'`]?([A-Za-z0-9_]+)["'`]?/gi;
	for (const m of sql.matchAll(alterRe)) add(m[1], m[2]);

	return fks;
}

const sql = stripComments(readMigrations());

test('ETL_TABLE_ORDER matches the tables that exist after all migrations', () => {
	const expected = [...liveTables(sql)].sort();
	const actual = [...ETL_TABLE_ORDER].sort();

	// Reported as a set difference so a failure names the offending table directly.
	const missing = expected.filter((t) => !actual.includes(t));
	const extra = actual.filter((t) => !expected.includes(t));

	assert.deepEqual(
		{ missing, extra },
		{ missing: [], extra: [] },
		`ETL_TABLE_ORDER drifted from the schema.\n` +
			`  missing (in migrations, absent from manifest -> data silently not migrated): ${JSON.stringify(missing)}\n` +
			`  extra (in manifest, not in schema -> cutover will throw): ${JSON.stringify(extra)}`
	);
});

test('ETL_TABLE_ORDER lists every parent before its children', () => {
	const position = new Map(ETL_TABLE_ORDER.map((t, i) => [t as string, i]));
	const violations: string[] = [];

	for (const [child, parents] of foreignKeys(sql)) {
		const childPos = position.get(child);
		if (childPos === undefined) continue; // not an ETL table
		for (const parent of parents) {
			const parentPos = position.get(parent);
			if (parentPos === undefined) continue;
			if (parentPos > childPos) {
				violations.push(`${child} (#${childPos}) references ${parent} (#${parentPos})`);
			}
		}
	}

	assert.deepEqual(
		violations,
		[],
		`Foreign-key ordering violated — inserts would fail:\n  ${violations.join('\n  ')}`
	);
});

test('TABLE_CONFLICT_KEYS covers exactly the ETL tables', () => {
	assert.deepEqual(
		Object.keys(TABLE_CONFLICT_KEYS).sort(),
		[...ETL_TABLE_ORDER].sort(),
		'every ETL table needs a conflict key for the upsert, and vice versa'
	);
});

test('every conflict key is a non-empty column list', () => {
	for (const [table, keys] of Object.entries(TABLE_CONFLICT_KEYS)) {
		assert.ok(keys.length > 0, `${table} has no conflict key`);
		assert.deepEqual(keys, [...new Set(keys)], `${table} has duplicate conflict columns`);
	}
});
