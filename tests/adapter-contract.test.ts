import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { pgTable, integer, text } from 'drizzle-orm/pg-core';
import { mysqlTable, int, varchar } from 'drizzle-orm/mysql-core';
import { DrizzleProxyClient } from '../src/index';
import { drizzle as postgres } from '../src/postgresql';
import { drizzle as mysql } from '../src/mysql';

// Schema construction belongs to adapter setup. Business operations below are shared.
const fixtures = [
  { name: 'postgresql', create: postgres, users: pgTable('users', { id: integer().primaryKey(), name: text() }) },
  { name: 'mysql', create: mysql, users: mysqlTable('users', { id: int().primaryKey(), name: varchar({ length: 100 }) }) },
];

// Runtime contract deliberately accepts both native dialects. It does not claim
// their complete TypeScript APIs, schemas, or raw execute() result shapes are equal.
async function businessFlow(db: any, users: any) {
  await db.insert(users).values({ id: 1, name: 'Ada' });
  const prepared = db.select().from(users).where(eq(users.id, sql.placeholder('id'))).prepare('by_id');
  assert.deepEqual(await prepared.execute({ id: 1 }), [{ id: 1, name: 'Ada' }]);
  await db.update(users).set({ name: 'Grace' }).where(eq(users.id, 1));
  await db.delete(users).where(eq(users.id, 1));
  await db.transaction(async (tx: any) => {
    await tx.insert(users).values({ id: 2, name: 'committed' });
    await tx.transaction(async (nested: any) => { await nested.update(users).set({ name: 'nested' }).where(eq(users.id, 2)); });
  });
  await assert.rejects(db.transaction(async (tx: any) => {
    await tx.insert(users).values({ id: 3, name: 'rolled back' });
    tx.rollback();
  }), /Rollback/);
}

for (const fixture of fixtures) {
  test(`${fixture.name}: shared ORM business flow uses HTTP and adapter-generated parameters`, async () => {
    const original = globalThis.fetch;
    const requests: any[] = [];
    globalThis.fetch = async (url, init) => {
      assert.equal(new URL(String(url)).origin, 'https://proxy.test');
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(url), ...body });
      const select = /^select\b/i.test(body.sql ?? '');
      return new Response(JSON.stringify({ success: true, data: {
        rows: select ? [[1, 'Ada']] : [], fields: [], rowCount: select ? 1 : 0,
        ...(fixture.name === 'mysql' && !select ? { affectedRows: 1, insertId: 1 } : {}),
      } }), { headers: { 'content-type': 'application/json' } });
    };
    try {
      const client = new DrizzleProxyClient({ endpoint: 'https://proxy.test/api/query', key: fixture.name, token: 'test' });
      await businessFlow(fixture.create(client), fixture.users);
      const insert = requests.find(r => /^insert/i.test(r.sql ?? ''));
      assert.deepEqual(insert.params, [1, 'Ada']);
      assert.ok(!insert.sql.includes('Ada'));
      assert.ok(insert.sql.includes(fixture.name === 'postgresql' ? '$1' : '?'));
      const commits = requests.filter(r => r.sql === 'commit');
      assert.equal(commits.length, 1);
      const releases = requests.filter(r => r.url.endsWith('/release'));
      assert.equal(releases.length, 1);
      const begins = requests.filter(r => r.sql === 'begin');
      assert.equal(begins.length, 2);
      assert.equal(commits[0].transaction_id, begins[0].transaction_id);
      assert.equal(releases[0].transaction_id, begins[1].transaction_id);
    } finally { globalThis.fetch = original; }
  });
}

test.todo('oracle: shared ORM business flow requires select/insert/update/delete and compatible schema/row mapping; SQL adapter tests do not satisfy this contract');
