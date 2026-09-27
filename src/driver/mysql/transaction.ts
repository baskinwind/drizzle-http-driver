import type { MySqlDialect } from 'drizzle-orm/mysql-core/dialect';
import type { Mode, MySqlSession } from 'drizzle-orm/mysql-core/session';
import { MySqlProxyTransaction } from 'drizzle-orm/mysql-proxy/session';
import type { RelationalSchemaConfig, TablesRelationalConfig } from 'drizzle-orm/relations';
import { sql } from 'drizzle-orm/sql';
import type { HttpMySqlSession } from './session.js';

export class HttpMySqlTransaction<TFullSchema extends Record<string, unknown>, TSchema extends TablesRelationalConfig>
  extends MySqlProxyTransaction<TFullSchema, TSchema> {
  private nestedActive = false;

  constructor(
    private readonly txDialect: MySqlDialect,
    private readonly txSession: HttpMySqlSession<TFullSchema, TSchema>,
    schema: RelationalSchemaConfig<TSchema> | undefined,
    nestedIndex: number,
    private readonly txMode: Mode,
  ) { super(txDialect, txSession as unknown as MySqlSession, schema, nestedIndex, txMode); }

  override async transaction<T>(callback: (tx: HttpMySqlTransaction<TFullSchema, TSchema>) => Promise<T>): Promise<T> {
    this.txSession.assertActive();
    if (this.nestedActive) throw new Error('Nested MySQL transactions must be awaited sequentially');
    this.nestedActive = true;
    const name = `sp${this.nestedIndex + 1}`;
    const session = this.txSession.fork();
    const tx = new HttpMySqlTransaction(this.txDialect, session, this.schema, this.nestedIndex + 1, this.txMode);
    try {
      await this.execute(sql.raw(`savepoint ${name}`));
      try {
        const result = await callback(tx);
        await this.execute(sql.raw(`release savepoint ${name}`));
        return result;
      } catch (error) {
        try { await this.execute(sql.raw(`rollback to savepoint ${name}`)); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Drizzle HTTP savepoint rollback failed'); }
        throw error;
      }
    } finally { session.close(); this.nestedActive = false; }
  }
}
