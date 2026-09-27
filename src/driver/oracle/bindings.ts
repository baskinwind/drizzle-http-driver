export interface OracleBind {
  oracleType: 'RAW' | 'BLOB' | 'CLOB' | 'NCLOB' | 'NCHAR' | 'NVARCHAR2';
  /** RAW/BLOB use hexadecimal; other types use text. */
  value: string;
}
export const oracleBind = (oracleType: OracleBind['oracleType'], value: string): OracleBind => ({ oracleType, value });
