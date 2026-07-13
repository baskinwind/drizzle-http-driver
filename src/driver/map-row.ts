import type { SelectedFieldsOrdered } from 'drizzle-orm/pg-core/query-builders/select.types';
import type { DriverValueDecoder } from 'drizzle-orm/sql/sql';

import { Column } from 'drizzle-orm/column';
import { is } from 'drizzle-orm/entity';
import { SQL } from 'drizzle-orm/sql';
import { Subquery } from 'drizzle-orm/subquery';
import { getTableName } from 'drizzle-orm/table';

type Decoder = DriverValueDecoder<unknown, unknown>;
type InternalSql = { decoder: Decoder } & SQL;
type InternalAliasedSql = { sql: InternalSql } & SQL.Aliased;
type InternalSubquery = { _: { sql: InternalSql } & Subquery['_'] } & Subquery;

interface RowObject {
  [key: string]: RowObject | unknown;
}

const getFieldDecoder = (
  field: SelectedFieldsOrdered[number]['field'],
): Decoder => {
  if (is(field, Column)) return field;
  if (is(field, SQL)) return (field as InternalSql).decoder;
  if (is(field, Subquery)) return (field as InternalSubquery)._.sql.decoder;

  return (field as InternalAliasedSql).sql.decoder;
};

export const mapRow = (
  fields: SelectedFieldsOrdered,
  row: unknown[],
  joinsNotNullableMap?: Record<string, boolean>,
) => {
  const nullifyMap: Record<string, boolean | string> = {};
  const result = fields.reduce<RowObject>(
    (mappedRow, { path, field }, columnIndex) => {
      const decoder = getFieldDecoder(field);
      let node = mappedRow;

      for (const [pathChunkIndex, pathChunk] of path.entries()) {
        if (pathChunkIndex < path.length - 1) {
          node[pathChunk] ??= {};
          node = node[pathChunk] as RowObject;
          continue;
        }

        const rawValue = row[columnIndex];
        node[pathChunk] = rawValue === null
          ? null
          : decoder.mapFromDriverValue(rawValue);

        if (joinsNotNullableMap && is(field, Column) && path.length === 2) {
          const objectName = path[0]!;
          const tableName = getTableName(field.table);

          if (!(objectName in nullifyMap)) {
            nullifyMap[objectName] = rawValue === null ? tableName : false;
          }
          else if (
            typeof nullifyMap[objectName] === 'string'
            && nullifyMap[objectName] !== tableName
          ) {
            nullifyMap[objectName] = false;
          }
        }
      }

      return mappedRow;
    },
    {},
  );

  if (joinsNotNullableMap) {
    for (const [objectName, tableName] of Object.entries(nullifyMap)) {
      if (typeof tableName === 'string' && !joinsNotNullableMap[tableName]) {
        result[objectName] = null;
      }
    }
  }

  return result;
};
