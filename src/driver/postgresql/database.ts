import { entityKind } from 'drizzle-orm/entity';
import { PgDatabase } from 'drizzle-orm/pg-core/db';

import type { DrizzleProxyQueryResultHKT } from './types.js';
import type { DrizzleProxyClient } from '../../http/client.js';

export class HttpPgDatabase<
  TSchema extends Record<string, unknown> = Record<string, never>,
> extends PgDatabase<DrizzleProxyQueryResultHKT, TSchema> {
  static readonly [entityKind] = 'HttpPgDatabase';

  declare $client: DrizzleProxyClient;
}
