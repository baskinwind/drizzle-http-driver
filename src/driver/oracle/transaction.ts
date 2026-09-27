import type { DrizzleProxyClient } from '../../http/client.js';
import type { OracleTransactionConfig } from './types.js';

export function validateOracleTransactionConfig(config?: OracleTransactionConfig) {
  if (config?.isolationLevel && !['read committed', 'serializable'].includes(config.isolationLevel)) throw new Error('Unsupported Oracle isolation level');
  if (config?.accessMode && !['read only', 'read write'].includes(config.accessMode)) throw new Error('Unsupported Oracle access mode');
  if (config?.accessMode === 'read only' && config.isolationLevel) throw new Error('Oracle read only and isolationLevel cannot be combined');
}

export async function runOracleSavepoint<T>(client: DrizzleProxyClient, name: string, callback: () => Promise<T>): Promise<T> {
  await client.query(`savepoint ${name}`);
  // Oracle has no RELEASE SAVEPOINT statement.
  try { return await callback(); }
  catch (error) {
    try { await client.query(`rollback to ${name}`); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Drizzle HTTP savepoint rollback failed'); }
    throw error;
  }
}

export async function runOracleTransaction<T>(client: DrizzleProxyClient, callback: () => Promise<T>, config?: OracleTransactionConfig): Promise<T> {
  try {
    await client.query('begin');
    if (config?.isolationLevel) await client.query(`set transaction isolation level ${config.isolationLevel}`);
    else if (config?.accessMode) await client.query(`set transaction ${config.accessMode}`);
    const result = await callback();
    await client.query('commit');
    await client.release();
    return result;
  } catch (error) {
    try { await client.release(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Drizzle HTTP transaction and cleanup failed'); }
    throw error;
  }
}
