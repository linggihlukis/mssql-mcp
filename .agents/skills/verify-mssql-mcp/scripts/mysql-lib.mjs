// Shared helpers for the MySQL half of the verify-mssql-mcp skill.
//
// The MCP session machinery, reporting and evidence handling are dialect-neutral and are imported
// from lib.mjs. What is MySQL-specific lives here: the read target, the probes that must be refused,
// a direct connection that accepts Laragon's empty password, and the fingerprint queries.
//
// Safety rules this file enforces, not merely documents:
//   * Every write probe is a statement the read-only guard must refuse before the driver is reached.
//     None of them is expected to run, so a privileged login cannot be used to mutate anything.
//   * No BEGIN/COMMIT, no DDL, no DELETE/TRUNCATE/DROP, no CREATE, anywhere.
//   * The only login used is the one configured for the connection. It is never altered.
//   * Evidence is written outside the repository and the password is redacted in every artifact.

import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { CONFIG_PATH, readRawConfig } from './lib.mjs';

export { CONFIG_PATH };

export {
  RawSession,
  createReport,
  createRunDir,
  evidenceRoots,
  makeRedactor,
  parseArgs,
  printChecks,
  resolveRunDir,
  sdkSession,
  sleep,
  writeJson,
} from './lib.mjs';

export const MYSQL_CONNECTION_NAME = process.env.MSSQL_MCP_VERIFY_MYSQL_CONNECTION || 'mysql';
export const MYSQL_EXPECTED_LOGIN = process.env.MSSQL_MCP_VERIFY_MYSQL_LOGIN || null;
export const MYSQL_READ_SCHEMA = 'eosys';
export const MYSQL_READ_TABLE = 'departments';
export const MYSQL_READ_SQL = `SELECT id, dept_id, name, sup_dept_id FROM ${MYSQL_READ_TABLE} ORDER BY id`;
export const MYSQL_READ_ROW_LIMIT = 50;
export const MYSQL_DIRECT_TIMEOUT_MS = 15_000;

// Each of these is a write, or a read that writes (a file, a row lock), that MySQL would accept if
// the guard let it through. The driver must never see any of them.
export const MYSQL_WRITE_PROBES = [
  { id: 'insert', sql: `INSERT INTO ${MYSQL_READ_TABLE} (dept_id, name) VALUES (0, 'verify-probe')` },
  { id: 'update', sql: `UPDATE ${MYSQL_READ_TABLE} SET name = name WHERE 1 = 0` },
  { id: 'delete', sql: `DELETE FROM ${MYSQL_READ_TABLE} WHERE 1 = 0` },
  { id: 'drop', sql: `DROP TABLE ${MYSQL_READ_TABLE}` },
  { id: 'truncate', sql: `TRUNCATE TABLE ${MYSQL_READ_TABLE}` },
  { id: 'outfile', sql: `SELECT * FROM ${MYSQL_READ_TABLE} INTO OUTFILE '/tmp/verify-probe.txt'` },
  { id: 'dumpfile', sql: `SELECT * FROM ${MYSQL_READ_TABLE} INTO DUMPFILE '/tmp/verify-probe.txt'` },
  { id: 'into-variable', sql: 'SELECT 1 INTO @verify_probe' },
  { id: 'for-update', sql: `SELECT * FROM ${MYSQL_READ_TABLE} FOR UPDATE` },
  { id: 'lock-in-share-mode', sql: `SELECT * FROM ${MYSQL_READ_TABLE} LOCK IN SHARE MODE` },
  { id: 'cte-update', sql: `WITH c AS (SELECT 1 AS one) UPDATE ${MYSQL_READ_TABLE} SET name = name` },
  { id: 'cte-delete', sql: `WITH c AS (SELECT 1 AS one) DELETE FROM ${MYSQL_READ_TABLE}` },
  { id: 'explain-analyze-update', sql: `EXPLAIN ANALYZE UPDATE ${MYSQL_READ_TABLE} SET name = name` },
  {
    id: 'executable-comment-outfile',
    sql: `SELECT /*!50000 INTO OUTFILE '/tmp/verify-probe.txt' */ 1`,
  },
  { id: 'multi-statement', sql: `SELECT 1; DELETE FROM ${MYSQL_READ_TABLE} WHERE 1 = 0` },
];

// CRC32 per row, XOR-folded, so the fingerprint does not depend on row order and does not grow with
// the table. A single changed byte changes it.
export const MYSQL_FINGERPRINT_SQL = `SELECT COUNT(*) AS row_count,
  BIT_XOR(CRC32(CONCAT_WS('#', id, dept_id, name, sup_dept_id))) AS row_fingerprint
FROM ${MYSQL_READ_TABLE}`;

