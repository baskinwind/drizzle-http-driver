import type { HttpPgSession } from './session.js';
import type { RelationalSchemaConfig, TablesRelationalConfig } from 'drizzle-orm/relations';

import { entityKind } from 'drizzle-orm/entity';
import type { PgDialect } from 'drizzle-orm/pg-core/dialect';
import { PgTransaction } from 'drizzle-orm/pg-core/session';
import { sql } from 'drizzle-orm/sql';

import type { DrizzleProxyQueryResultHKT } from './types.js';

export class HttpPgTransaction<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends PgTransaction<DrizzleProxyQueryResultHKT, TFullSchema, TSchema> {
  static readonly [entityKind] = 'HttpPgTransaction';

  private nestedActive = false;

  private readonly txDialect: PgDialect;
  private readonly txSession: HttpPgSession<TFullSchema, TSchema>;

  constructor(
    txDialect: PgDialect,
    txSession: HttpPgSession<TFullSchema, TSchema>,
    schema: RelationalSchemaConfig<TSchema> | undefined,
    nestedIndex = 0,
  ) {
    super(txDialect, txSession, schema, nestedIndex);
    this.txDialect = txDialect;
    this.txSession = txSession;
  }

  async transaction<T>(transaction: (tx: HttpPgTransaction<TFullSchema, TSchema>) => Promise<T>) {
    this.txSession.assertActive();
    if (this.nestedActive) throw new Error('Nested PostgreSQL transactions must be awaited sequentially');
    this.nestedActive = true;
    const savepointName = `sp${this.nestedIndex + 1}`;
    const session = this.txSession.fork();
    const tx = new HttpPgTransaction<TFullSchema, TSchema>(
      this.txDialect,
      session,
      this.schema,
      this.nestedIndex + 1,
    );

    try {
      await tx.execute(sql.raw(`savepoint ${savepointName}`));
      try {
        const result = await transaction(tx);
        await tx.execute(sql.raw(`release savepoint ${savepointName}`));
        return result;
      }
      catch (error) {
        try { await tx.execute(sql.raw(`rollback to savepoint ${savepointName}`)); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Drizzle HTTP savepoint rollback failed'); }
        throw error;
      }
    } finally { session.close(); this.nestedActive = false; }
  }
}
