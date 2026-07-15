import type { SelectedFieldsOrdered } from 'drizzle-orm/pg-core/query-builders/select.types';
import type { PreparedQueryConfig } from 'drizzle-orm/pg-core/session';
import type { Query } from 'drizzle-orm/sql';

import { entityKind } from 'drizzle-orm/entity';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import type { Logger } from 'drizzle-orm/logger';
import { PgPreparedQuery } from 'drizzle-orm/pg-core/session';
import { fillPlaceholders } from 'drizzle-orm/sql';

import { mapRow } from './map-row';
import type { DrizzleProxyClientLike } from '../types';

export class HttpPgPreparedQuery<T extends PreparedQueryConfig> extends PgPreparedQuery<T> {
  static readonly [entityKind] = 'HttpPgPreparedQuery';

  protected joinsNotNullableMap?: Record<string, boolean>;

  private readonly client: DrizzleProxyClientLike;
  private readonly fields: SelectedFieldsOrdered | undefined;
  private readonly httpQuery: Query;
  private readonly logger: Logger;
  private readonly responseInArrayMode: boolean;
  private readonly customResultMapper: ((rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => T['execute']) | undefined;

  constructor(
    client: DrizzleProxyClientLike,
    httpQuery: Query,
    logger: Logger,
    fields: SelectedFieldsOrdered | undefined,
    responseInArrayMode: boolean,
    customResultMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => T['execute'],
  ) {
    super(httpQuery, undefined, undefined);
    this.client = client;
    this.fields = fields;
    this.httpQuery = httpQuery;
    this.logger = logger;
    this.responseInArrayMode = responseInArrayMode;
    this.customResultMapper = customResultMapper;
  }

  async execute(placeholderValues: Record<string, unknown> = {}) {
    const params = fillPlaceholders(this.httpQuery.params, placeholderValues);
    this.logger.logQuery(this.httpQuery.sql, params);

    if (!this.fields && !this.customResultMapper) {
      return this.executeQuery(params) as Promise<T['execute']>;
    }

    const result = await this.executeQuery(params, true);
    const rows = result.rows as unknown[][];

    if (this.customResultMapper) return this.customResultMapper(rows);

    return rows.map((row) => {
      return mapRow(this.fields!, row, this.joinsNotNullableMap);
    }) as T['execute'];
  }

  async all(placeholderValues: Record<string, unknown> = {}) {
    const params = fillPlaceholders(this.httpQuery.params, placeholderValues);
    this.logger.logQuery(this.httpQuery.sql, params);

    const result = await this.executeQuery(params);

    return result.rows as T['all'];
  }

  isResponseInArrayMode() {
    return this.responseInArrayMode;
  }

  private async executeQuery(params: unknown[], arrayMode = false) {
    try {
      return await this.client.query(
        arrayMode
          ? { rowMode: 'array', text: this.httpQuery.sql }
          : { text: this.httpQuery.sql },
        params,
      );
    }
    catch (error) {
      throw new DrizzleQueryError(this.httpQuery.sql, params, error as Error);
    }
  }
}
