import { entityKind } from 'drizzle-orm/entity';
import { MySqlDatabase } from 'drizzle-orm/mysql-core/db';
import type { MySqlRemotePreparedQueryHKT, MySqlRemoteQueryResultHKT } from 'drizzle-orm/mysql-proxy/session';
import type { DrizzleProxyClient } from '../../http/client.js';

export class HttpMySqlDatabase<TSchema extends Record<string, unknown> = Record<string, never>>
  extends MySqlDatabase<MySqlRemoteQueryResultHKT, MySqlRemotePreparedQueryHKT, TSchema> {
  static readonly [entityKind] = 'HttpMySqlDatabase';
  declare $client: DrizzleProxyClient;
}
