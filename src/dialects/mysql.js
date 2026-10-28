import mysql from 'mysql2/promise';
import { AppError } from '../errors.js';
import { createReadOnlyGuard } from './syntax.js';

const IDENTIFIER_PART = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export const MYSQL_CONFIG = Object.freeze({
  defaultPort: 3306,
  // Laragon's MySQL root and `eosys` accounts have no password, so an empty password is a real
  // configuration rather than a missing secret. A missing env var is still CONFIG_SECRET_MISSING.
  allowEmptyPassword: true,
  optionKeys: Object.freeze(['charset', 'timezone', 'ssl']),
  optionDefaults: Object.freeze({}),
});

const MYSQL_SYNTAX = Object.freeze({
  lineComments: Object.freeze(['#', '--']),
  // `SELECT 1--1` is arithmetic in MySQL; `--` only starts a comment when whitespace follows.
  lineCommentNeedsSpace: Object.freeze(['--']),
  blockComment: Object.freeze({ open: '/*', close: '*/' }),
  // `/*!50000 ... */` is executed, not ignored, so its body must stay in the token stream.
  executableComment: '/*!',
  identifierQuotes: Object.freeze([Object.freeze({ open: '`', close: '`' })]),
  stringQuotes: Object.freeze([
    Object.freeze({ quote: "'", doubled: true, backslash: true }),
    Object.freeze({ quote: '"', doubled: true, backslash: true }),
  ]),
  wordChars: /[A-Za-z0-9_$]/,
  wordStart: /[A-Za-z_]/,
  allowedFirstWords: Object.freeze(['SELECT', 'WITH', 'VALUES', 'TABLE', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC']),
  // INTO covers SELECT ... INTO OUTFILE, INTO DUMPFILE and INTO @var. `secure-file-priv=""` is a
  // common Laragon setting, so OUTFILE writes a file on the server and must be refused here.
  depthZeroBanned: Object.freeze(['INTO', 'OUTFILE', 'DUMPFILE']),
  withBanned: Object.freeze(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'CALL', 'LOAD']),
  firstWordBanned: Object.freeze({
    EXPLAIN: Object.freeze(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'CALL', 'LOAD']),
  }),
  bannedSequences: Object.freeze([
    Object.freeze(['FOR', 'UPDATE']),
    Object.freeze(['FOR', 'SHARE']),
    Object.freeze(['LOCK', 'IN', 'SHARE', 'MODE']),
    Object.freeze(['INTO', 'OUTFILE']),
    Object.freeze(['INTO', 'DUMPFILE']),
  ]),
});

export const assertReadOnlyQuery = createReadOnlyGuard(MYSQL_SYNTAX);

// mysql2 reports a numeric type id and no name. These are MySQL's own DATA_TYPE spellings; TEXT and
// ENUM/SET cannot be told apart from BLOB and STRING by id alone, so the broadest name wins.
export const TYPE_NAMES = Object.freeze({
  0: 'decimal',
  1: 'tinyint',
  2: 'smallint',
  3: 'int',
  4: 'float',
  5: 'double',
  6: 'null',
  7: 'timestamp',
  8: 'bigint',
  9: 'mediumint',
  10: 'date',
  11: 'time',
  12: 'datetime',
  13: 'year',
  14: 'date',
  15: 'varchar',
  16: 'bit',
  242: 'vector',
  245: 'json',
  246: 'decimal',
  247: 'enum',
  248: 'set',
  249: 'tinyblob',
  250: 'mediumblob',
  251: 'longblob',
  252: 'blob',
  253: 'varchar',
  254: 'char',
  255: 'geometry',
});

const NOT_NULL_FLAG = 1;

export function quoteIdentifier(identifier, field = 'identifier') {
  if (typeof identifier !== 'string' || !IDENTIFIER_PART.test(identifier)) {
    throw new AppError(`Invalid ${field} "${identifier}".`, { code: 'INVALID_IDENTIFIER' });
  }
  return `\`${identifier}\``;
}

