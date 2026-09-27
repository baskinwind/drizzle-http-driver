import { DefaultLogger } from 'drizzle-orm/logger';
import { MySqlDialect } from 'drizzle-orm/mysql-core/dialect';
import type { Mode } from 'drizzle-orm/mysql-core/session';
import { createTableRelationsHelpers, extractTablesRelationalConfig } from 'drizzle-orm/relations';
import type { ExtractTablesWithRelations, RelationalSchemaConfig } from 'drizzle-orm/relations';
import type { DrizzleConfig } from 'drizzle-orm/utils';
import type { DrizzleProxyClient } from '../../http/client.js';
import { HttpMySqlDatabase } from './database.js';
import { HttpMySqlSession } from './session.js';

export type DrizzleMySqlConfig<TSchema extends Record<string, unknown> = Record<string, never>> =
  Omit<DrizzleConfig<TSchema>, 'cache'> & { mode?: Mode };

export function drizzle<TSchema extends Record<string, unknown> = Record<string, never>>(
  client: DrizzleProxyClient, config: DrizzleMySqlConfig<TSchema> = {},
): HttpMySqlDatabase<TSchema> {
  const dialect = new MySqlDialect({ casing: config.casing });
  const logger = config.logger === true ? new DefaultLogger() : config.logger === false ? undefined : config.logger;
  let schema: RelationalSchemaConfig<ExtractTablesWithRelations<TSchema>> | undefined;
  if (config.schema) {
    const tables = extractTablesRelationalConfig(config.schema, createTableRelationsHelpers);
    schema = { fullSchema: config.schema, schema: tables.tables, tableNamesMap: tables.tableNamesMap } as RelationalSchemaConfig<ExtractTablesWithRelations<TSchema>>;
  }
  const mode = config.mode ?? 'default';
  const session = new HttpMySqlSession(client, dialect, schema, { logger }, mode);
  const database = new HttpMySqlDatabase<TSchema>(dialect, session, schema, mode);
  database.$client = client;
  return database;
}
