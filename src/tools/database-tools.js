import { quoteIdentifier } from '../database.js';
import { AppError } from '../errors.js';
import { listResult, maxBytesFor, toolResult } from './tool-result.js';

const DEFAULT_SCHEMA = 'dbo';

// Object names only. list_tables answers a question about objects, so it must not join columns:
// the full catalog query returns one row per column (3,622 on Uranus) to produce 178 objects, and
// it runs two OUTER APPLY blocks that no caller of this query reads.
const OBJECTS_SQL = `
      SELECT
        s.name AS schema_name,
        o.name AS object_name,
        o.type_desc AS object_type
      FROM sys.objects o
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.type IN ('U', 'V')
        AND s.name = @schema
      ORDER BY s.name, o.name;
    `;

function schemaName(value) {
  return value || DEFAULT_SCHEMA;
}

function catalogQuery({ database, schema, table, pattern, tableFilter }) {
  const schemaParam = schemaName(schema);
  const schemaClause = 'AND s.name = @schema';
  const tableClause = table ? 'AND o.name = @table' : '';
  const patternClause = pattern ? 'AND c.name LIKE @pattern' : '';
  const tableFilterClause = tableFilter ? `AND o.name IN (${tableFilter.map((_, index) => `@table${index}`).join(', ')})` : '';
  return {
    sql: `
      SELECT
        s.name AS schema_name,
        o.name AS object_name,
        o.type_desc AS object_type,
        c.name AS column_name,
        ty.name AS data_type,
        c.max_length,
        c.is_nullable,
        dc.definition AS default_definition,
        CASE WHEN pk.column_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS is_primary_key,
        CASE WHEN fk.parent_column_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS is_foreign_key,
        fk.referenced_schema_name,
        fk.referenced_object_name,
        fk.referenced_column_name
      FROM sys.objects o
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      LEFT JOIN sys.columns c ON c.object_id = o.object_id
      LEFT JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
      OUTER APPLY (
        SELECT ic.column_id
        FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        WHERE i.object_id = o.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id
      ) pk
      OUTER APPLY (
        SELECT
          fkc.parent_column_id,
          rs.name AS referenced_schema_name,
          ro.name AS referenced_object_name,
          rc.name AS referenced_column_name
        FROM sys.foreign_key_columns fkc
        JOIN sys.objects ro ON ro.object_id = fkc.referenced_object_id
        JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
        JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
        WHERE fkc.parent_object_id = o.object_id AND fkc.parent_column_id = c.column_id
      ) fk
      WHERE o.type IN ('U', 'V')
        ${schemaClause}
        ${tableClause}
        ${patternClause}
        ${tableFilterClause}
      ORDER BY s.name, o.name, c.column_id;
    `,
    schemaParam,
    table,
    pattern: pattern ? `%${pattern}%` : undefined,
    tableFilter,
  };
}

function addCatalogParams(request, query) {
  request.input('schema', query.schemaParam);
  if (query.table) request.input('table', query.table);
  if (query.pattern) request.input('pattern', query.pattern);
  for (const [index, table] of (query.tableFilter || []).entries()) {
    request.input(`table${index}`, table);
  }
}

async function queryCatalog(database, args) {
  const pool = await database.getPool(args.connection, args.database);
  const query = catalogQuery(args);
  const request = pool.request();
  addCatalogParams(request, query);
  const result = await request.query(query.sql);
  return result.recordset;
}

async function queryObjects(database, args) {
  const pool = await database.getPool(args.connection, args.database);
  const request = pool.request();
  request.input('schema', schemaName(args.schema));
  const result = await request.query(OBJECTS_SQL);
  return result.recordset;
}

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
      const pool = await database.getPool(connection, 'master');
      const result = await pool.request().query(`
        SELECT name
        FROM sys.databases
        ORDER BY name;
      `);
      const config = database.getConnection(connection);
      const names = result.recordset.map((row) => row.name);
      return listResult({
        list: names,
        maxBytes: maxBytesFor(database, connection),
        build: (kept, marker) => ({ current: config.database, databases: kept, ...marker }),
      });
    },

    list_tables: async ({ connection, database: databaseName, schema }) => {
      const rows = await queryObjects(database, { connection, database: databaseName, schema });
      const objects = rows.map((row) => ({
        name: row.object_name,
        type: row.object_type === 'VIEW' ? 'view' : 'table',
      }));
      // The complete list stays a bare array, which is the shape callers already depend on. A
      // partial list becomes an object carrying the marker, so the two cases cannot be confused.
      return listResult({
        list: objects,
        maxBytes: maxBytesFor(database, connection),
        build: (kept, marker) => (marker.truncated ? { items: kept, ...marker } : kept),
      });
    },

    describe_table: async ({ connection, database: databaseName, schema, table }) => {
      const rows = await queryCatalog(database, { connection, database: databaseName, schema, table });
      if (rows.length === 0) {
        throw new AppError(`Table or view "${schemaName(schema)}.${table}" was not found.`, {
          code: 'TABLE_NOT_FOUND',
        });
      }
      const columns = rows.filter((row) => row.column_name).map(normalizeColumn);
      return listResult({
        list: columns,
        maxBytes: maxBytesFor(database, connection),
        build: (kept, marker) => ({
          schema: schemaName(schema),
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
      const rows = await queryCatalog(database, { connection, database: databaseName, schema, pattern });
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
      const rows = await queryCatalog(database, { connection, database: databaseName, schema });
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
          schema: schemaName(schema),
          tables: kept,
          total_tables: entries.length,
          ...marker,
        }),
      });
    },

    get_erd: async ({ connection, database: databaseName, schema, tables }) => {
      if (Array.isArray(tables) && tables.length === 0) {
        return toolResult({
          schema: schemaName(schema),
          tables: [],
          relationships: [],
          total_tables: 0,
          total_relationships: 0,
        }, { maxBytes: maxBytesFor(database, connection) });
      }
      const rows = await queryCatalog(database, {
        connection,
        database: databaseName,
        schema,
        tableFilter: tables?.length ? tables : undefined,
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
            schema: schemaName(schema),
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

export { quoteIdentifier };