export const MYSQL_OBJECT_COUNT_SQL = `SELECT COUNT(*) AS object_count
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = '${MYSQL_READ_SCHEMA}' AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')`;

export const MYSQL_COLUMNS_SQL = `SELECT COLUMN_NAME AS column_name,
  DATA_TYPE AS data_type,
  IS_NULLABLE AS is_nullable,
  COLUMN_KEY AS column_key
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = '${MYSQL_READ_SCHEMA}' AND TABLE_NAME = '${MYSQL_READ_TABLE}'
ORDER BY ORDINAL_POSITION`;

export function readDotEnvFile(filePath) {
  const values = {};
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return values;
  }
  for (const rawLine of content.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/**
 * Resolve the configured MySQL connection the way src/config.js does.
 *
 * Unlike the SQL Server resolver this accepts an empty password, because Laragon ships accounts
 * without one. The password is returned in memory only.
 */
export function resolveMysqlConnection(name = MYSQL_CONNECTION_NAME) {
  const connection = (readRawConfig().connections || []).find((entry) => entry.name === name);
  if (!connection) {
    throw new Error(`Connection "${name}" is not present in ${CONFIG_PATH}.`);
  }
  if (connection.db_type !== 'mysql') {
    throw new Error(`Connection "${name}" has db_type "${connection.db_type}", not "mysql".`);
  }
  const dotenv = readDotEnvFile(path.join(path.dirname(CONFIG_PATH), '.env'));
  const username = connection.username_env
    ? process.env[connection.username_env] ?? dotenv[connection.username_env]
    : connection.username;
  const password = connection.password_env
    ? process.env[connection.password_env] ?? dotenv[connection.password_env]
    : connection.password;
  if (typeof username !== 'string' || username === '') {
    throw new Error(
      `Connection "${name}" has no usable username. Check ${connection.username_env}.`,
    );
  }
  if (typeof password !== 'string') {
    throw new Error(
      `Connection "${name}" has no usable password. Check ${connection.password_env}.`,
    );
  }
  return {
    name,
    host: connection.host,
    port: connection.port ?? 3306,
    database: connection.database,
    username,
    password,
    read_only: connection.read_only !== false,
    max_row_limit: connection.max_row_limit,
    query_timeout_ms: connection.query_timeout_ms,
    options: connection.options || {},
    raw: connection,
  };
}

export async function withMysqlDirect(fn) {
  const connection = resolveMysqlConnection();
  if (MYSQL_EXPECTED_LOGIN && connection.username !== MYSQL_EXPECTED_LOGIN) {
    throw new Error(
      `Refusing to connect as "${connection.username}". This skill only ever uses the login in MSSQL_MCP_VERIFY_MYSQL_LOGIN.`,
    );
  }
  const pool = mysql.createPool({
    host: connection.host,
    port: connection.port,
    user: connection.username,
    password: connection.password,
    database: connection.database,
    connectTimeout: 10_000,
    supportBigNumbers: true,
    multipleStatements: false,
    ...connection.options,
  });
  try {
    return await fn({ pool, connection });
  } finally {
    await pool.end().catch(() => {});
  }
}

/** Run one bounded statement and return ordered columns plus row arrays. */
export async function mysqlDirectQuery(pool, text) {
  const [rows, fields] = await pool.query({ sql: text, rowsAsArray: true, timeout: MYSQL_DIRECT_TIMEOUT_MS });
  return {
    columns: (fields ?? []).map((field) => ({ name: field.name })),
    rows: Array.isArray(rows) ? rows : [],
    row_count: Array.isArray(rows) ? rows.length : 0,
  };
}

export async function mysqlFingerprint(pool) {
  const [rows] = await pool.query({ sql: MYSQL_FINGERPRINT_SQL, rowsAsArray: true });
  const [[rowCount, rowFingerprint]] = rows;
  return { row_count: rowCount, row_fingerprint: String(rowFingerprint) };
}

export function parseToolJson(result) {
  const text = result?.content?.find((entry) => entry.type === 'text')?.text;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function toolText(result) {
  return result?.content?.find((entry) => entry.type === 'text')?.text ?? null;
}

/**
 * A list tool returns a bare array when nothing was cut, and an object holding the list under a
 * named key plus `total_count` / `truncated` when the byte cap dropped entries.
 */
export function listPayload(value, key) {
  if (Array.isArray(value)) return { items: value, total: value.length, truncated: false };
  const items = Array.isArray(value?.[key]) ? value[key] : [];
  return {
    items,
    total: typeof value?.total_count === 'number' ? value.total_count : items.length,
    truncated: value?.truncated === true,
  };
}
