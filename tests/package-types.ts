import { DrizzleProxyClient, type DrizzleProxyQueryResult } from 'drizzle-http-driver';
import { drizzle as postgres, type DrizzlePostgresConfig } from 'drizzle-http-driver/postgresql';
import { drizzle as mysql, type DrizzleMySqlConfig } from 'drizzle-http-driver/mysql';
import { drizzle as oracle, oracleBind, type DrizzleOracleConfig } from 'drizzle-http-driver/oracle';
import { sql } from 'drizzle-orm';

const client = new DrizzleProxyClient({ endpoint: 'https://proxy.test/api/query', key: 'test', token: 'test' });
const pgConfig: DrizzlePostgresConfig = {};
const mysqlConfig: DrizzleMySqlConfig = {};
const oracleConfig: DrizzleOracleConfig = {};
postgres(client, pgConfig).transaction(async tx => { await tx.execute(sql`select ${1}`); });
mysql(client, mysqlConfig).transaction(async tx => { await tx.execute(sql`select ${1}`); });
oracle(client, oracleConfig).transaction(async tx => {
  const result: DrizzleProxyQueryResult = await tx.execute(sql`select ${oracleBind('RAW', '00FF')} from dual`);
  return result.rows;
});
// @ts-expect-error Database factories must be imported from their adapter entrypoint.
import { drizzle } from 'drizzle-http-driver';
// @ts-expect-error The old PostgreSQL configuration alias was removed.
import type { DrizzleHttpConfig } from 'drizzle-http-driver/postgresql';
