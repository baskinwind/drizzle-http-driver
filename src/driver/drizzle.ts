import type { ExtractTablesWithRelations, RelationalSchemaConfig } from 'drizzle-orm/relations';
import type { DrizzleConfig } from 'drizzle-orm/utils';

import { DefaultLogger } from 'drizzle-orm/logger';
import { PgDialect } from 'drizzle-orm/pg-core/dialect';
import { createTableRelationsHelpers, extractTablesRelationalConfig } from 'drizzle-orm/relations';

import { HttpPgDatabase } from './database';
import { HttpPgSession } from './session';

import type { DrizzleProxyClient } from '../http/client';

export type DrizzleHttpConfig<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = Omit<DrizzleConfig<TSchema>, 'cache'>;

export const drizzle = <
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  client: DrizzleProxyClient,
  config: DrizzleHttpConfig<TSchema> = {},
): HttpPgDatabase<TSchema> => {
  const dialect = new PgDialect({ casing: config.casing });
  const logger = config.logger === true
    ? new DefaultLogger()
    : (config.logger === false ? undefined : config.logger);
  let schema: RelationalSchemaConfig<ExtractTablesWithRelations<TSchema>> | undefined;

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

  const session = new HttpPgSession(client, dialect, schema, { logger });
  const database = new HttpPgDatabase<TSchema>(dialect, session, schema);
  database.$client = client;

  return database;
};
