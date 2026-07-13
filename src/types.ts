import type { PgQueryResultHKT } from 'drizzle-orm/pg-core/session';
import type { Assume } from 'drizzle-orm/utils';

export type MaybePromise<T> = Promise<T> | T;

export type DrizzleProxyQueryMethod = 'all' | 'values';

export interface DrizzleProxyQueryConfig {
  name?: string;
  rowMode?: string;
  text?: string;
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
  connectionEstablishedAt: number;
  connectionStartedAt: number;
  dbConfigStartedAt: number;
  endedAt: number;
  startedAt: number;
  tokenStartedAt: number;
}

export interface DrizzleProxyQueryResult<TRow = Record<string, unknown>> {
  command: string;
  fields: unknown[];
  oid: number;
  rowCount: number;
  rows: TRow[];
  timing?: DrizzleProxyTiming;
}

export type DrizzleProxyResponse<TRow = Record<string, unknown>> = Partial<
  DrizzleProxyQueryResult<TRow>
>;

export type DrizzleProxySerialize = (
  body: DrizzleProxyReleaseRequest | DrizzleProxyRequest,
) => BodyInit;

export type DrizzleProxyParseResponse = (response: Response) => Promise<unknown>;

export type DrizzleProxyHeaders = HeadersInit | (() => MaybePromise<HeadersInit>);

export interface DrizzleProxyConfig {
  /** HTTP endpoint that receives Drizzle proxy query requests. */
  endpoint: string;
  /** Tenant access token used to identify and authorize a tenant. Sent as x-db-token. */
  token: string | (() => MaybePromise<string>);
  /** Key of a complete database connection config under the authorized tenant. */
  key: string;
  /** Additional headers or an async header factory. */
  headers?: DrizzleProxyHeaders;
  /** Custom fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Request options shared by query and release calls. */
  requestInit?: Omit<RequestInit, 'body' | 'headers' | 'method'>;
  /** Path appended to endpoint when releasing a transaction. */
  releasePath?: string;
  /** Override response decoding. Defaults to response.json(). */
  parseResponse?: DrizzleProxyParseResponse;
  /** Override request encoding. Defaults to JSON with bigint encoded as string. */
  serialize?: DrizzleProxySerialize;
  /** Override transaction id creation. */
  transactionId?: () => string;
}

export interface DrizzleProxyClientLike {
  query(
    query: DrizzleProxyQuery,
    params?: unknown[],
  ): Promise<DrizzleProxyQueryResult<unknown[] | Record<string, unknown>>>;
}

export interface DrizzleProxyPoolLike extends DrizzleProxyClientLike {
  connect(): Promise<DrizzleProxyTransactionClient>;
}

export interface DrizzleProxyTransactionClient extends DrizzleProxyClientLike {
  release(): Promise<void>;
}

export interface DrizzleProxyQueryResultHKT extends PgQueryResultHKT {
  type: DrizzleProxyQueryResult<Assume<this['row'], Record<string, unknown>>>;
}

export type QueryMetadata = {
  tables: string[];
  type: 'delete' | 'insert' | 'select' | 'update';
};
