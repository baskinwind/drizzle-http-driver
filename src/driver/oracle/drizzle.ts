import type { DrizzleProxyClient } from '../../http/client.js';
import { HttpOracleDatabase } from './database.js';
import type { DrizzleOracleConfig } from './types.js';

export const drizzle = (client: DrizzleProxyClient, config: DrizzleOracleConfig = {}) => new HttpOracleDatabase(client, config);
