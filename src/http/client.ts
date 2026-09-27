import { request } from './request.js';

import type { DrizzleProxyConfig, DrizzleProxyQuery, DrizzleProxyQueryMethod, DrizzleProxyQueryResult, DrizzleProxyRequest } from '../types.js';

const getQueryText = (query: DrizzleProxyQuery) => {
  return typeof query === 'string' ? query : query.text;
};

const getQueryMethod = (query: DrizzleProxyQuery): DrizzleProxyQueryMethod => {
  return typeof query !== 'string' && query.rowMode === 'array' ? 'values' : 'all';
};

const getReleaseEndpoint = (endpoint: string) => {
  return `${endpoint.replace(/\/$/, '')}/release`;
};

export class DrizzleProxyClient {
  readonly transactionId: string | undefined;

  private readonly config: DrizzleProxyConfig;
  private releasePromise?: Promise<void>;
  private released = false;

  constructor(config: DrizzleProxyConfig, transactionId?: string) {
    if (!config.endpoint || !config.token || !config.key) {
      throw new Error('Drizzle proxy endpoint, token and key are required');
    }
    this.config = { ...config };
    this.transactionId = transactionId;
  }

  async connect() {
    return new DrizzleProxyClient(this.config, globalThis.crypto.randomUUID());
  }

  async query<T extends unknown[] | Record<string, unknown>>(
    query: DrizzleProxyQuery,
    params: unknown[] = [],
  ) {
    if (this.released) {
      throw new Error('Cannot query with a released Drizzle proxy client');
    }

    const sql = getQueryText(query);
    if (!sql) throw new Error('DB proxy query text is required');

    const requestBody: DrizzleProxyRequest = {
      key: this.config.key,
      method: getQueryMethod(query),
      params,
      ...(typeof query !== 'string' && query.transactionOptions ? { transaction_options: query.transactionOptions } : {}),
      sql,
      ...(this.transactionId ? { transaction_id: this.transactionId } : {}),
    };

    return request<DrizzleProxyQueryResult<T>>(this.config, this.config.endpoint, requestBody);
  }

  release(): Promise<void> {
    if (!this.transactionId) return Promise.resolve();
    if (this.releasePromise) return this.releasePromise;

    this.released = true;
    const endpoint = getReleaseEndpoint(this.config.endpoint);
    // Cancellation of an application query must not cancel its rollback too.
    // Bound cleanup independently so an unreachable proxy cannot hang forever.
    const cleanupConfig = {
      ...this.config,
      requestInit: { ...this.config.requestInit, signal: AbortSignal.timeout(30_000) },
    };
    this.releasePromise = request<void>(cleanupConfig, endpoint, {
      key: this.config.key,
      transaction_id: this.transactionId!,
    });

    return this.releasePromise;
  }
}
