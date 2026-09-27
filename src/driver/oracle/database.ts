import { CasingCache } from 'drizzle-orm/casing';
import { TransactionRollbackError } from 'drizzle-orm/errors';
import { DefaultLogger, NoopLogger } from 'drizzle-orm/logger';
import type { Logger } from 'drizzle-orm/logger';
import { fillPlaceholders } from 'drizzle-orm/sql';
import type { SQL } from 'drizzle-orm/sql';
import type { DrizzleProxyClient } from '../../http/client.js';
import type { DrizzleProxyQueryResult } from '../../types.js';
import type { DrizzleOracleConfig, OracleTransactionConfig } from './types.js';
import { runOracleSavepoint, runOracleTransaction, validateOracleTransactionConfig } from './transaction.js';

/** SQL-first Oracle adapter. Drizzle has no native Oracle table/query-builder dialect. */
export class HttpOracleDatabase {
  private active = true;
  private nestedActive = false;
  private readonly logger: Logger;
  private readonly casing = new CasingCache();

  constructor(readonly $client: DrizzleProxyClient, private readonly config: DrizzleOracleConfig = {}, private readonly depth = 0) {
    this.logger = config.logger === true ? new DefaultLogger() : config.logger || new NoopLogger();
  }

  private assertActive() {
    if (!this.active) throw new Error('Cannot query with a completed Oracle transaction');
  }

  private compile(query: SQL) {
    // Compile Drizzle's SQL tree directly; never rewrite placeholders in SQL text.
    return query.toQuery({
      casing: this.casing,
      escapeName: name => `"${name.replaceAll('"', '""')}"`,
      escapeParam: index => `:${index + 1}`,
      escapeString: value => `'${value.replaceAll("'", "''")}'`,
    });
  }

  prepare<TRow extends Record<string, unknown> = Record<string, unknown>>(query: SQL) {
    const compiled = this.compile(query);
    return {
      execute: async (placeholders: Record<string, unknown> = {}): Promise<DrizzleProxyQueryResult<TRow>> => {
        this.assertActive();
        const params = fillPlaceholders(compiled.params, placeholders);
        this.logger.logQuery(compiled.sql, params);
        return this.$client.query<TRow>(compiled.sql, params);
      },
    };
  }

  execute<TRow extends Record<string, unknown> = Record<string, unknown>>(query: SQL, placeholders: Record<string, unknown> = {}) {
    return this.prepare<TRow>(query).execute(placeholders);
  }

  async all<TRow extends Record<string, unknown> = Record<string, unknown>>(query: SQL, placeholders: Record<string, unknown> = {}) {
    return (await this.execute<TRow>(query, placeholders)).rows;
  }

  async values(query: SQL, placeholders: Record<string, unknown> = {}): Promise<unknown[][]> {
    this.assertActive();
    const compiled = this.compile(query);
    const params = fillPlaceholders(compiled.params, placeholders);
    this.logger.logQuery(compiled.sql, params);
    return (await this.$client.query<unknown[]>({ text: compiled.sql, rowMode: 'array' }, params)).rows;
  }

  rollback(): never {
    if (!this.depth) throw new Error('rollback() requires an Oracle transaction');
    this.assertActive();
    throw new TransactionRollbackError();
  }

  async transaction<T>(callback: (tx: HttpOracleDatabase) => Promise<T>, config?: OracleTransactionConfig): Promise<T> {
    this.assertActive();
    if (this.depth) {
      if (config) throw new Error('Nested Oracle transactions cannot change transaction configuration');
      if (this.nestedActive) throw new Error('Nested Oracle transactions must be awaited sequentially');
      this.nestedActive = true;
      const name = `drizzle_sp${this.depth}`;
      const tx = new HttpOracleDatabase(this.$client, this.config, this.depth + 1);
      try {
        return await runOracleSavepoint(this.$client, name, () => callback(tx));
      } finally { tx.active = false; this.nestedActive = false; }
    }
    validateOracleTransactionConfig(config);
    const client = await this.$client.connect();
    const tx = new HttpOracleDatabase(client, this.config, 1);
    try {
      return await runOracleTransaction(client, () => callback(tx), config);
    } finally { tx.active = false; }
  }
}
