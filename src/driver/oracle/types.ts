import type { Logger } from 'drizzle-orm/logger';

export interface OracleTransactionConfig {
  isolationLevel?: 'read committed' | 'serializable';
  accessMode?: 'read only' | 'read write';
}
export interface DrizzleOracleConfig { logger?: Logger | boolean }
