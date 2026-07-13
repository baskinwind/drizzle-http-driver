import { request, normalizeQueryResult } from './request';

import type {
  DrizzleProxyConfig,
  DrizzleProxyQuery,
  DrizzleProxyQueryMethod,
} from '../types';

const getQueryText = (query: DrizzleProxyQuery) => {
  return typeof query === 'string' ? query : query.text;
};

const getQueryMethod = (query: DrizzleProxyQuery): DrizzleProxyQueryMethod => {
  return typeof query !== 'string' && query.rowMode === 'array' ? 'values' : 'all';
};

const getReleaseEndpoint = (endpoint: string, releasePath: string) => {
  return `${endpoint.replace(/\/$/, '')}/${releasePath.replace(/^\//, '')}`;
};

export class DrizzleProxyClient {
  private releasePromise?: Promise<void>;
  private released = false;

  constructor(
    private readonly config: DrizzleProxyConfig,
    readonly transactionId?: string,
  ) {
    if (!config.endpoint || !config.key || !config.token) {
      throw new Error('Drizzle proxy endpoint, key and token are required');
    }
  }

  async query(query: DrizzleProxyQuery, params: unknown[] = []) {
    if (this.released) {
      throw new Error('Cannot query with a released Drizzle proxy client');
    }

    const sql = getQueryText(query);
    if (!sql) throw new Error('DB proxy query text is required');

    const body = await request(this.config, this.config.endpoint, {
      key: this.config.key,
      method: getQueryMethod(query),
      params,
      sql,
      transaction_id: this.transactionId,
    });

    return normalizeQueryResult(body);
  }

  release(): Promise<void> {
    if (!this.transactionId) return Promise.resolve();
    if (this.releasePromise) return this.releasePromise;

    this.released = true;
    this.releasePromise = this.releaseRemote();
    return this.releasePromise;
  }

  private async releaseRemote() {
    const endpoint = getReleaseEndpoint(
      this.config.endpoint,
      this.config.releasePath ?? 'release',
    );

    await request(
      this.config,
      endpoint,
      {
        key: this.config.key,
        transaction_id: this.transactionId!,
      },
      false,
    );
  }
}
