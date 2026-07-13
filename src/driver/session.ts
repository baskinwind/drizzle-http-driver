import type { WithCacheConfig } from 'drizzle-orm/cache/core/types';
import type { Logger } from 'drizzle-orm/logger';
import type { SelectedFieldsOrdered } from 'drizzle-orm/pg-core/query-builders/select.types';
import type {
  PgTransactionConfig,
  PreparedQueryConfig,
} from 'drizzle-orm/pg-core/session';
import type {
  RelationalSchemaConfig,
  TablesRelationalConfig,
} from 'drizzle-orm/relations';
import type { Query, SQL } from 'drizzle-orm/sql';

import { type Cache, NoopCache } from 'drizzle-orm/cache/core';
import { entityKind } from 'drizzle-orm/entity';
import { NoopLogger } from 'drizzle-orm/logger';
import type { PgDialect } from 'drizzle-orm/pg-core/dialect';
import { PgSession } from 'drizzle-orm/pg-core/session';
import { sql } from 'drizzle-orm/sql';

import { HttpPgPreparedQuery } from './prepared-query';
import { HttpPgTransaction } from './transaction';

import type {
  DrizzleProxyPoolLike,
  DrizzleProxyQueryResult,
  DrizzleProxyQueryResultHKT,
  QueryMetadata,
} from '../types';

export interface HttpPgSessionOptions {
  cache?: Cache;
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

const combineErrors = (message: string, errors: unknown[]) => {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, message);
};

export class HttpPgSession<
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
> extends PgSession<DrizzleProxyQueryResultHKT, TFullSchema, TSchema> {
  static readonly [entityKind] = 'HttpPgSession';

  private readonly cache: Cache;
  private readonly logger: Logger;

  constructor(
    private readonly client: DrizzleProxyPoolLike,
    dialect: PgDialect,
    private readonly schema: RelationalSchemaConfig<TSchema> | undefined,
    private readonly options: HttpPgSessionOptions = {},
  ) {
    super(dialect);
    this.cache = options.cache ?? new NoopCache();
    this.logger = options.logger ?? new NoopLogger();
  }

  prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    _name: string | undefined,
    isResponseInArrayMode: boolean,
    customResultMapper?: (
      rows: unknown[][],
      mapColumnValue?: (value: unknown) => unknown,
    ) => T['execute'],
    queryMetadata?: QueryMetadata,
    cacheConfig?: WithCacheConfig,
  ) {
    return new HttpPgPreparedQuery<T>(
      this.client,
      query,
      this.logger,
      this.cache,
      queryMetadata,
      cacheConfig,
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
    const errors: unknown[] = [];
    let began = false;
    let result: T | undefined;

    try {
      await tx.execute(
        sql`begin${config ? sql` ${transactionConfigSql(config)}` : undefined}`,
      );
      began = true;
      result = await transaction(tx);
      await tx.execute(sql`commit`);
    }
    catch (error) {
      errors.push(error);
      if (began) {
        try {
          await tx.execute(sql`rollback`);
        }
        catch (rollbackError) {
          errors.push(rollbackError);
        }
      }
    }

    try {
      await client.release();
    }
    catch (releaseError) {
      errors.push(releaseError);
    }

    if (errors.length > 0) {
      throw combineErrors('Drizzle HTTP transaction failed', errors);
    }

    return result as T;
  }

  override async count(query: SQL) {
    const result = await this.execute<DrizzleProxyQueryResult>(query);
    return Number((result.rows[0] as { count?: unknown } | undefined)?.count);
  }
}
