import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), 'config.json');
const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data');
const DEFAULT_MAX_ROW_LIMIT = 500;
const DEFAULT_DOTENV_FILE = '.env';
const DEFAULT_QUERY_TIMEOUT_MS = 60_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

function parseDotEnv(content) {
  const values = {};
  for (const rawLine of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const assignment = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = assignment.indexOf('=');
    if (separator <= 0) continue;
    const key = assignment.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = assignment.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[key] = value;
  }
  return values;
}

function readDotEnvFile(filePath) {
  try {
    return parseDotEnv(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new AppError(`Could not read dotenv file "${filePath}".`, {
      code: 'DOTENV_READ_FAILED',
      cause: error,
    });
  }
}

function readJsonFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new AppError(`Could not read configuration file "${filePath}".`, {
      code: 'CONFIG_READ_FAILED',
      cause: error,
    });
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new AppError(`Configuration file "${filePath}" is not valid JSON.`, {
      code: 'CONFIG_PARSE_FAILED',
      cause: error,
    });
  }
}

function requiredString(value, field, connectionName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(`Connection "${connectionName}" requires a non-empty ${field}.`, {
      code: 'CONFIG_INVALID',
    });
  }
  return value.trim();
}

function positiveInteger(value, fallback, field, connectionName) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0) {
    throw new AppError(`Connection "${connectionName}" has an invalid ${field}.`, {
      code: 'CONFIG_INVALID',
    });
  }
  return result;
}

function normalizeConnection(rawConnection, index, env) {
  if (!rawConnection || typeof rawConnection !== 'object') {
    throw new AppError(`Connection at index ${index} must be an object.`, {
      code: 'CONFIG_INVALID',
    });
  }

  const name = requiredString(rawConnection.name, 'name', `index ${index}`);
  const dbType = String(rawConnection.db_type ?? 'mssql').toLowerCase();
  if (dbType !== 'mssql') {
    throw new AppError(`Connection "${name}" has unsupported db_type "${dbType}".`, {
      code: 'CONFIG_INVALID',
    });
  }

  const username = rawConnection.username_env
    ? env[requiredString(rawConnection.username_env, 'username_env', name)]
    : rawConnection.username;
  const password = rawConnection.password_env
    ? env[requiredString(rawConnection.password_env, 'password_env', name)]
    : rawConnection.password;

  if (typeof username !== 'string' || username.trim() === '') {
    throw new AppError(
      `Connection "${name}" needs a username through username_env or a non-empty username value.`,
      { code: 'CONFIG_SECRET_MISSING' },
    );
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new AppError(
      `Connection "${name}" needs a password through password_env or a non-empty password value.`,
      { code: 'CONFIG_SECRET_MISSING' },
    );
  }

  const host = requiredString(rawConnection.host, 'host', name);
  const port = positiveInteger(rawConnection.port, 1433, 'port', name);
  const database = requiredString(rawConnection.database, 'database', name);
  const normalizedUsername = requiredString(username, 'username', name);
  const maxRowLimit = positiveInteger(
    rawConnection.max_row_limit,
    DEFAULT_MAX_ROW_LIMIT,
    'max_row_limit',
    name,
  );
  const queryTimeoutMs = positiveInteger(
    rawConnection.query_timeout_ms,
    DEFAULT_QUERY_TIMEOUT_MS,
    'query_timeout_ms',
    name,
  );
  const connectionTimeoutMs = positiveInteger(
    rawConnection.connection_timeout_ms,
    DEFAULT_CONNECTION_TIMEOUT_MS,
    'connection_timeout_ms',
    name,
  );

  return {
    name,
    db_type: dbType,
    host,
    port,
    database,
    username: normalizedUsername,
    password,
    read_only: Boolean(rawConnection.read_only),
    max_row_limit: maxRowLimit,
    query_timeout_ms: queryTimeoutMs,
    connection_timeout_ms: connectionTimeoutMs,
    options: {
      encrypt: rawConnection.options?.encrypt ?? false,
      trustServerCertificate: rawConnection.options?.trustServerCertificate ?? true,
      enableArithAbort: rawConnection.options?.enableArithAbort ?? true,
    },
  };
}

export function loadConfig({ env = process.env } = {}) {
  const configPath = path.resolve(env.MSSQL_MCP_CONFIG || DEFAULT_CONFIG_PATH);
  const dotenvPath = path.resolve(
    env.MSSQL_MCP_DOTENV || path.join(path.dirname(configPath), DEFAULT_DOTENV_FILE),
  );
  const mergedEnv = { ...readDotEnvFile(dotenvPath), ...env };
  const rawConfig = readJsonFile(configPath);
  if (!Array.isArray(rawConfig.connections) || rawConfig.connections.length === 0) {
    throw new AppError('Configuration must contain a non-empty connections array.', {
      code: 'CONFIG_INVALID',
    });
  }

  const connections = rawConfig.connections.map((connection, index) =>
    normalizeConnection(connection, index, mergedEnv),
  );
  const names = new Set();
  for (const connection of connections) {
    if (names.has(connection.name)) {
      throw new AppError(`Duplicate connection name "${connection.name}".`, {
        code: 'CONFIG_INVALID',
      });
    }
    names.add(connection.name);
  }

  return {
    configPath,
    dotenvPath,
    dataDir: path.resolve(mergedEnv.MSSQL_MCP_DATA_DIR || DEFAULT_DATA_DIR),
    connections,
  };
}

export const configDefaults = Object.freeze({
  maxRowLimit: DEFAULT_MAX_ROW_LIMIT,
  queryTimeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
  connectionTimeoutMs: DEFAULT_CONNECTION_TIMEOUT_MS,
});
