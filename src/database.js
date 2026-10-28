import { AppError } from './errors.js';
import { DIALECTS } from './dialects/index.js';
import { assertReadOnlyQuery, columnDescriptors } from './dialects/mssql.js';

export { assertReadOnlyQuery };

// The cap must measure what the tool actually ships, not an inner slice. `toolResult` serialises the
// whole result with JSON.stringify(value, null, 2), so the pretty-printed envelope is what counts.
function resultBytes(value) {
  return Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8');
}

/**
 * Caps a result to `rowLimit` rows and `maxBytes` of serialized output.
 *
 * Trailing rows are dropped because a multi-megabyte recordset over stdio stalls the client. The
 * serialized size only grows as rows are added, so the largest fitting prefix is found by binary
 * search rather than by reserialising once per dropped row.
 */
function clampResult({ columns, rows, totalRows, rowLimit, maxBytes }) {
  const kept = rows.slice(0, rowLimit).map((row) =>
    Array.isArray(row) ? row.slice(0, columns.length) : columns.map(({ name }) => row[name]),
  );
  const capped = Number.isFinite(maxBytes) && maxBytes > 0;
  if (capped) {
    const envelope = (count) => ({
      columns,
      row_count: count,
      rows: kept.slice(0, count),
      truncated: totalRows > count || count < kept.length,
    });
    let low = 0;
    let high = kept.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (resultBytes(envelope(middle)) <= maxBytes) low = middle;
      else high = middle - 1;
    }
    kept.length = low;
  }
  return {
    columns,
    row_count: kept.length,
    rows: kept,
    truncated: totalRows > kept.length,
  };
}

export function normalizeResult(result, rowLimit, totalRows = result.recordset.length, options = {}) {
  return clampResult({
    columns: columnDescriptors(result.columns),
    rows: result.recordset,
    totalRows,
    rowLimit,
    maxBytes: options.maxBytes,
  });
}

export class DatabaseManager {
  constructor(config, { dialects = DIALECTS } = {}) {
    this.connections = new Map(config.connections.map((connection) => [connection.name, connection]));
    this.dialects = dialects;
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

  getConnection(name) {
    const connection = this.connections.get(name);
    if (!connection) {
      throw new AppError(`Unknown database connection "${name}".`, { code: 'CONNECTION_NOT_FOUND' });
    }
    return connection;
  }

  defaultDatabase(name) {
    return this.getConnection(name).database;
  }

  defaultSchema(name) {
    const connection = this.getConnection(name);
    return this.#dialectFor(connection).defaultSchema(connection);
  }

  #dialectFor(connection) {
    const dialect = this.dialects[connection.db_type];
    if (!dialect) {
      throw new AppError(
        `Connection "${connection.name}" has unsupported db_type "${connection.db_type}".`,
        { code: 'CONFIG_INVALID' },
      );
    }
    return dialect;
  }

  async #poolFor(connection, database) {
    const dialect = this.#dialectFor(connection);
    const key = `${connection.name}:${database || connection.database}`;
    const existing = this.pools.get(key);
    if (existing && dialect.poolUsable(existing.pool)) return existing.pool;

    const pool = dialect.createPool(dialect.buildPoolConfig(connection, database));
    try {
      await dialect.ready(pool);
    } catch (error) {
      throw new AppError(
        `Could not connect to database connection "${connection.name}"${database ? ` using database "${database}"` : ''}: ${error.message}`,
        { code: 'DATABASE_CONNECTION_FAILED', cause: error },
      );
    }
    this.pools.set(key, { pool, dialect });
    return pool;
  }

  async listConnectionDetails() {
    const details = [];
    for (const connection of this.connections.values()) {
      const { databases } = await this.listDatabases(connection.name);
      details.push({
        name: connection.name,
        db_type: connection.db_type,
        database: connection.database,
        available_databases: databases,
      });
    }
    return details;
  }

  async listDatabases(name) {
    const connection = this.getConnection(name);
    const dialect = this.#dialectFor(connection);
    const pool = await this.#poolFor(connection, dialect.serverDatabase);
    return { current: this.defaultDatabase(name), databases: await dialect.listDatabases(pool) };
  }

  async listObjects({ connection: connectionName, database, schema }) {
    const connection = this.getConnection(connectionName);
    const dialect = this.#dialectFor(connection);
    const scope = dialect.resolveScope(connection, { database, schema });
    const pool = await this.#poolFor(connection, scope.database);
    const rows = await dialect.runPlan(pool, dialect.objectsPlan(scope));
    return {
      schema: scope.schema,
      objects: rows.map((row) => ({
        schema_name: row.schema_name,
        object_name: row.object_name,
        object_type: row.object_type,
      })),
    };
  }

  async describeCatalog({ connection: connectionName, database, schema, table, pattern, tables }) {
    const connection = this.getConnection(connectionName);
    const dialect = this.#dialectFor(connection);
    const scope = dialect.resolveScope(connection, { database, schema });
    const pool = await this.#poolFor(connection, scope.database);
    const rows = await dialect.runPlan(pool, dialect.catalogPlan(scope, { table, pattern, tables }));
    return { schema: scope.schema, rows: dialect.mapCatalogRows(rows) };
  }

  async previewTable({ connection: connectionName, database, schema, table, limit }) {
    const connection = this.getConnection(connectionName);
    const dialect = this.#dialectFor(connection);
    const scope = dialect.resolveScope(connection, { database, schema });
    const plan = dialect.previewPlan({ ...scope, table }, limit);
    return {
      schema: scope.schema,
      result: await this.query(connectionName, plan.sql, { database: scope.database, rowLimit: limit }),
    };
  }

  async query(connectionName, sqlText, { database, rowLimit } = {}) {
    if (typeof sqlText !== 'string' || sqlText.trim() === '') {
      throw new AppError('SQL query must be a non-empty string.', { code: 'INVALID_QUERY' });
    }
    const connection = this.getConnection(connectionName);
    const dialect = this.#dialectFor(connection);
    if (connection.read_only) dialect.assertReadOnly(sqlText);
    const limit = Number.isInteger(rowLimit) && rowLimit > 0
      ? Math.min(rowLimit, connection.max_row_limit)
      : connection.max_row_limit;
    const pool = await this.#poolFor(connection, database);
    let result;
    try {
      result = await dialect.runQuery(pool, sqlText, { timeout: connection.query_timeout_ms });
    } catch (error) {
      throw new AppError(`SQL query failed: ${error.message}`, { code: 'QUERY_FAILED', cause: error });
    }
    return clampResult({
      columns: result.columns,
      rows: result.rows,
      totalRows: result.totalRows,
      rowLimit: limit,
      maxBytes: connection.max_result_bytes,
    });
  }

  async close() {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.allSettled(pools.map(({ pool, dialect }) => dialect.closePool(pool)));
  }
}