function buildPoolConfig(connection, database) {
  return {
    host: connection.host,
    port: connection.port,
    user: connection.username,
    password: connection.password,
    database: database || connection.database,
    connectTimeout: connection.connection_timeout_ms,
    // Out-of-range BIGINT values arrive as exact strings instead of silently wrong numbers.
    supportBigNumbers: true,
    ...connection.options,
    // Not configurable: a second statement is exactly what the read-only guard exists to stop, and
    // leaving it to the driver would make the guard advisory rather than enforced.
    multipleStatements: false,
  };
}

function columnType(field) {
  return TYPE_NAMES[field?.columnType ?? field?.type] ?? String(field?.columnType ?? 'unknown');
}

function columnDescriptors(fields) {
  return (fields ?? []).map((field, index) => ({
    name: field?.name || `column_${index + 1}`,
    data_type: columnType(field),
    default_value: null,
    is_nullable: field ? (field.flags & NOT_NULL_FLAG) === 0 : null,
    is_primary_key: false,
    is_foreign_key: false,
  }));
}

async function runQuery(pool, sqlText, { timeout } = {}) {
  const [rows, fields] = await pool.query({ sql: sqlText, rowsAsArray: true, timeout });
  // A write statement on a writable connection returns a result header, not rows.
  const resultRows = Array.isArray(rows) ? rows : [];
  return { columns: columnDescriptors(fields), rows: resultRows, totalRows: resultRows.length };
}

async function runPlan(pool, { sql: text, values = [] }) {
  const [rows] = await pool.query({ sql: text, values });
  return Array.isArray(rows) ? rows : [];
}

async function listDatabases(pool) {
  const [rows] = await pool.query({
    sql: 'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
  });
  return rows.map((row) => row.name);
}

// Object names only. The column join returns one row per column (129 on `eosys`) to produce 18
// objects, which is the same cost mistake list_tables was fixed for on SQL Server.
function objectsPlan(scope) {
  return {
    sql: `
      SELECT
        t.TABLE_SCHEMA AS schema_name,
        t.TABLE_NAME AS object_name,
        CASE WHEN t.TABLE_TYPE = 'VIEW' THEN 'VIEW' ELSE 'USER_TABLE' END AS object_type
      FROM information_schema.TABLES t
      WHERE t.TABLE_SCHEMA = ?
        AND t.TABLE_TYPE IN ('BASE TABLE', 'VIEW')
      ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME;
    `,
    values: [scope.schema],
  };
}

