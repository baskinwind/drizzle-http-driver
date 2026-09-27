import type { MySqlDialect } from 'drizzle-orm/mysql-core/dialect';
import type { Mode, MySqlTransactionConfig } from 'drizzle-orm/mysql-core/session';
import { MySqlRemoteSession } from 'drizzle-orm/mysql-proxy/session';
import type { MySqlRemoteSessionOptions } from 'drizzle-orm/mysql-proxy/session';
import type { RelationalSchemaConfig, TablesRelationalConfig } from 'drizzle-orm/relations';
import { sql } from 'drizzle-orm/sql';
import type { SQL } from 'drizzle-orm/sql';
import type { DrizzleProxyClient } from '../../http/client.js';
import { HttpMySqlTransaction } from './transaction.js';

export class HttpMySqlSession<TFullSchema extends Record<string, unknown>, TSchema extends TablesRelationalConfig>
  extends MySqlRemoteSession<TFullSchema, TSchema> {
  private active = true;

  constructor(
    private readonly httpClient: DrizzleProxyClient,
    dialect: MySqlDialect,
    private readonly relationSchema: RelationalSchemaConfig<TSchema> | undefined,
    private readonly sessionOptions: MySqlRemoteSessionOptions,
    private readonly txMode: Mode,
    private readonly parentGuard?: () => void,
  ) {
    super(async (text, params, method) => {
      this.assertActive();
      const result = await httpClient.query({ text, ...(method === 'all' ? { rowMode: 'array' as const } : {}) }, params);
      if (method === 'all') return { rows: result.rows };
      // Match mysql2's [rows-or-result-header, fields] shape. The upstream
      // MySQL prepared mapper also uses this header for $returningId().
      return { rows: [result.affectedRows === undefined ? result.rows : {
        insertId: result.insertId ?? 0, affectedRows: result.affectedRows,
      }, result.fields] };
    }, dialect, relationSchema, sessionOptions);
  }

  assertActive() {
    if (!this.active) throw new Error('Cannot query with a completed MySQL transaction');
    this.parentGuard?.();
  }

  close() { this.active = false; }

  fork() {
    this.assertActive();
    return new HttpMySqlSession<TFullSchema, TSchema>(this.httpClient, this.dialect, this.relationSchema, this.sessionOptions, this.txMode, () => this.assertActive());
  }

  override async count(query: SQL) {
    const rows = await this.all<unknown[]>(query);
    return Number(rows[0]?.[0]);
  }

  override async transaction<T>(callback: (tx: HttpMySqlTransaction<TFullSchema, TSchema>) => Promise<T>, config?: MySqlTransactionConfig) {
    this.assertActive();
    const client = await this.httpClient.connect();
    const session = new HttpMySqlSession<TFullSchema, TSchema>(client, this.dialect, this.relationSchema, this.sessionOptions, this.txMode);
    const tx = new HttpMySqlTransaction(this.dialect, session, this.relationSchema, 0, this.txMode);
    try {
      await client.query({ text: 'begin', transactionOptions: config });
      const result = await callback(tx);
      await tx.execute(sql`commit`);
      return result;
    } catch (error) {
      try { await client.release(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Drizzle HTTP transaction and cleanup failed'); }
      throw error;
    } finally { session.close(); }
  }
}
