export { drizzle, type DrizzleHttpDatabase } from './driver/drizzle';
export { HttpPgDatabase } from './driver/database';
export { HttpPgPreparedQuery } from './driver/prepared-query';
export { HttpPgSession, type HttpPgSessionOptions } from './driver/session';
export { HttpPgTransaction } from './driver/transaction';

export { DrizzleProxyClient } from './http/client';
export { DrizzleProxyError, type DrizzleProxyErrorOptions } from './http/error';
export { DrizzleProxyPool } from './http/pool';

export type {
  DrizzleProxyClientLike,
  DrizzleProxyConfig,
  DrizzleProxyHeaders,
  DrizzleProxyParseResponse,
  DrizzleProxyPoolLike,
  DrizzleProxyQuery,
  DrizzleProxyQueryConfig,
  DrizzleProxyQueryMethod,
  DrizzleProxyQueryResult,
  DrizzleProxyQueryResultHKT,
  DrizzleProxyReleaseRequest,
  DrizzleProxyRequest,
  DrizzleProxyResponse,
  DrizzleProxySerialize,
  DrizzleProxyTiming,
  DrizzleProxyTransactionClient,
} from './types';
