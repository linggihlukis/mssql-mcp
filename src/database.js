import sql from 'mssql';
import { AppError } from './errors.js';

const IDENTIFIER_PART = /^[A-Za-z_][A-Za-z0-9_$#@]*$/;

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

const READ_ONLY_STATEMENT_START = new Set(['SELECT', 'VALUES', 'TABLE', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC']);
const READ_ONLY_WITH_BANNED = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'EXEC', 'EXECUTE']);
const READ_ONLY_DEPTH_ZERO_BANNED = new Set(['INTO', 'OPENROWSET', 'OPENDATASOURCE', 'USE']);

function stripSqlComments(text) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (quote) {
      out += char;
      if (char === quote) {
        if ((quote === "'" || quote === '"') && next === quote) {
          out += next;
          i += 2;
          continue;
        }
        quote = null;
      }
      i += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      i += 1;
      continue;
    }
    if (char === '-' && next === '-') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

function splitSqlStatements(text) {
  const statements = [];
  let current = '';
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      current += char;
      if (char === quote) {
        if ((quote === "'" || quote === '"') && text[i + 1] === quote) {
          current += text[i + 1];
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ';' && depth === 0) {
      statements.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

function sqlWords(statement) {
  const words = [];
  let current = '';
  let quote = null;
  let depth = 0;
  const flush = () => {
    if (current) {
      words.push({ word: current.toUpperCase(), depthZero: true });
      current = '';
    }
  };
  for (let i = 0; i < statement.length; i += 1) {
    const char = statement[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '[') {
      const end = statement.indexOf(']', i);
      i = end === -1 ? statement.length : end;
      continue;
    }
    if (char === '(') {
      flush();
      depth += 1;
      continue;
    }
    if (char === ')') {
      flush();
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && /[A-Za-z0-9_$#@]/.test(char) && (current || /[A-Za-z_]/.test(char))) {
      current += char;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      flush();
      let nested = '';
      let j = i;
      while (j < statement.length && /[A-Za-z0-9_$#@]/.test(statement[j])) {
        nested += statement[j];
        j += 1;
      }
      words.push({ word: nested.toUpperCase(), depthZero: false });
      i = j - 1;
      continue;
    }
    flush();
  }
  flush();
  return words;
}

export function assertReadOnlyQuery(sqlText) {
  const statements = splitSqlStatements(stripSqlComments(sqlText));
  if (statements.length === 0) {
    throw new AppError('SQL query must be a non-empty statement.', { code: 'INVALID_QUERY' });
  }
  if (statements.length > 1) {
    throw new AppError('Read-only connections accept a single read statement per call.', {
      code: 'READ_ONLY_VIOLATION',
    });
  }
  const words = sqlWords(statements[0]);
  const first = words.find((entry) => entry.depthZero)?.word;
  if (!first) {
    throw new AppError('SQL query must be a non-empty statement.', { code: 'INVALID_QUERY' });
  }
  if (first === 'WITH') {
    const banned = words.find((entry) => READ_ONLY_WITH_BANNED.has(entry.word) || READ_ONLY_DEPTH_ZERO_BANNED.has(entry.word));
    if (banned) {
      throw new AppError(`Read-only connections reject statements containing "${banned.word}".`, {
        code: 'READ_ONLY_VIOLATION',
      });
    }
    return;
  }
  if (!READ_ONLY_STATEMENT_START.has(first)) {
    throw new AppError(`Read-only connections reject "${first}" statements.`, {
      code: 'READ_ONLY_VIOLATION',
    });
  }
  const banned = words.find((entry) => READ_ONLY_DEPTH_ZERO_BANNED.has(entry.word));
  if (banned) {
    throw new AppError(`Read-only connections reject statements containing "${banned.word}".`, {
      code: 'READ_ONLY_VIOLATION',
    });
  }
}

function normalizeConnectionForMssql(connection, database) {
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

export function normalizeResult(result, rowLimit, totalRows = result.recordset.length) {
  const columns = Array.isArray(result.columns)
    ? result.columns.map((metadata, index) => ({
      name: metadata.name ?? `column_${index + 1}`,
      data_type: columnType(metadata),
      default_value: null,
      is_nullable: metadata.nullable ?? null,
      is_primary_key: false,
      is_foreign_key: false,
    }))
    : Object.entries(result.columns ?? {}).map(([name, metadata]) => ({
      name,
      data_type: columnType(metadata),
      default_value: null,
      is_nullable: null,
      is_primary_key: false,
      is_foreign_key: false,
    }));
  const rows = result.recordset.slice(0, rowLimit).map((row) =>
    Array.isArray(row) ? row.slice(0, columns.length) : columns.map(({ name }) => row[name]),
  );
  return {
    columns,
    row_count: rows.length,
    rows,
    truncated: totalRows > rows.length,
  };
}

export class DatabaseManager {
  constructor(config, { driver = sql } = {}) {
    this.connections = new Map(config.connections.map((connection) => [connection.name, connection]));
    this.driver = driver;
    this.pools = new Map();
  }

  listConnections() {
    return [...this.connections.values()].map((connection) => ({
      name: connection.name,
      db_type: connection.db_type,
      database: connection.database,
      read_only: connection.read_only,
    }));
  }

  async listConnectionDetails() {
    const details = [];
    for (const connection of this.connections.values()) {
      const pool = await this.getPool(connection.name, 'master');
      const result = await pool.request().query(`
        SELECT name
        FROM sys.databases
        ORDER BY name;
      `);
      details.push({
        name: connection.name,
        db_type: connection.db_type,
        database: connection.database,
        available_databases: result.recordset.map((row) => row.name),
      });
    }
    return details;
  }

  getConnection(name) {
    const connection = this.connections.get(name);
    if (!connection) {
      throw new AppError(`Unknown database connection "${name}".`, { code: 'CONNECTION_NOT_FOUND' });
    }
    return connection;
  }

  async getPool(connectionName, database) {
    const connection = this.getConnection(connectionName);
    const key = `${connectionName}:${database || connection.database}`;
    let pool = this.pools.get(key);
    if (pool?.connected) return pool;

    const poolConfig = normalizeConnectionForMssql(connection, database);
    pool = new this.driver.ConnectionPool(poolConfig);
    try {
      await pool.connect();
    } catch (error) {
      throw new AppError(
        `Could not connect to database connection "${connectionName}"${database ? ` using database "${database}"` : ''}: ${error.message}`,
        { code: 'DATABASE_CONNECTION_FAILED', cause: error },
      );
    }
    this.pools.set(key, pool);
    return pool;
  }

  async query(connectionName, sqlText, { database, rowLimit } = {}) {
    if (typeof sqlText !== 'string' || sqlText.trim() === '') {
      throw new AppError('SQL query must be a non-empty string.', { code: 'INVALID_QUERY' });
    }
    const connection = this.getConnection(connectionName);
    if (connection.read_only) assertReadOnlyQuery(sqlText);
    const limit = Number.isInteger(rowLimit) && rowLimit > 0
      ? Math.min(rowLimit, connection.max_row_limit)
      : connection.max_row_limit;
    const pool = await this.getPool(connectionName, database);
    const request = pool.request();
    request.arrayRowMode = true;
    let result;
    try {
      result = await request.query(sqlText);
    } catch (error) {
      throw new AppError(`SQL query failed: ${error.message}`, { code: 'QUERY_FAILED', cause: error });
    }
    const recordset = result.recordset ?? [];
    return normalizeResult({ ...result, recordset }, limit, recordset.length);
  }

  async close() {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.allSettled(pools.map((pool) => pool.close()));
  }
}
