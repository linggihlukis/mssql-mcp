import sql from 'mssql';
import { AppError } from '../errors.js';
import { createReadOnlyGuard } from './syntax.js';

const IDENTIFIER_PART = /^[A-Za-z_][A-Za-z0-9_$#@]*$/;

export const MSSQL_CONFIG = Object.freeze({
  defaultPort: 1433,
  allowEmptyPassword: false,
  optionKeys: Object.freeze(['encrypt', 'trustServerCertificate', 'enableArithAbort']),
  optionDefaults: Object.freeze({ encrypt: false, trustServerCertificate: true, enableArithAbort: true }),
});

const DEFAULT_SCHEMA = 'dbo';

const MSSQL_SYNTAX = Object.freeze({
  lineComments: Object.freeze(['--']),
  blockComment: Object.freeze({ open: '/*', close: '*/' }),
  identifierQuotes: Object.freeze([Object.freeze({ open: '[', close: ']' })]),
  stringQuotes: Object.freeze([
    Object.freeze({ quote: "'", doubled: true }),
    Object.freeze({ quote: '"', doubled: true }),
  ]),
  wordChars: /[A-Za-z0-9_$#@]/,
  wordStart: /[A-Za-z_]/,
  allowedFirstWords: Object.freeze(['SELECT', 'WITH', 'VALUES', 'TABLE', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC']),
  depthZeroBanned: Object.freeze(['INTO', 'OPENROWSET', 'OPENDATASOURCE', 'USE']),
  withBanned: Object.freeze(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'EXEC', 'EXECUTE']),
});

export const assertReadOnlyQuery = createReadOnlyGuard(MSSQL_SYNTAX);

export function quoteIdentifier(identifier, field = 'identifier') {
  if (typeof identifier !== 'string' || !IDENTIFIER_PART.test(identifier)) {
    throw new AppError(`Invalid ${field} "${identifier}".`, { code: 'INVALID_IDENTIFIER' });
  }
  return `[${identifier.replaceAll(']', ']]')}]`;
}

export function quoteMultipartIdentifier(identifier, field = 'identifier') {
  if (typeof identifier !== 'string' || identifier.trim() === '') {
    throw new AppError(`Invalid ${field}.`, { code: 'INVALID_IDENTIFIER' });
  }
  const parts = identifier.split('.');
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !IDENTIFIER_PART.test(part))) {
    throw new AppError(`Invalid ${field} "${identifier}".`, { code: 'INVALID_IDENTIFIER' });
  }
  return parts.map((part) => quoteIdentifier(part, field)).join('.');
}

function buildPoolConfig(connection, database) {
  return {
    server: connection.host,
    port: connection.port,
    database: database || connection.database,
    user: connection.username,
    password: connection.password,
    connectionTimeout: connection.connection_timeout_ms,
    requestTimeout: connection.query_timeout_ms,
    options: connection.options,
    pool: {
      max: 5,
      min: 0,
      idleTimeoutMillis: 30_000,
    },
  };
}

function columnType(column) {
  const typeName = column.type?.declaration || column.type?.name || column.type;
  return typeof typeName === 'string' ? typeName.toLowerCase() : String(typeName ?? 'unknown');
}

/**
 * Column descriptors for the first recordset.
 *
 * `mssql` describes columns in two shapes and this function is the one place that knows both.
 * Object mode gives a map keyed by column name. `arrayRowMode` gives an array with one entry per
 * recordset, each entry holding that recordset's descriptors in order.
 */
export function columnDescriptors(columns) {
  if (Array.isArray(columns)) {
    const recordsetColumns = Array.isArray(columns[0]) ? columns[0] : columns;
    return recordsetColumns.map((metadata, index) => ({
      name: metadata?.name || `column_${index + 1}`,
      data_type: columnType(metadata ?? {}),
      default_value: null,
      is_nullable: metadata?.nullable ?? null,
      is_primary_key: false,
      is_foreign_key: false,
    }));
  }
  return Object.entries(columns ?? {}).map(([name, metadata]) => ({
    name,
    data_type: columnType(metadata ?? {}),
    default_value: null,
    is_nullable: null,
    is_primary_key: false,
    is_foreign_key: false,
  }));
}

async function runQuery(pool, sqlText) {
  const request = pool.request();
  request.arrayRowMode = true;
  const result = await request.query(sqlText);
  const rows = result.recordset ?? [];
  return { columns: columnDescriptors(result.columns), rows, totalRows: rows.length };
}

async function runPlan(pool, { sql: text, params = {} }) {
  const request = pool.request();
  for (const [name, value] of Object.entries(params)) request.input(name, value);
  const result = await request.query(text);
  return result.recordset ?? [];
}

async function listDatabases(pool) {
  const result = await pool.request().query(`
        SELECT name
        FROM sys.databases
        ORDER BY name;
      `);
  return result.recordset.map((row) => row.name);
}

// Object names only. list_tables answers a question about objects, so it must not join columns:
// the full catalog query returns one row per column (3,622 on Uranus) to produce 178 objects, and
// it runs two OUTER APPLY blocks that no caller of this query reads.
function objectsPlan(scope) {
  return {
    sql: `
      SELECT
        s.name AS schema_name,
        o.name AS object_name,
        o.type_desc AS object_type
      FROM sys.objects o
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.type IN ('U', 'V')
        AND s.name = @schema
      ORDER BY s.name, o.name;
    `,
    params: { schema: scope.schema },
  };
}

function catalogPlan(scope, { table, pattern, tables } = {}) {
  const params = { schema: scope.schema };
  const tableClause = table ? 'AND o.name = @table' : '';
  if (table) params.table = table;
  const patternClause = pattern ? 'AND c.name LIKE @pattern' : '';
  if (pattern) params.pattern = `%${pattern}%`;
  const tableFilterClause = tables?.length
    ? `AND o.name IN (${tables.map((_, index) => `@table${index}`).join(', ')})`
    : '';
  tables?.forEach((name, index) => {
    params[`table${index}`] = name;
  });
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
        AND s.name = @schema
        ${tableClause}
        ${patternClause}
        ${tableFilterClause}
      ORDER BY s.name, o.name, c.column_id;
    `,
    params,
  };
}

function previewPlan(scope, limit) {
  const safeSchema = quoteIdentifier(scope.schema, 'schema');
  const safeTable = quoteIdentifier(scope.table, 'table');
  const rowLimit = Number.isInteger(limit) && limit > 0 ? limit : 100;
  return { sql: `SELECT TOP (${rowLimit}) * FROM ${safeSchema}.${safeTable};`, params: {} };
}

// The tools coerce these three with Boolean(), and Boolean('NO') is true, so the dialect is the one
// place a string cannot leak through as a false positive.
function mapCatalogRows(rows) {
  return rows.map((row) => ({
    schema_name: row.schema_name,
    object_name: row.object_name,
    object_type: row.object_type,
    column_name: row.column_name,
    data_type: row.data_type,
    max_length: row.max_length,
    is_nullable: Boolean(row.is_nullable),
    default_definition: row.default_definition,
    is_primary_key: Boolean(row.is_primary_key),
    is_foreign_key: Boolean(row.is_foreign_key),
    referenced_schema_name: row.referenced_schema_name,
    referenced_object_name: row.referenced_object_name,
    referenced_column_name: row.referenced_column_name,
  }));
}

// SQL Server has two namespace levels, so `database` and `schema` are different things and both
// are used. A database on its own still needs a schema to read from, and the default is the one
// SQL Server itself uses.
function resolveScope(connection, { database, schema } = {}) {
  return {
    database: database || connection.database,
    schema: schema || DEFAULT_SCHEMA,
  };
}

function defaultSchema() {
  return DEFAULT_SCHEMA;
}

export function createMssqlDialect({ driver = sql } = {}) {
  return {
    name: 'mssql',
    config: MSSQL_CONFIG,
    serverDatabase: 'master',
    quoteIdentifier,
    assertReadOnly: assertReadOnlyQuery,
    buildPoolConfig,
    createPool: (poolConfig) => new driver.ConnectionPool(poolConfig),
    poolUsable: (pool) => Boolean(pool?.connected),
    ready: (pool) => pool.connect(),
    closePool: (pool) => pool.close(),
    runQuery,
    runPlan,
    listDatabases,
    objectsPlan,
    catalogPlan,
    previewPlan,
    mapCatalogRows,
    resolveScope,
    defaultSchema,
  };
}
