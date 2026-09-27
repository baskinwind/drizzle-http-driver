import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const names = ['postgresql', 'mysql', 'oracle'];
const config = { endpoint: 'https://proxy.test/api/query', key: 'test', token: 'test' };
for (const format of ['esm', 'cjs']) {
  test(`${format}: public entrypoints are independent and have no legacy factories`, async () => {
    const load = name => format === 'esm' ? import(name) : require(name);
    const common = await load('drizzle-http-driver');
    const client = await load('drizzle-http-driver/client');
    assert.equal(common.DrizzleProxyClient, client.DrizzleProxyClient);
    for (const name of ['drizzle', 'drizzlePostgres', 'drizzleMySql', 'drizzleOracle']) assert.ok(!(name in common));
    for (const name of names) {
      const adapter = await load(`drizzle-http-driver/${name}`);
      assert.equal(typeof adapter.drizzle, 'function');
      assert.ok(!('drizzleMySql' in adapter) && !('drizzleOracle' in adapter));
      const connection = new client.DrizzleProxyClient(config);
      assert.equal(adapter.drizzle(connection).$client, connection);
    }
  });
}

test('built adapter dependency graphs do not load other dialects', () => {
  const walk = (file, seen = new Set()) => {
    if (seen.has(file)) return '';
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    const dependencies = [...source.matchAll(/(?:from\s*|import\s*|require\(\s*)["'](\.[^"']+)["']/g)];
    return source + dependencies.map(([, path]) => walk(resolve(dirname(file), path), seen)).join('\n');
  };
  for (const extension of ['js', 'cjs']) {
    const root = walk(resolve(import.meta.dirname, `../dist/index.${extension}`));
    assert.ok(!root.includes('drizzle-orm'), 'common client must not load ORM adapters');
    for (const name of names) {
      const source = walk(resolve(import.meta.dirname, `../dist/${name}.${extension}`));
      if (name !== 'postgresql') assert.ok(!source.includes('drizzle-orm/pg-'));
      if (name !== 'mysql') assert.ok(!source.includes('drizzle-orm/mysql-'));
      if (name !== 'oracle') assert.ok(!source.includes('Oracle transaction'));
    }
  }
});
