import { AppError } from '../errors.js';
import { listResult, maxBytesFor, toolResult } from './tool-result.js';

function normalizeType(row) {
  return String(row.data_type || 'unknown').toLowerCase();
}

function normalizeColumn(row) {
  return {
    name: row.column_name,
    nullable: Boolean(row.is_nullable),
    primary_key: Boolean(row.is_primary_key),
    type: normalizeType(row),
    ...(row.default_definition ? { default: row.default_definition } : {}),
  };
}

export function createDatabaseTools({ database }) {
  return {
    list_connections: async () => {
      const details = await database.listConnectionDetails();
      return listResult({
        list: details,
        maxBytes: maxBytesFor(database),
        build: (kept, marker) => (marker.truncated ? { connections: kept, ...marker } : kept),
      });
    },

    list_databases: async ({ connection }) => {
      const { current, databases } = await database.listDatabases(connection);
      return listResult({
        list: databases,
        maxBytes: maxBytesFor(database, connection),
        build: (kept, marker) => ({ current, databases: kept, ...marker }),
      });
    },

    list_tables: async ({ connection, database: databaseName, schema }) => {
      const { objects } = await database.listObjects({ connection, database: databaseName, schema });
      const items = objects.map((object) => ({
        name: object.object_name,
        type: object.object_type === 'VIEW' ? 'view' : 'table',
      }));
      // The complete list stays a bare array, which is the shape callers already depend on. A
      // partial list becomes an object carrying the marker, so the two cases cannot be confused.
      return listResult({
        list: items,
        maxBytes: maxBytesFor(database, connection),
        build: (kept, marker) => (marker.truncated ? { items: kept, ...marker } : kept),
      });
    },

    describe_table: async ({ connection, database: databaseName, schema, table }) => {
      const { schema: effectiveSchema, rows } = await database.describeCatalog({
        connection,
        database: databaseName,
        schema,
        table,
      });
      if (rows.length === 0) {
        throw new AppError(`Table or view "${effectiveSchema}.${table}" was not found.`, {
          code: 'TABLE_NOT_FOUND',
        });
      }
      const columns = rows.filter((row) => row.column_name).map(normalizeColumn);
      return listResult({
        list: columns,
        maxBytes: maxBytesFor(database, connection),
        build: (kept, marker) => ({
          schema: effectiveSchema,
          table,
          columns: kept,
          ...marker,
        }),
      });
    },

    execute_sql: async ({ connection, database: databaseName, row_limit: rowLimit, sql }) => {
      const value = await database.query(connection, sql, { database: databaseName, rowLimit });
      // Already bounded by the row limit and the byte cap inside the query layer. This wrapper is the
      // backstop that keeps every tool on one path, and it passes such a result through untouched.
      return toolResult(value, { maxBytes: maxBytesFor(database, connection) });
    },

    search_columns: async ({ connection, database: databaseName, pattern, schema }) => {
      const { rows } = await database.describeCatalog({
        connection,
        database: databaseName,
        schema,
        pattern,
      });
      const matches = rows.filter((row) => row.column_name).map((row) => ({
        column: row.column_name,
        nullable: Boolean(row.is_nullable),
        primary_key: Boolean(row.is_primary_key),
        table: row.object_name,
        type: normalizeType(row),
      }));
      return listResult({
        list: matches,
        maxBytes: maxBytesFor(database, connection),
        build: (kept, marker) => ({ count: matches.length, matches: kept, ...marker }),
      });
    },

    get_schema_summary: async ({ connection, database: databaseName, schema }) => {
      const { schema: effectiveSchema, rows } = await database.describeCatalog({
        connection,
        database: databaseName,
        schema,
      });
      const tables = new Map();
      for (const row of rows) {
        const key = `${row.schema_name}.${row.object_name}`;
        const current = tables.get(key) || {
          name: row.object_name,
          type: row.object_type === 'VIEW' ? 'view' : 'table',
          column_count: 0,
        };
        if (row.column_name) current.column_count += 1;
        tables.set(key, current);
      }
      const entries = [...tables.values()];
      return listResult({
        list: entries,
        maxBytes: maxBytesFor(database, connection),
        build: (kept, marker) => ({
          schema: effectiveSchema,
          tables: kept,
          total_tables: entries.length,
          ...marker,
        }),
      });
    },

    get_erd: async ({ connection, database: databaseName, schema, tables }) => {
      if (Array.isArray(tables) && tables.length === 0) {
        // An empty filter needs no query, so the schema is resolved without opening a pool.
        return toolResult({
          schema: schema || database.defaultSchema(connection),
          tables: [],
          relationships: [],
          total_tables: 0,
          total_relationships: 0,
        }, { maxBytes: maxBytesFor(database, connection) });
      }
      const { schema: effectiveSchema, rows } = await database.describeCatalog({
        connection,
        database: databaseName,
        schema,
        tables: tables?.length ? tables : undefined,
      });
      const grouped = new Map();
      const relationships = [];
      for (const row of rows) {
        const key = `${row.schema_name}.${row.object_name}`;
        const table = grouped.get(key) || {
          name: row.object_name,
          type: row.object_type === 'VIEW' ? 'view' : 'table',
          columns: [],
        };
        if (row.column_name) table.columns.push(normalizeColumn(row));
        grouped.set(key, table);
        if (row.referenced_object_name) {
          relationships.push({
            from_table: row.object_name,
            from_column: row.column_name,
            to_table: row.referenced_object_name,
            to_column: row.referenced_column_name,
          });
        }
      }
      const entries = [...grouped.values()];
      return listResult({
        list: entries,
        maxBytes: maxBytesFor(database, connection),
        build: (kept, marker) => {
          // A relationship whose source table was cut is dropped with it, so the graph never refers
          // to a table the caller did not receive.
          const names = new Set(kept.map((table) => table.name));
          const keptRelationships = relationships.filter((link) => names.has(link.from_table));
          return {
            schema: effectiveSchema,
            tables: kept,
            relationships: keptRelationships,
            total_tables: entries.length,
            total_relationships: relationships.length,
            ...marker,
          };
        },
      });
    },
  };
}
