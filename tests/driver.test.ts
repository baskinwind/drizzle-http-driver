import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { DrizzleProxyClient } from '../src/index';
import { drizzle } from '../src/postgresql';
import { drizzle as drizzleMySql } from '../src/mysql';
import { drizzle as drizzleOracle } from '../src/oracle';

const options = { endpoint: 'https://proxy.test/api/query', key: 'test', token: 'test' };
async function withTransport(action: (requests: any[]) => Promise<void>, fail: (body: any, url: string) => boolean = () => false) {
  const original = globalThis.fetch, requests: any[] = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push({ url: String(url), ...body });
    return new Response(JSON.stringify(fail(body, String(url)) ? { success: false, error: 'injected failure' } : { success: true, data: { rows: [], fields: [], rowCount: 0 } }), { status: fail(body, String(url)) ? 500 : 200, headers: { 'content-type': 'application/json' } });
  };
  try { await action(requests); } finally { globalThis.fetch = original; }
}

test('Oracle AST compilation preserves literals and uses numbered bind parameters', async () => {
  await withTransport(async requests => {
    const db = drizzleOracle(new DrizzleProxyClient(options));
    const prepared = db.prepare(sql`SELECT ${sql.placeholder('x')}, ':1 ? $1', ${sql.placeholder('x')} FROM ${sql.identifier('DU"AL')}`);
    await prepared.execute({ x: "' injection ?" });
    assert.equal(requests[0].sql, 'SELECT :1, \':1 ? $1\', :2 FROM "DU""AL"');
    assert.deepEqual(requests[0].params, ["' injection ?", "' injection ?"]);
    await assert.rejects(prepared.execute({}), /placeholder/); assert.equal(requests.length, 1);
  });
});

test('MySQL sends transaction characteristics with BEGIN on the pinned session', async () => {
  await withTransport(async requests => {
    const db = drizzleMySql(new DrizzleProxyClient(options));
    await db.transaction(async tx => { await tx.execute(sql`select ${1}`); }, { isolationLevel: 'serializable', accessMode: 'read only' });
    assert.deepEqual(requests.map(r => r.sql), ['begin', 'select ?', 'commit']);
    assert.deepEqual(requests[0].transaction_options, { isolationLevel: 'serializable', accessMode: 'read only' });
    assert.equal(new Set(requests.map(r => r.transaction_id)).size, 1);
  });
});

test('all drivers release failed BEGIN and preserve callback/cleanup errors without retries', async () => {
  for (const create of [drizzle, drizzleMySql, drizzleOracle]) {
    await withTransport(async requests => {
      const db: any = create(new DrizzleProxyClient(options));
      let invoked = false;
      await assert.rejects(db.transaction(async () => { invoked = true; }));
      assert.equal(invoked, false); assert.equal(requests.length, 2); assert.ok(requests[1].url.endsWith('/release'));
    }, body => body.sql?.startsWith('begin'));
    const original = new Error('callback error');
    await withTransport(async requests => {
      const db: any = create(new DrizzleProxyClient(options));
      await assert.rejects(db.transaction(async () => { throw original; }), error => error instanceof AggregateError && error.errors[0] === original && error.errors.length === 2);
      assert.equal(requests.filter(r => r.url.endsWith('/release')).length, 1);
      assert.ok(!requests.some(r => r.sql === 'commit'));
    }, (_body, url) => url.endsWith('/release'));
  }
});

test('Oracle releases committed session and rejects stale handles locally', async () => {
  await withTransport(async requests => {
    const db = drizzleOracle(new DrizzleProxyClient(options)); let captured: any;
    await db.transaction(async tx => { captured = tx; await tx.transaction(async inner => { await inner.execute(sql`SELECT ${1} FROM DUAL`); }); });
    assert.ok(!requests.some(r => r.sql?.startsWith('release savepoint')));
    assert.ok(requests.at(-1).url.endsWith('/release'));
    const count = requests.length; await assert.rejects(captured.execute(sql`SELECT 1 FROM DUAL`), /completed/); assert.equal(requests.length, count);
  });
});

test('Oracle rejects unsupported or ambiguous transaction settings before HTTP', async () => {
  await withTransport(async requests => {
    const db = drizzleOracle(new DrizzleProxyClient(options));
    await assert.rejects(db.transaction(async () => {}, { isolationLevel: 'read uncommitted' as any }), /Unsupported/);
    await assert.rejects(db.transaction(async () => {}, { accessMode: 'read only', isolationLevel: 'serializable' }), /cannot be combined/);
    assert.equal(requests.length, 0);
  });
});

test('overlapping nested transactions are rejected before conflicting savepoints', async () => {
  for (const create of [drizzle, drizzleMySql, drizzleOracle]) {
    await withTransport(async requests => {
      const db: any = create(new DrizzleProxyClient(options));
      await db.transaction(async (tx: any) => {
        let finish!: () => void;
        const ready = new Promise<void>(r => { finish = r; });
        const first = tx.transaction(async () => { await ready; });
        try { await assert.rejects(tx.transaction(async () => {}), /sequentially/); }
        finally { finish(); }
        await first;
      });
      assert.equal(requests.filter(r => r.sql?.startsWith('savepoint')).length, 1);
    });
  }
});

test('aborted query signals do not abort transaction cleanup', async () => {
  const original = globalThis.fetch;
  try {
    for (const create of [drizzle, drizzleMySql, drizzleOracle]) {
      const controller = new AbortController(); let released = false;
      globalThis.fetch = async (url, init) => {
        if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        if (String(url).endsWith('/release')) { released = true; assert.notEqual(init?.signal, controller.signal); }
        return new Response(JSON.stringify({ success: true, data: { rows: [], fields: [], rowCount: 0 } }), { headers: { 'content-type': 'application/json' } });
      };
      const db: any = create(new DrizzleProxyClient({ ...options, requestInit: { signal: controller.signal } }));
      await assert.rejects(db.transaction(async (tx: any) => { controller.abort(); await tx.execute(sql`SELECT 1`); }));
      assert.equal(released, true);
    }
  } finally { globalThis.fetch = original; }
});

test('all drivers reject completed outer and nested handles before HTTP', async () => {
  for (const create of [drizzle, drizzleMySql, drizzleOracle]) {
    await withTransport(async requests => {
      const db: any = create(new DrizzleProxyClient(options));
      let outer: any;
      await db.transaction(async (tx: any) => {
        outer = tx;
        for (const rollback of [false, true]) {
          let nested: any;
          let prepared: any;
          const result = tx.transaction(async (inner: any) => {
            nested = inner;
            prepared = inner.select ? inner.select({ value: sql`1` }).from(sql`items`).prepare('scoped_query') : inner.prepare(sql`select 1 from dual`);
            if (rollback) inner.rollback();
          });
          if (rollback) await assert.rejects(result); else await result;
          const count = requests.length;
          await assert.rejects(async () => nested.execute(sql`select 1`));
          await assert.rejects(async () => prepared.execute());
          await assert.rejects(async () => nested.transaction(async () => {}));
          assert.equal(requests.length, count, 'completed nested handles must not use the outer connection');
          await tx.execute(sql`select 1`);
        }
      });
      const count = requests.length;
      await assert.rejects(async () => outer.execute(sql`select 1`));
      await assert.rejects(async () => outer.transaction(async () => {}));
      assert.equal(requests.length, count, 'completed outer handles must be rejected locally');
    });
  }
});