function catalogPlan(scope, { table, pattern, tables } = {}) {
  const values = [scope.schema];
  const tableClause = table ? 'AND c.TABLE_NAME = ?' : '';
  if (table) values.push(table);
  const patternClause = pattern ? 'AND c.COLUMN_NAME LIKE ?' : '';
  if (pattern) values.push(`%${pattern}%`);
  const tableFilterClause = tables?.length
    ? `AND c.TABLE_NAME IN (${tables.map(() => '?').join(', ')})`
    : '';
  tables?.forEach((name) => values.push(name));
  return {
    // KEY_COLUMN_USAGE holds one row per (constraint, column), so a column in two foreign keys
    // would otherwise combine the schema of one with the table and column of another.
    sql: `
      SELECT
        c.TABLE_SCHEMA AS schema_name,
        c.TABLE_NAME AS object_name,
        CASE WHEN t.TABLE_TYPE = 'VIEW' THEN 'VIEW' ELSE 'USER_TABLE' END AS object_type,
        c.COLUMN_NAME AS column_name,
        c.DATA_TYPE AS data_type,
        c.CHARACTER_MAXIMUM_LENGTH AS max_length,
        c.IS_NULLABLE AS is_nullable,
        c.COLUMN_DEFAULT AS default_definition,
        c.COLUMN_KEY = 'PRI' AS is_primary_key,
        k.referenced_schema_name IS NOT NULL AS is_foreign_key,
        k.referenced_schema_name,
        k.referenced_object_name,
        k.referenced_column_name
      FROM information_schema.COLUMNS c
      JOIN information_schema.TABLES t
        ON t.TABLE_SCHEMA = c.TABLE_SCHEMA
       AND t.TABLE_NAME = c.TABLE_NAME
       AND t.TABLE_TYPE IN ('BASE TABLE', 'VIEW')
      LEFT JOIN (
        SELECT
          TABLE_SCHEMA,
          TABLE_NAME,
          COLUMN_NAME,
          REFERENCED_TABLE_SCHEMA AS referenced_schema_name,
          REFERENCED_TABLE_NAME AS referenced_object_name,
          REFERENCED_COLUMN_NAME AS referenced_column_name,
          ROW_NUMBER() OVER (
            PARTITION BY TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
            ORDER BY CONSTRAINT_NAME
          ) AS rn
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE REFERENCED_TABLE_NAME IS NOT NULL
      ) k
        ON k.TABLE_SCHEMA = c.TABLE_SCHEMA
       AND k.TABLE_NAME = c.TABLE_NAME
       AND k.COLUMN_NAME = c.COLUMN_NAME
       AND k.rn = 1
      WHERE c.TABLE_SCHEMA = ?
        ${tableClause}
        ${patternClause}
        ${tableFilterClause}
      ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION;
    `,
    values,
  };
}

function previewPlan(scope, limit) {
  const safeSchema = quoteIdentifier(scope.schema, 'schema');
  const safeTable = quoteIdentifier(scope.table, 'table');
  const rowLimit = Number.isInteger(limit) && limit > 0 ? limit : 100;
  return { sql: `SELECT * FROM ${safeSchema}.${safeTable} LIMIT ${rowLimit};`, values: [] };
}

// MySQL answers IS_NULLABLE as 'YES'/'NO' and the key flags as 1/0. The tools coerce with Boolean(),
// and Boolean('NO') is true, so the strings must become booleans here.
function mapCatalogRows(rows) {
  return rows.map((row) => ({
    schema_name: row.schema_name,
    object_name: row.object_name,
    object_type: row.object_type,
    column_name: row.column_name,
    data_type: row.data_type,
    max_length: row.max_length,
    is_nullable: row.is_nullable === 'YES' || row.is_nullable === 1 || row.is_nullable === true,
    default_definition: row.default_definition,
    is_primary_key: Boolean(row.is_primary_key),
    is_foreign_key: Boolean(row.is_foreign_key),
    referenced_schema_name: row.referenced_schema_name,
    referenced_object_name: row.referenced_object_name,
    referenced_column_name: row.referenced_column_name,
  }));
}

// A MySQL schema is a database: there is no second namespace level, so both arguments name the same
// thing. The catalog lives in the schema, so a schema that does not exist has no objects to list,
// and the caller hears that rather than a connection failure.
function resolveScope(connection, { database, schema } = {}) {
  const name = database || schema || connection.database;
  return { database: name, schema: name };
}

function defaultSchema(connection) {
  return connection.database;
}
export function createMysqlDialect({ driver = mysql } = {}) {
  return {
    name: 'mysql',
    config: MYSQL_CONFIG,
    serverDatabase: null,
    quoteIdentifier,
    assertReadOnly: assertReadOnlyQuery,
    buildPoolConfig,
    createPool: (poolConfig) => driver.createPool(poolConfig),
    // mysql2 replaces a dropped connection on the next query, so a pool never needs discarding.
    poolUsable: () => true,
    // The first statement proves the credentials, which is what the SQL Server pool gets from
    // connect() before any tool runs.
    ready: (pool) => pool.query('SELECT 1'),
    closePool: (pool) => pool.end(),
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
