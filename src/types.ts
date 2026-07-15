import type { PgQueryResultHKT } from 'drizzle-orm/pg-core/session';
import type { Assume } from 'drizzle-orm/utils';

export type DrizzleProxyQueryMethod = 'all' | 'values';

export interface DrizzleProxyQueryConfig {
  rowMode?: 'array';
  text: string;
}

export type DrizzleProxyQuery = DrizzleProxyQueryConfig | string;

export interface DrizzleProxyRequest {
  /** Database connection config key within the authorized tenant. */
  key: string;
  method: DrizzleProxyQueryMethod;
  params: unknown[];
  sql: string;
  transaction_id?: string;
}

export interface DrizzleProxyReleaseRequest {
  /** Database connection config key within the authorized tenant. */
  key: string;
  transaction_id: string;
}

export interface DrizzleProxyTiming {
  coldStart: boolean;
  connectionEstablishedAt?: number;
  connectionStartedAt?: number;
  dbConfigStartedAt?: number;
  endedAt: number;
  startedAt: number;
  tokenStartedAt?: number;
}

export interface DrizzleProxyQueryResult<TRow = Record<string, unknown>> {
  command: string;
  fields: unknown[];
  oid: number;
  rowCount: number | null;
  rows: TRow[];
  timing: DrizzleProxyTiming;
}

export interface DrizzleProxyConfig {
  /** Complete Drizzle proxy query endpoint, for example /api/query. */
  endpoint: string;
  /** Tenant access token used to identify and authorize a tenant. Sent as x-db-token. */
  token: string;
  /** Key of a complete database connection config under the authorized tenant. */
  key: string;
  /** Additional request headers. */
  headers?: HeadersInit;
  /** Request options shared by query and release calls. */
  requestInit?: Omit<RequestInit, 'body' | 'headers' | 'method'>;
}

export interface DrizzleProxyClientLike {
  query<T extends unknown[] | Record<string, unknown>>(
    query: DrizzleProxyQuery,
    params?: unknown[],
  ): Promise<DrizzleProxyQueryResult<T>>;
}

export interface DrizzleProxyQueryResultHKT extends PgQueryResultHKT {
  type: DrizzleProxyQueryResult<Assume<this['row'], Record<string, unknown>>>;
}
