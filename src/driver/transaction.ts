import type { PgSession } from 'drizzle-orm/pg-core/session';
import type { RelationalSchemaConfig, TablesRelationalConfig } from 'drizzle-orm/relations';

import { entityKind } from 'drizzle-orm/entity';
import type { PgDialect } from 'drizzle-orm/pg-core/dialect';
import { PgTransaction } from 'drizzle-orm/pg-core/session';
import { sql } from 'drizzle-orm/sql';

import type { DrizzleProxyQueryResultHKT } from '../types';

export class HttpPgTransaction<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends PgTransaction<DrizzleProxyQueryResultHKT, TFullSchema, TSchema> {
  static readonly [entityKind] = 'HttpPgTransaction';

  constructor(
    private readonly txDialect: PgDialect,
    private readonly txSession: PgSession<
      DrizzleProxyQueryResultHKT,
      TFullSchema,
      TSchema
    >,
    schema: RelationalSchemaConfig<TSchema> | undefined,
    nestedIndex = 0,
  ) {
    super(txDialect, txSession, schema, nestedIndex);
  }

  async transaction<T>(
    transaction: (tx: HttpPgTransaction<TFullSchema, TSchema>) => Promise<T>,
  ) {
    const savepointName = `sp${this.nestedIndex + 1}`;
    const tx = new HttpPgTransaction<TFullSchema, TSchema>(
      this.txDialect,
      this.txSession,
      this.schema,
      this.nestedIndex + 1,
    );

    await tx.execute(sql.raw(`savepoint ${savepointName}`));

    try {
      const result = await transaction(tx);
      await tx.execute(sql.raw(`release savepoint ${savepointName}`));
      return result;
    }
    catch (error) {
      await tx.execute(sql.raw(`rollback to savepoint ${savepointName}`));
      throw error;
    }
  }
}
