import { DrizzleProxyClient } from './client';

import type { DrizzleProxyConfig, DrizzleProxyQuery } from '../types';

const createTransactionId = () => {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error(
      'crypto.randomUUID is unavailable. Pass transactionId in DrizzleProxyConfig.',
    );
  }

  return globalThis.crypto.randomUUID();
};

export class DrizzleProxyPool {
  constructor(readonly config: DrizzleProxyConfig) {
    if (!config.endpoint || !config.token || !config.key) {
      throw new Error('Drizzle proxy endpoint, token and key are required');
    }
  }

  query(query: DrizzleProxyQuery, params?: unknown[]) {
    return new DrizzleProxyClient(this.config).query(query, params);
  }

  async connect() {
    const transactionId = (this.config.transactionId ?? createTransactionId)();
    if (!transactionId) throw new Error('Drizzle proxy transaction id is required');

    return new DrizzleProxyClient(this.config, transactionId);
  }

  async end() {
    // HTTP clients do not retain local connections.
  }
}
