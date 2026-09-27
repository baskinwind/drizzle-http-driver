// Opt-in integration test against drizzle-proxy and the documented lab accounts.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { and, asc, count, eq, relations, sql } from 'drizzle-orm';
import { bigint, boolean, date, datetime, decimal, int, json, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core';
import { DrizzleProxyClient } from '../src/index';
import { drizzle as drizzleMySql } from '../src/mysql';
import { drizzle as drizzleOracle, oracleBind } from '../src/oracle';

if (process.env.TEST_DIALECT && !['mysql', 'oracle'].includes(process.env.TEST_DIALECT)) {
  throw new Error('Use tests/run-remote.ts for PostgreSQL; TEST_DIALECT must be mysql or oracle here');
}

const proxyRoot = process.env.DRIZZLE_PROXY_ROOT ?? resolve(import.meta.dirname, '../../drizzle-proxy');
const proxyRequire = createRequire(resolve(proxyRoot, 'server/package.json'));
const { serve } = proxyRequire('@hono/node-server');
const { Hono } = proxyRequire('hono');
const load = (file: string) => import(pathToFileURL(resolve(proxyRoot, file)).href);
const doc = await readFile(resolve(proxyRoot, 'docs/database-connections.md'), 'utf8');
const password = (label: string) => {
  const value = doc.match(new RegExp(`${label} 密码：\u0060([^\u0060]+)\u0060`))?.[1];
  assert.ok(value, `Missing credentials: ${label}`); return value;
};
Object.assign(process.env, {
  DATABASE_HOST: 'db.baskwind.dev', DATABASE_PORT: '5432', DATABASE_NAME: 'postgres',
  DATABASE_USER: 'workbench_lab', DATABASE_PASS: password('PostgreSQL workbench_lab'),
  ENCRYPTION_KEY: randomUUID(), ADMIN_USERNAME: 'test', ADMIN_PASSWORD_HASH: 'test', ADMIN_SESSION_SECRET: randomUUID(),
  QUERY_TIMEOUT_MS: '2500', POOL_CONNECTION_TIMEOUT_MS: '30000',
});
const { dbPool } = await load('server/drizzle/client.ts');
Object.assign(dbPool.options, { max: 1, idleTimeoutMillis: 0, connectionTimeoutMillis: 30000, ssl: { rejectUnauthorized: false } });
const { encryptSecret } = await load('server/src/util/crypto.ts');
const { buildDatabaseUrl } = await load('server/src/util/database.ts');
const { query } = await load('server/src/router/query.ts');
const { config } = await load('server/src/config.ts');
const { closeAllTransactionSessions } = await load('server/src/proxy/executor.ts');
const { closeAllTenantPools } = await load('server/src/proxy/pool-manager.ts');
const { createRelay } = await load('server/tests/tcp-relay.ts');
const token = randomUUID(), prefix = `dh_${Date.now().toString(36)}`;
const fixtures = [
  { dialect: 'mysql', host: 'db.baskwind.dev', port: 3306, name: 'workbench_lab', user: 'workbench_lab', pass: password('MySQL workbench_lab'), sslmode: 'require' },
  { dialect: 'oracle', host: 'db.baskwind.dev', port: 1521, name: 'FREEPDB1', user: 'WORKBENCH_LAB', pass: password('Oracle WORKBENCH_LAB'), sslmode: 'disable', oracle: { schema: 'WORKBENCH_LAB', connectionType: 'service' } },
].filter(f => !process.env.TEST_DIALECT || process.env.TEST_DIALECT === f.dialect);
const relays = new Map<string, any>();
const requests: any[] = [];
let loseCommitResponse = false;
const app = new Hono();
app.use('*', async (c: any, next: () => Promise<void>) => {
  const body = await c.req.raw.clone().json(); requests.push({ path: c.req.path, ...body });
  await next();
  if (loseCommitResponse && body.sql?.toLowerCase() === 'commit') {
    loseCommitResponse = false;
    c.res = new Response(JSON.stringify({ success: false, error: 'Injected lost commit acknowledgement' }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
});
app.route('/api/query', query);
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
await new Promise<void>(r => server.listening ? r() : server.once('listening', r));
const results: { label: string; passed: boolean; ms: number; error?: string }[] = [];
async function test(label: string, action: () => Promise<void>) {
  if (process.env.TEST_CASE && !new RegExp(process.env.TEST_CASE).test(label)) return;
  const start = Date.now();
  try { await action(); results.push({ label, passed: true, ms: Date.now() - start }); console.log(`PASS ${label} (${Date.now() - start}ms)`); }
  catch (error) { const message = error instanceof Error ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ''}` : String(error); results.push({ label, passed: false, ms: Date.now() - start, error: message }); console.log(`FAIL ${label}: ${message}`); }
  finally { await closeAllTransactionSessions(); }
}
const strange = "中文🙂 ' ? $1 :1 \\ '); DROP TABLE x; --";
console.log(`RUN fixture=${prefix}; dialects=${fixtures.map(f => f.dialect)}; driver=local source; ORM=0.45.2`);
try {
  const migration = await readFile(resolve(proxyRoot, 'server/drizzle/migrations/0000_worthless_ted_forrester.sql'), 'utf8');
  for (const statement of migration.split('--> statement-breakpoint')) if (statement.trim().startsWith('CREATE TABLE')) await dbPool.query(statement.replace('CREATE TABLE', 'CREATE TEMP TABLE'));
  await dbPool.query("ALTER TABLE pg_temp.databases ADD COLUMN dialect text NOT NULL DEFAULT 'postgresql'");
  await dbPool.query('INSERT INTO pg_temp.tenants(id,name) VALUES ($1,$1)', [prefix]);
  await dbPool.query('INSERT INTO pg_temp.tokens(name,token,tenant_id) VALUES ($1,$2,$1)', [prefix, token]);
  for (const f of fixtures) {
    const relay = await createRelay(f.host, f.port); relays.set(f.dialect, relay);
    await dbPool.query('INSERT INTO pg_temp.databases(tenant_id,key,dialect,url,pool_max) VALUES ($1,$2,$2,$3,2)', [prefix, f.dialect, encryptSecret(buildDatabaseUrl({ ...f, host: '127.0.0.1', port: relay.port }))]);
    const client = new DrizzleProxyClient({ endpoint: `http://127.0.0.1:${server.address().port}/api/query`, token, key: f.dialect });
    await test(`${f.dialect}: transaction options protocol rejects invalid requests`, async () => {
      const endpoint = `http://127.0.0.1:${server.address().port}/api/query`;
      const invalid = [
        { sql: 'select 1', transaction_id: randomUUID(), transaction_options: { isolationLevel: 'read committed' } },
        { sql: 'begin', transaction_options: { isolationLevel: 'read committed' } },
        { sql: 'begin', transaction_id: randomUUID(), transaction_options: { isolationLevel: 'not valid' } },
        { sql: 'begin', params: [1], transaction_id: randomUUID(), transaction_options: {} },
        { sql: 'begin ignored clause', transaction_id: randomUUID(), transaction_options: {} },
        { sql: 'begin', transaction_id: randomUUID(), transaction_options: { extra: 'ignored?' } },
      ];
      if (f.dialect === 'oracle') invalid.push({ sql: 'begin', transaction_id: randomUUID(), transaction_options: {} });
      for (const body of invalid) {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-db-token': token }, body: JSON.stringify({ key: f.dialect, ...body }) });
        assert.equal(response.status, 400);
      }
    });
    const controller = new AbortController();
    const cancellable = new DrizzleProxyClient({ endpoint: `http://127.0.0.1:${server.address().port}/api/query`, token, key: f.dialect, requestInit: { signal: controller.signal } });
    if (f.dialect === 'mysql') await mysqlTests(client, relay, cancellable, controller);
    else { config.QUERY_TIMEOUT_MS = 15000; await oracleTests(client, relay, cancellable, controller); }
  }
} finally {
  await closeAllTransactionSessions(); await closeAllTenantPools(); await dbPool.end();
  for (const relay of relays.values()) await relay.close();
  await new Promise<void>((r, reject) => server.close((error: unknown) => error ? reject(error) : r()));
}
console.log(JSON.stringify({ passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length, requests: requests.length }));
if (process.env.TEST_REPORT) await writeFile(process.env.TEST_REPORT, JSON.stringify({ fixture: prefix, results }, null, 2));
process.exitCode = results.length === 0 || results.some(r => !r.passed) ? 1 : 0;

async function mysqlTests(client: DrizzleProxyClient, relay: any, cancellable: DrizzleProxyClient, controller: AbortController) {
  const users = mysqlTable(`${prefix}_users`, { id: int().primaryKey().autoincrement(), name: varchar({ length: 1000 }).notNull(), nick: text(), enabled: boolean().notNull().default(true) });
  const posts = mysqlTable(`${prefix}_posts`, { id: int().primaryKey(), userId: int('user_id'), title: text().notNull() });
  const types = mysqlTable(`${prefix}_types`, { id: int().primaryKey(), big: bigint({ mode: 'bigint' }), amount: decimal({ precision: 30, scale: 10 }), obj: json(), precise: datetime({ mode: 'string', fsp: 6 }), moment: datetime({ mode: 'date', fsp: 3 }), day: date({ mode: 'string' }) });
  const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
  const postsRelations = relations(posts, ({ one }) => ({ author: one(users, { fields: [posts.userId], references: [users.id] }) }));
  const db = drizzleMySql(client, { schema: { users, posts, usersRelations, postsRelations } });
  const absent = async (id: number) => assert.deepEqual(await db.select().from(users).where(eq(users.id, id)), []);
  try {
    await client.query(`CREATE TABLE ${prefix}_users(id INTEGER PRIMARY KEY AUTO_INCREMENT, name VARCHAR(1000) NOT NULL, nick TEXT, enabled BOOLEAN NOT NULL DEFAULT true) ENGINE=InnoDB`);
    await client.query(`CREATE TABLE ${prefix}_posts(id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT NOT NULL) ENGINE=InnoDB`);
    await client.query(`CREATE TABLE ${prefix}_types(id INTEGER PRIMARY KEY, big BIGINT, amount DECIMAL(30,10), obj JSON, precise DATETIME(6), moment DATETIME(3), day DATE) ENGINE=InnoDB`);
    await db.insert(users).values([{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace', enabled: false }]);
    await db.insert(posts).values([{ id: 11, userId: 1, title: 'one' }, { id: 12, userId: 1, title: 'two' }]);
    await test('mysql: CRUD, auto generated IDs, null, upsert and delete headers', async () => {
      const ids = await db.insert(users).values([{ name: strange }, { name: 'auto2' }]).$returningId();
      assert.equal(ids.length, 2); assert.equal(ids[1].id, ids[0].id + 1);
      assert.deepEqual((await db.select().from(users).where(eq(users.id, ids[0].id)))[0], { id: ids[0].id, name: strange, nick: null, enabled: true });
      assert.equal((await db.update(users).set({ name: 'updated' }).where(eq(users.id, ids[0].id)))[0].affectedRows, 1);
      await db.insert(users).values({ id: ids[0].id, name: 'upsert' }).onDuplicateKeyUpdate({ set: { name: 'upsert' } });
      assert.equal((await db.select().from(users).where(eq(users.id, ids[0].id)))[0].name, 'upsert');
      for (const id of ids) assert.equal((await db.delete(users).where(eq(users.id, id.id)))[0].affectedRows, 1);
    });
    await test('mysql: prepared repeated placeholders, reuse and missing rejection', async () => {
      const p = db.select().from(users).where(and(eq(users.id, sql.placeholder('id')), eq(users.id, sql.placeholder('id')))).prepare();
      assert.equal((await p.execute({ id: 1 }))[0].name, 'Ada'); assert.deepEqual(requests.at(-1).params, [1, 1]);
      assert.equal((await p.execute({ id: 2 }))[0].name, 'Grace'); const before = requests.length;
      await assert.rejects(p.execute({}), /placeholder/i); assert.equal(requests.length, before);
    });
    await test('mysql: native binding preserves literal/comment question marks and injection text', async () => {
      const r = await client.query<Record<string, unknown>>("SELECT '?' AS literal, ? AS bound, ':1 $2' AS other /* ? */ -- ?\n", [strange]);
      assert.deepEqual(r.rows[0], { literal: '?', bound: strange, other: ':1 $2' });
      const [rows] = await db.execute(sql`SELECT ${strange} AS value`);
      assert.equal((rows as any)[0].value, strange); assert.deepEqual(requests.at(-1).params, [strange]);
    });
    await test('mysql: duplicate labels, left join nullability and ordered rows', async () => {
      const rows = await db.select({ user: { id: users.id, name: users.name }, post: { id: posts.id, title: posts.title } }).from(users).leftJoin(posts, eq(users.id, posts.userId)).orderBy(asc(users.id), asc(posts.id));
      assert.equal(rows[0].post?.id, 11); assert.equal(rows[2].post, null); assert.equal(requests.at(-1).method, 'values');
    });
    await test('mysql: relational findMany/findFirst and empty results', async () => {
      const rows = await db.query.users.findMany({ with: { posts: true }, orderBy: asc(users.id) });
      assert.equal(rows[0].posts.length, 2); assert.deepEqual(rows[1].posts, []);
      assert.equal((await db.query.users.findFirst({ where: eq(users.id, 1) }))?.name, 'Ada');
      assert.equal(await db.query.users.findFirst({ where: eq(users.id, -1) }), undefined);
    });
    await test('mysql: CTE, count, limit/offset and expression decoder', async () => {
      const cte = db.$with('chosen').as(db.select().from(users).where(eq(users.id, 1)));
      assert.equal((await db.with(cte).select().from(cte))[0].id, 1); assert.equal(await db.$count(users), 2);
      assert.equal((await db.select({ n: count() }).from(users))[0].n, 2);
      assert.equal((await db.select().from(users).orderBy(asc(users.id)).limit(1).offset(1))[0].id, 2);
    });
    await test('mysql: bigint, exact decimal, JSON, Date and microsecond timestamp roundtrip', async () => {
      await db.insert(types).values({ id: 1, big: 9007199254740993n, amount: '12345678901234567890.1234567890', obj: { v: strange }, precise: '2026-09-27 12:34:56.123456', moment: new Date('2026-09-27T12:34:56.123Z'), day: '2026-09-27' });
      const [r] = await db.select().from(types);
      assert.equal(r.big, 9007199254740993n); assert.equal(r.amount, '12345678901234567890.1234567890'); assert.deepEqual(r.obj, { v: strange });
      assert.equal(r.precise, '2026-09-27 12:34:56.123456'); assert.equal(r.moment?.toISOString(), '2026-09-27T12:34:56.123Z'); assert.equal(r.day, '2026-09-27');
    });
    await test('mysql: transaction commits, pins connection, callback result and stale handle', async () => {
      let captured: any;
      assert.equal(await db.transaction(async tx => { captured = tx; const [first] = await tx.execute(sql`select connection_id() as id`); await tx.insert(users).values({ id: 100, name: 'committed' }); assert.deepEqual((await tx.execute(sql`select connection_id() as id`))[0], first); return 42; }), 42);
      assert.equal((await db.select().from(users).where(eq(users.id, 100))).length, 1); await assert.rejects(captured.execute(sql`select 1`));
    });
    await test('mysql: callback throw and explicit rollback leave no rows', async () => {
      const err = new Error('application');
      await assert.rejects(db.transaction(async tx => { await tx.insert(users).values({ id: 101, name: 'rollback' }); throw err; }), e => e === err); await absent(101);
      await assert.rejects(db.transaction(async tx => { await tx.insert(users).values({ id: 102, name: 'rollback' }); tx.rollback(); }), /Rollback/); await absent(102);
    });
    await test('mysql: nested success, nested rollback, three levels and SQL error recovery', async () => {
      await db.transaction(async tx => {
        await tx.insert(users).values({ id: 110, name: 'outer' });
        await assert.rejects(tx.transaction(async inner => { await inner.insert(users).values({ id: 111, name: 'rollback' }); inner.rollback(); }));
        await tx.transaction(async middle => { await assert.rejects(middle.transaction(async inner => { await inner.insert(users).values({ id: 1, name: 'duplicate' }); })); await middle.insert(users).values({ id: 112, name: 'nested' }); });
      });
      await absent(111); assert.equal((await db.select().from(users).where(eq(users.id, 112))).length, 1);
      await assert.rejects(db.transaction(async tx => { await tx.transaction(async inner => { await inner.insert(users).values({ id: 113, name: 'nested' }); }); tx.rollback(); })); await absent(113);
    });
    await test('mysql: read-only transaction and isolation configuration on pinned connection', async () => {
      await assert.rejects(db.transaction(async tx => { await tx.insert(users).values({ id: 120, name: 'read only' }); }, { isolationLevel: 'read committed', accessMode: 'read only' })); await absent(120);
      for (const isolationLevel of ['read committed', 'repeatable read'] as const) {
        await db.update(users).set({ name: 'before' }).where(eq(users.id, 2));
        await db.transaction(async tx => {
          assert.equal((await tx.select().from(users).where(eq(users.id, 2)))[0].name, 'before');
          await db.update(users).set({ name: 'after' }).where(eq(users.id, 2));
          assert.equal((await tx.select().from(users).where(eq(users.id, 2)))[0].name, isolationLevel === 'read committed' ? 'after' : 'before');
        }, { isolationLevel, withConsistentSnapshot: isolationLevel === 'repeatable read', accessMode: 'read write' });
      }
    });
    await test('mysql: concurrent transactions and pool reuse', async () => {
      await Promise.all(Array.from({ length: 4 }, (_, i) => db.transaction(async tx => { await tx.insert(users).values({ id: 200 + i, name: String(i) }); assert.equal((await tx.select().from(users).where(eq(users.id, 200 + i)))[0].name, String(i)); })));
    });
    await test('mysql: timeout destroys connection, rolls back and recovers', async () => {
      await assert.rejects(db.transaction(async tx => { await tx.insert(users).values({ id: 130, name: 'timeout' }); await tx.execute(sql`select sleep(${6})`); })); await absent(130);
    });
    await test('mysql: TCP disconnect rolls back without replay', async () => {
      const start = requests.length;
      await assert.rejects(db.transaction(async tx => { await tx.insert(users).values({ id: 131, name: 'disconnect' }); await relay.drop(); await tx.execute(sql`select 1`); }));
      await absent(131); assert.equal(requests.slice(start).filter(r => r.sql?.startsWith('insert')).length, 1);
    });
    await test('mysql: lost commit response never retries writes', async () => {
      const start = requests.length; loseCommitResponse = true;
      try { await assert.rejects(db.transaction(async tx => { await tx.insert(users).values({ id: 132, name: 'uncertain' }); })); } finally { loseCommitResponse = false; }
      assert.equal((await db.select().from(users).where(eq(users.id, 132))).length, 1); assert.equal(requests.slice(start).filter(r => r.sql === 'commit').length, 1);
    });
    await test('mysql: aborted signal still releases and rolls back transaction', async () => {
      const cancellableDb = drizzleMySql(cancellable);
      const start = requests.length;
      await assert.rejects(cancellableDb.transaction(async tx => {
        await tx.insert(users).values({ id: 150, name: 'cancelled' });
        controller.abort();
        await tx.execute(sql`SELECT 1`);
      }));
      assert.equal(requests.slice(start).filter(r => r.path.endsWith('/release')).length, 1);
      await absent(150);
    });
    await test('mysql: release idempotency and post-release rejection', async () => {
      const c = await client.connect(); await c.query('begin'); await Promise.all([c.release(), c.release()]); await assert.rejects(c.query('select 1'), /released/);
    });
  } finally { await closeAllTransactionSessions(); for (const suffix of ['posts', 'users', 'types']) await client.query(`DROP TABLE IF EXISTS ${prefix}_${suffix}`); }
}

async function oracleTests(client: DrizzleProxyClient, relay: any, cancellable: DrizzleProxyClient, controller: AbortController) {
  const db = drizzleOracle(client), table = sql.identifier(`${prefix}_oracle`.toUpperCase());
  const absent = async (id: number) => assert.deepEqual(await db.all(sql`SELECT ID FROM ${table} WHERE ID=${id}`), []);
  let created = false;
  try {
    await db.execute(sql`CREATE TABLE ${table}(ID NUMBER PRIMARY KEY, TXT VARCHAR2(1000), AMOUNT NUMBER(30,10), STAMP TIMESTAMP(6), RAW_VALUE RAW(100), CONTENT CLOB, BIN BLOB)`); created = true;
    await test('oracle: SQL tagged CRUD, Unicode and exact numeric result', async () => {
      assert.equal((await db.execute(sql`INSERT INTO ${table}(ID, TXT, AMOUNT) VALUES (${1}, ${strange}, ${'12345678901234567890.1234567890'})`)).rowCount, 1);
      const [r] = await db.all(sql`SELECT TXT AS "txt", AMOUNT AS "amount", TO_CHAR(STAMP, 'YYYY-MM-DD HH24:MI:SS.FF6') AS "stamp" FROM ${table} WHERE ID=${1}`);
      assert.equal(r.txt, strange); assert.equal(String(r.amount).replace(/0+$/, ''), '12345678901234567890.123456789'); assert.equal(r.stamp, null);
      assert.equal((await db.execute(sql`UPDATE ${table} SET TXT=${'updated'} WHERE ID=${1}`)).rowCount, 1);
    });
    await test('oracle: prepared repeated placeholders, reuse, missing rejection and literal tokens', async () => {
      const p = db.prepare(sql`SELECT ${sql.placeholder('value')} AS "a", ${sql.placeholder('value')} AS "b", ':1 ? $1' AS "literal" FROM DUAL /* :3 ? */`);
      assert.deepEqual((await p.execute({ value: strange })).rows[0], { a: strange, b: strange, literal: ':1 ? $1' }); assert.deepEqual(requests.at(-1).params, [strange, strange]);
      assert.equal((await p.execute({ value: 'next' })).rows[0].a, 'next'); const before = requests.length;
      await assert.rejects(p.execute({}), /placeholder/); assert.equal(requests.length, before);
    });
    await test('oracle: ordered duplicate labels and native reordered/repeated binds', async () => {
      assert.deepEqual(await db.values(sql`SELECT ${'first'} AS "same", ${'second'} AS "same" FROM DUAL`), [['first', 'second']]);
      const result = await client.query<Record<string, unknown>>('SELECT :2 AS "b", :1 AS "a", :1 AS "again" FROM DUAL', ['a', 'b']);
      assert.deepEqual(result.rows[0], { b: 'b', a: 'a', again: 'a' });
    });
    await test('oracle: typed RAW/CLOB/BLOB, timestamp text precision and bigint input', async () => {
      const large = '中文abcdef'.repeat(3000), binary = '00ff807f';
      await db.execute(sql`INSERT INTO ${table}(ID, TXT, AMOUNT, STAMP, RAW_VALUE, CONTENT, BIN) VALUES (${2}, ${'types'}, ${9007199254740993n}, TO_TIMESTAMP(${'2026-09-27 12:34:56.123456'}, 'YYYY-MM-DD HH24:MI:SS.FF6'), ${oracleBind('RAW', binary)}, ${oracleBind('CLOB', large)}, ${oracleBind('BLOB', binary)})`);
      const [r] = await db.all(sql`SELECT AMOUNT AS "amount", TO_CHAR(STAMP, 'YYYY-MM-DD HH24:MI:SS.FF6') AS "stamp", RAW_VALUE AS "raw", CONTENT AS "content", BIN AS "bin" FROM ${table} WHERE ID=${2}`);
      assert.equal(r.amount, '9007199254740993'); assert.equal(r.stamp, '2026-09-27 12:34:56.123456'); assert.equal(String(r.raw).toLowerCase(), binary); assert.equal(String(r.bin).toLowerCase(), binary); assert.equal(r.content, large);
    });
    await test('oracle: commit, pinned session, callback value and stale transaction rejection', async () => {
      let captured: any; const start = requests.length;
      assert.equal(await db.transaction(async tx => {
        captured = tx; const first = await tx.all(sql`SELECT SYS_CONTEXT('USERENV','SID') AS "sid" FROM DUAL`);
        await tx.execute(sql`INSERT INTO ${table}(ID, TXT) VALUES (${100}, ${'committed'})`);
        assert.deepEqual(await tx.all(sql`SELECT SYS_CONTEXT('USERENV','SID') AS "sid" FROM DUAL`), first); return 42;
      }), 42);
      assert.equal((await db.all(sql`SELECT ID FROM ${table} WHERE ID=${100}`)).length, 1);
      assert.equal(requests.slice(start).filter(r => r.path.endsWith('/release')).length, 1);
      const before = requests.length; await assert.rejects(captured.execute(sql`SELECT 1 FROM DUAL`), /completed/); assert.equal(requests.length, before);
    });
    await test('oracle: callback error and tx.rollback remove writes', async () => {
      const error = new Error('application');
      await assert.rejects(db.transaction(async tx => { await tx.execute(sql`INSERT INTO ${table}(ID) VALUES (${101})`); throw error; }), e => e === error); await absent(101);
      await assert.rejects(db.transaction(async tx => { await tx.execute(sql`INSERT INTO ${table}(ID) VALUES (${102})`); tx.rollback(); }), /Rollback/); await absent(102);
    });
    await test('oracle: nested savepoint success, rollback, three levels and SQL error recovery', async () => {
      await db.transaction(async tx => {
        await tx.execute(sql`INSERT INTO ${table}(ID) VALUES (${110})`);
        await assert.rejects(tx.transaction(async inner => { await inner.execute(sql`INSERT INTO ${table}(ID) VALUES (${111})`); inner.rollback(); }));
        await tx.transaction(async middle => {
          await assert.rejects(middle.transaction(async inner => { await inner.execute(sql`INSERT INTO ${table}(ID) VALUES (${110})`); }));
          await middle.execute(sql`INSERT INTO ${table}(ID) VALUES (${112})`);
        });
      });
      await absent(111); assert.equal((await db.all(sql`SELECT ID FROM ${table} WHERE ID=${112}`)).length, 1);
    });
    await test('oracle: outer rollback includes successful nested transaction', async () => {
      await assert.rejects(db.transaction(async tx => { await tx.transaction(async inner => { await inner.execute(sql`INSERT INTO ${table}(ID) VALUES (${113})`); }); tx.rollback(); })); await absent(113);
    });
    await test('oracle: read-only/isolation settings and invalid combination rejection', async () => {
      await assert.rejects(db.transaction(async tx => { await tx.execute(sql`INSERT INTO ${table}(ID) VALUES (${120})`); }, { accessMode: 'read only' })); await absent(120);
      await db.transaction(async tx => { assert.equal((await tx.all(sql`SELECT 1 AS "n" FROM DUAL`))[0].n, '1'); }, { isolationLevel: 'serializable' });
      const before = requests.length; await assert.rejects(db.transaction(async () => {}, { accessMode: 'read only', isolationLevel: 'serializable' }), /cannot be combined/); assert.equal(requests.length, before);
    });
    await test('oracle: concurrent transactions remain isolated and release sessions', async () => {
      await Promise.all(Array.from({ length: 4 }, (_, i) => db.transaction(async tx => { await tx.execute(sql`INSERT INTO ${table}(ID,TXT) VALUES (${200 + i}, ${String(i)})`); assert.equal((await tx.all(sql`SELECT TXT AS "v" FROM ${table} WHERE ID=${200 + i}`))[0].v, String(i)); })));
    });
    await test('oracle: call timeout rolls back a prior write and recovers', async () => {
      const timeout = config.QUERY_TIMEOUT_MS;
      config.QUERY_TIMEOUT_MS = 2500;
      try {
        const start = Date.now();
        await assert.rejects(db.transaction(async tx => {
          await tx.execute(sql`INSERT INTO ${table}(ID) VALUES (${130})`);
          await tx.execute(sql`BEGIN DBMS_SESSION.SLEEP(6); END;`);
        }), /DPI-1067|DPI-1080|ORA-03156|timeout|timed out|transaction and cleanup failed/i);
        assert.ok(Date.now() - start < 16000, 'timeout should bound the blocked call');
      } finally { config.QUERY_TIMEOUT_MS = timeout; }
      await absent(130);
    });
    await test('oracle: TCP disconnect rolls back without replay and recovers', async () => {
      const start = requests.length;
      await assert.rejects(db.transaction(async tx => { await tx.execute(sql`INSERT INTO ${table}(ID) VALUES (${131})`); await relay.drop(); await tx.execute(sql`SELECT 1 FROM DUAL`); }));
      await absent(131); assert.equal(requests.slice(start).filter(r => r.sql?.startsWith('INSERT')).length, 1);
    });
    await test('oracle: lost commit response is surfaced without retry and releases session', async () => {
      const start = requests.length; loseCommitResponse = true;
      try { await assert.rejects(db.transaction(async tx => { await tx.execute(sql`INSERT INTO ${table}(ID) VALUES (${132})`); })); } finally { loseCommitResponse = false; }
      assert.equal((await db.all(sql`SELECT ID FROM ${table} WHERE ID=${132}`)).length, 1); assert.equal(requests.slice(start).filter(r => r.sql === 'commit').length, 1);
    });
    await test('oracle: aborted signal still releases and rolls back transaction', async () => {
      const cancellableDb = drizzleOracle(cancellable);
      const start = requests.length;
      await assert.rejects(cancellableDb.transaction(async tx => {
        await tx.execute(sql`INSERT INTO ${table}(ID) VALUES (${150})`);
        controller.abort();
        await tx.execute(sql`SELECT 1 FROM DUAL`);
      }));
      assert.equal(requests.slice(start).filter(r => r.path.endsWith('/release')).length, 1);
      await absent(150);
    });
    await test('oracle: delete affected rows and empty result', async () => {
      await db.execute(sql`INSERT INTO ${table}(ID) VALUES (${140})`);
      assert.equal((await db.execute(sql`DELETE FROM ${table} WHERE ID=${140}`)).rowCount, 1); await absent(140);
    });
  } finally { await closeAllTransactionSessions(); if (created) await db.execute(sql`DROP TABLE ${table} PURGE`); }
}
