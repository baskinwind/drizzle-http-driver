import type { PgQueryResultHKT } from 'drizzle-orm/pg-core/session';
import type { Assume } from 'drizzle-orm/utils';
import type { DrizzleProxyQueryResult } from '../../types.js';

export interface DrizzleProxyQueryResultHKT extends PgQueryResultHKT {
  type: DrizzleProxyQueryResult<Assume<this['row'], Record<string, unknown>>>;
}
