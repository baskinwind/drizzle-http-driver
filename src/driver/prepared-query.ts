import type { WithCacheConfig } from 'drizzle-orm/cache/core/types';
import type { SelectedFieldsOrdered } from 'drizzle-orm/pg-core/query-builders/select.types';
import type { PreparedQueryConfig } from 'drizzle-orm/pg-core/session';
import type { Query } from 'drizzle-orm/sql';

import { type Cache, hashQuery, NoopCache } from 'drizzle-orm/cache/core';
import { entityKind, is } from 'drizzle-orm/entity';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import type { Logger } from 'drizzle-orm/logger';
import { PgPreparedQuery } from 'drizzle-orm/pg-core/session';
import { fillPlaceholders } from 'drizzle-orm/sql';

import { mapRow } from './map-row';
import type { DrizzleProxyClientLike, QueryMetadata } from '../types';

export class HttpPgPreparedQuery<T extends PreparedQueryConfig>
  extends PgPreparedQuery<T> {
  static readonly [entityKind] = 'HttpPgPreparedQuery';

  protected joinsNotNullableMap?: Record<string, boolean>;

  private readonly localCache: Cache;
  private localCacheConfig: WithCacheConfig | undefined;
  private readonly localQueryMetadata: QueryMetadata | undefined;

  constructor(
    private readonly client: DrizzleProxyClientLike,
    private readonly httpQuery: Query,
    private readonly logger: Logger,
    cache: Cache,
    queryMetadata: QueryMetadata | undefined,
    cacheConfig: WithCacheConfig | undefined,
    private readonly fields: SelectedFieldsOrdered | undefined,
    private readonly responseInArrayMode: boolean,
    private readonly customResultMapper?: (
      rows: unknown[][],
      mapColumnValue?: (value: unknown) => unknown,
    ) => T['execute'],
  ) {
    super(httpQuery, cache, queryMetadata, cacheConfig);

    this.localCache = cache;
    this.localCacheConfig = cacheConfig;
    this.localQueryMetadata = queryMetadata;

    if (cache.strategy() === 'all' && cacheConfig === undefined) {
      this.localCacheConfig = { autoInvalidate: true, enable: true };
    }
    if (!this.localCacheConfig?.enable) this.localCacheConfig = undefined;
  }

  async execute(placeholderValues: Record<string, unknown> = {}) {
    const params = fillPlaceholders(this.httpQuery.params, placeholderValues);
    this.logger.logQuery(this.httpQuery.sql, params);

    if (!this.fields && !this.customResultMapper) {
      return this.executeWithCache(this.httpQuery.sql, params, () => {
        return this.client.query({ text: this.httpQuery.sql }, params);
      }) as Promise<T['execute']>;
    }

    const result = await this.executeWithCache(this.httpQuery.sql, params, () => {
      return this.client.query(
        { rowMode: 'array', text: this.httpQuery.sql },
        params,
      );
    });
    const rows = result.rows as unknown[][];

    if (this.customResultMapper) return this.customResultMapper(rows);
    if (!this.fields) return rows as T['execute'];

    return rows.map((row) => {
      return mapRow(this.fields!, row, this.joinsNotNullableMap);
    }) as T['execute'];
  }

  async all(placeholderValues: Record<string, unknown> = {}) {
    const params = fillPlaceholders(this.httpQuery.params, placeholderValues);
    this.logger.logQuery(this.httpQuery.sql, params);

    const result = await this.executeWithCache(this.httpQuery.sql, params, () => {
      return this.client.query({ text: this.httpQuery.sql }, params);
    });

    return result.rows as T['all'];
  }

  isResponseInArrayMode() {
    return this.responseInArrayMode;
  }

  private async executeWithCache<TResult>(
    queryString: string,
    params: unknown[],
    query: () => Promise<TResult>,
  ): Promise<TResult> {
    const executeQuery = async (): Promise<TResult> => {
      try {
        return await query();
      }
      catch (error) {
        throw new DrizzleQueryError(queryString, params, error as Error);
      }
    };

    if (is(this.localCache, NoopCache) || !this.localQueryMetadata) {
      return executeQuery();
    }

    const { tables, type } = this.localQueryMetadata;
    if (
      (type === 'delete' || type === 'insert' || type === 'update')
      && tables.length > 0
    ) {
      const [result] = await Promise.all([
        executeQuery(),
        this.localCache.onMutate({ tables }),
      ]);
      return result;
    }

    if (!this.localCacheConfig || type !== 'select') return executeQuery();

    const isTag = this.localCacheConfig.tag !== undefined;
    const key = this.localCacheConfig.tag ?? await hashQuery(queryString, params);
    const cached = await this.localCache.get(
      key,
      tables,
      isTag,
      this.localCacheConfig.autoInvalidate,
    );

    if (cached !== undefined) return cached as unknown as TResult;

    const result = await executeQuery();
    await this.localCache.put(
      key,
      result,
      this.localCacheConfig.autoInvalidate ? tables : [],
      isTag,
      this.localCacheConfig.config,
    );

    return result;
  }
}
