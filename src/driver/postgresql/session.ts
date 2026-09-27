import type { Logger } from 'drizzle-orm/logger';
import type { SelectedFieldsOrdered } from 'drizzle-orm/pg-core/query-builders/select.types';
import type { PgTransactionConfig, PreparedQueryConfig } from 'drizzle-orm/pg-core/session';
import type { RelationalSchemaConfig, TablesRelationalConfig } from 'drizzle-orm/relations';
import type { Query, SQL } from 'drizzle-orm/sql';

import { entityKind } from 'drizzle-orm/entity';
import { NoopLogger } from 'drizzle-orm/logger';
import type { PgDialect } from 'drizzle-orm/pg-core/dialect';
import { PgSession } from 'drizzle-orm/pg-core/session';
import { sql } from 'drizzle-orm/sql';

import { HttpPgPreparedQuery } from './prepared-query.js';
import { HttpPgTransaction } from './transaction.js';

import type { DrizzleProxyClientLike, DrizzleProxyQueryResult } from '../../types.js';
import type { DrizzleProxyQueryResultHKT } from './types.js';

interface DrizzleProxyTransactionClient extends DrizzleProxyClientLike {
  release(): Promise<void>;
}

interface DrizzleProxySessionClient extends DrizzleProxyClientLike {
  connect(): Promise<DrizzleProxyTransactionClient>;
}

interface HttpPgSessionOptions {
  logger?: Logger;
}

const transactionConfigSql = (config: PgTransactionConfig) => {
  const chunks: string[] = [];

  if (config.isolationLevel) {
    chunks.push(`isolation level ${config.isolationLevel}`);
  }
  if (config.accessMode) chunks.push(config.accessMode);
  if (typeof config.deferrable === 'boolean') {
    chunks.push(config.deferrable ? 'deferrable' : 'not deferrable');
  }

  return sql.raw(chunks.join(' '));
};

export class HttpPgSession<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends PgSession<DrizzleProxyQueryResultHKT, TFullSchema, TSchema> {
  static readonly [entityKind] = 'HttpPgSession';

  private active = true;
  private readonly client: DrizzleProxySessionClient;
  private readonly logger: Logger;
  private readonly options: HttpPgSessionOptions;
  private readonly schema: RelationalSchemaConfig<TSchema> | undefined;

  constructor(
    client: DrizzleProxySessionClient,
    dialect: PgDialect,
    schema: RelationalSchemaConfig<TSchema> | undefined,
    options: HttpPgSessionOptions = {},
  ) {
    super(dialect);
    this.client = {
      connect: async () => { this.assertActive(); return client.connect(); },
      query: async (query, params) => { this.assertActive(); return client.query(query, params); },
    };
    this.logger = options.logger ?? new NoopLogger();
    this.options = options;
    this.schema = schema;
  }

  assertActive() {
    if (!this.active) throw new Error('Cannot query with a completed PostgreSQL transaction');
  }

  close() { this.active = false; }

  fork() {
    this.assertActive();
    return new HttpPgSession<TFullSchema, TSchema>(this.client, this.dialect, this.schema, this.options);
  }

  prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    _name: string | undefined,
    isResponseInArrayMode: boolean,
    customResultMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => T['execute'],
  ) {
    return new HttpPgPreparedQuery<T>(
      this.client,
      query,
      this.logger,
      fields,
      isResponseInArrayMode,
      customResultMapper,
    );
  }

  async transaction<T>(
    transaction: (tx: HttpPgTransaction<TFullSchema, TSchema>) => Promise<T>,
    config?: PgTransactionConfig,
  ) {
    const client = await this.client.connect();
    const session = new HttpPgSession<TFullSchema, TSchema>(
      { connect: async () => client, query: client.query.bind(client) },
      this.dialect,
      this.schema,
      this.options,
    );
    const tx = new HttpPgTransaction<TFullSchema, TSchema>(
      this.dialect,
      session,
      this.schema,
    );

    try {
      await tx.execute(sql`begin${config ? sql` ${transactionConfigSql(config)}` : undefined}`);
      const result = await transaction(tx);
      await tx.execute(sql`commit`);
      return result;
    }
    catch (error) {
      try {
        await client.release();
      }
      catch (releaseError) {
        throw new AggregateError([error, releaseError], 'Drizzle HTTP transaction and cleanup failed');
      }
      throw error;
    } finally { session.close(); }
  }

  override async count(query: SQL) {
    const result = await this.execute<DrizzleProxyQueryResult>(query);
    return Number((result.rows[0] as { count?: unknown } | undefined)?.count);
  }
}
