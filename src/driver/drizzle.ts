import type {
  ExtractTablesWithRelations,
  RelationalSchemaConfig,
} from 'drizzle-orm/relations';
import type { DrizzleConfig } from 'drizzle-orm/utils';

import { NoopCache } from 'drizzle-orm/cache/core';
import { DefaultLogger } from 'drizzle-orm/logger';
import { PgDialect } from 'drizzle-orm/pg-core/dialect';
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
} from 'drizzle-orm/relations';

import { HttpPgDatabase } from './database';
import { HttpPgSession } from './session';

import type { DrizzleProxyPool } from '../http/pool';

export type DrizzleHttpDatabase<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = HttpPgDatabase<TSchema> & { $client: DrizzleProxyPool };

export const drizzle = <
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  client: DrizzleProxyPool,
  config: DrizzleConfig<TSchema> = {},
): DrizzleHttpDatabase<TSchema> => {
  const dialect = new PgDialect({ casing: config.casing });
  const logger = config.logger === true
    ? new DefaultLogger()
    : (config.logger === false ? undefined : config.logger);
  let schema: RelationalSchemaConfig<
    ExtractTablesWithRelations<TSchema>
  > | undefined;

  if (config.schema) {
    const tablesConfig = extractTablesRelationalConfig(
      config.schema,
      createTableRelationsHelpers,
    );
    schema = {
      fullSchema: config.schema,
      schema: tablesConfig.tables,
      tableNamesMap: tablesConfig.tableNamesMap,
    } as RelationalSchemaConfig<ExtractTablesWithRelations<TSchema>>;
  }

  const session = new HttpPgSession(client, dialect, schema, {
    cache: config.cache ?? new NoopCache(),
    logger,
  });
  const db = new HttpPgDatabase<TSchema>(dialect, session, schema);
  const database = db as DrizzleHttpDatabase<TSchema>;

  database.$client = client;
  if (config.cache) {
    const { cache } = config;
    database.$cache.invalidate = (params) => cache.onMutate(params);
  }

  return database;
};
