export interface MySqlTransactionOptions {
  isolationLevel?: 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable';
  accessMode?: 'read only' | 'read write';
  withConsistentSnapshot?: boolean;
}

export type DrizzleProxyQueryMethod = 'all' | 'values';

export interface DrizzleProxyQueryConfig {
  rowMode?: 'array';
  transactionOptions?: MySqlTransactionOptions;
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
  transaction_options?: MySqlTransactionOptions;
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
  insertId?: number | string;
  affectedRows?: number;
  command: string;
  fields: unknown[];
  oid: number;
  rowCount: number | null;
  rows: TRow[];
  /** Present for PostgreSQL/MySQL; Oracle responses omit timing. */
  timing?: DrizzleProxyTiming;
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
  /** Request options. Release uses an independent 30s signal so cancellation cannot prevent rollback. */
  requestInit?: Omit<RequestInit, 'body' | 'headers' | 'method'>;
}

export interface DrizzleProxyClientLike {
  query<T extends unknown[] | Record<string, unknown>>(
    query: DrizzleProxyQuery,
    params?: unknown[],
  ): Promise<DrizzleProxyQueryResult<T>>;
}
