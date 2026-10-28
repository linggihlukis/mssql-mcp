// Shared helpers for the verify-mssql-mcp skill.
//
// Safety contract, enforced here rather than in prose:
//   * The only SQL login used is the one named by MSSQL_MCP_VERIFY_LOGIN. resolveConnection()
//     refuses any other login.
//   * Every statement issued by these helpers is bounded (TOP), names its columns, and carries a
//     request timeout. Nothing here issues DDL or a destructive statement.
//   * Secrets come from the environment or the dotenv file the app already reads. They are never
//     passed on a command line and never written to evidence unredacted.
//   * Evidence lives outside the repository because JSON-RPC frames carry production rows.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';

const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO = path.resolve(here, '..', '..', '..', '..');
export const ENTRY = path.join(REPO, 'src', 'index.js');
export const CONFIG_PATH = path.resolve(process.env.MSSQL_MCP_CONFIG || path.join(REPO, 'config.json'));

// Expected identity comes from the environment or the dotenv file next to config.json, so the
// read-only login and host are never committed. Both are required: with either unset, the helpers
// refuse to connect and doctor.mjs fails closed.
const dotenv = readDotEnv(path.join(path.dirname(CONFIG_PATH), '.env'));
export const EXPECTED_LOGIN = process.env.MSSQL_MCP_VERIFY_LOGIN ?? dotenv.MSSQL_MCP_VERIFY_LOGIN;
export const EXPECTED_SERVER = process.env.MSSQL_MCP_VERIFY_SERVER ?? dotenv.MSSQL_MCP_VERIFY_SERVER;
export const EXPECTED_DATABASE = 'Uranus';
// The connection this skill drives. config.json may hold other connections (for example a
// development connection that logs in with a higher-privilege account); they are never driven, and
// the doctor fails closed on any login other than EXPECTED_LOGIN.
export const CONNECTION_NAME = process.env.MSSQL_MCP_VERIFY_CONNECTION || 'prod';

// The read journey. Bounded, explicit columns, no SELECT *, one statement, one database.
export const READ_SCHEMA = 'dbo';
export const READ_TABLE = '_DIM_BranchGroup';
export const READ_SQL =
  'SELECT TOP (5) Id, Name, IsEnable FROM dbo._DIM_BranchGroup ORDER BY Id';
export const READ_ROW_LIMIT = 50;
export const DIRECT_REQUEST_TIMEOUT_MS = 15_000;

// Negative write probes. Both are structurally writes, both affect zero rows by construction, and
// the login lacks the permission for both. If the MCP guard were broken, the server would still
// answer 229 instead of mutating a row.
export const WRITE_PROBES = [
  {
    id: 'insert',
    word: 'INSERT',
    sql: "INSERT INTO dbo._DIM_BranchGroup (Name, IsEnable) SELECT TOP (0) 'verify-probe', 1",
  },
  {
    id: 'update',
    word: 'UPDATE',
    sql: 'UPDATE dbo._DIM_BranchGroup SET Name = Name WHERE 1 = 0',
  },
];

// ---------------------------------------------------------------------------------------------
// Evidence directories
// ---------------------------------------------------------------------------------------------

/**
 * Evidence never lives in the repository: JSON-RPC frames carry production rows.
 *
 * There is no single "the" evidence root. A sandboxed agent run may only reach %TEMP%, whose value
 * differs per sandbox, while an escalated run also reaches %LOCALAPPDATA%. So creation picks the
 * first candidate that accepts a real write, and discovery searches every candidate. A run that
 * starts in one mode and continues in another still finds its own proof.
 * Override with MSSQL_MCP_VERIFY_EVIDENCE to pin a single directory.
 */
export function evidenceRoots() {
  if (process.env.MSSQL_MCP_VERIFY_EVIDENCE) {
    return [path.resolve(process.env.MSSQL_MCP_VERIFY_EVIDENCE)];
  }
  return [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'mssql-mcp-verify') : null,
    path.join(os.tmpdir(), 'mssql-mcp-verify'),
  ].filter(Boolean);
}

/**
 * The root new runs are written to: the first candidate that accepts a real write right now.
 *
 * fs.accessSync(W_OK) is not a usable test here — under the Windows sandbox it reports success
 * while the actual write is denied, so the probe writes and removes a file instead.
 */
export function evidenceRoot() {
  const errors = [];
  for (const candidate of evidenceRoots()) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      const probe = path.join(candidate, `.write-probe-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      return candidate;
    } catch (error) {
      errors.push(`${candidate}: ${error.code || error.message}`);
    }
  }
  throw new Error(
    `No writable evidence root outside the repository. Tried ${errors.join('; ')}. ` +
      'Set MSSQL_MCP_VERIFY_EVIDENCE to a writable directory outside the repository.',
  );
}

export function listRunDirs() {
  const dirs = [];
  for (const root of evidenceRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('run-')) {
        dirs.push(path.join(root, entry.name));
      }
    }
  }
  return dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

export function latestRunDir() {
  return listRunDirs()[0] || null;
}

export function createRunDir() {
  const root = evidenceRoot();
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  const dir = path.join(root, `run-${stamp}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveRunDir(explicit) {
  if (explicit) {
    const dir = path.resolve(explicit);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const latest = latestRunDir();
  if (!latest) {
    throw new Error(
      `No run directory under ${evidenceRoots().join(' or ')}. Run doctor.mjs first, or pass --run <dir>.`,
    );
  }
  return latest;
}

// ---------------------------------------------------------------------------------------------
// Config and secrets
// ---------------------------------------------------------------------------------------------

function readDotEnv(filePath) {
  const values = {};
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return values;
    throw error;
  }
  for (const rawLine of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const assignment = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = assignment.indexOf('=');
    if (separator <= 0) continue;
    const key = assignment.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = assignment.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[key] = value;
  }
  return values;
}

export function readRawConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

/**
 * Resolve the configured connection the same way src/config.js does: explicit process environment
 * wins over the dotenv file that sits next to config.json. Returns the secret in memory only.
 */
export function resolveConnection(name = CONNECTION_NAME) {
  const raw = readRawConfig();
  const connection = (raw.connections || []).find((entry) => entry.name === name);
  if (!connection) {
    throw new Error(`Connection "${name}" is not present in ${CONFIG_PATH}.`);
  }
  const dotenv = readDotEnv(path.join(path.dirname(CONFIG_PATH), '.env'));
  const username = connection.username_env
    ? process.env[connection.username_env] ?? dotenv[connection.username_env]
    : connection.username;
  const password = connection.password_env
    ? process.env[connection.password_env] ?? dotenv[connection.password_env]
    : connection.password;
  if (!username || !password) {
    throw new Error(
      `Connection "${name}" has no usable credentials. Check ${connection.username_env} / ${connection.password_env}.`,
    );
  }
  return {
    name,
    host: connection.host,
    port: connection.port ?? 1433,
    database: connection.database,
    username,
    password,
    read_only: Boolean(connection.read_only),
    max_row_limit: connection.max_row_limit,
    query_timeout_ms: connection.query_timeout_ms,
    options: connection.options || {},
    raw: connection,
  };
}

export function makeRedactor(secrets) {
  const list = (secrets || []).filter((value) => typeof value === 'string' && value.length >= 4);
  return (value) => {
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const secret of list) text = text.split(secret).join('***REDACTED***');
    return text
      .replace(/(password|pwd)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;"}]+)/gi, '$1=***REDACTED***')
      .replace(/("password"\s*:\s*)"[^"]*"/gi, '$1"***REDACTED***"');
  };
}

// ---------------------------------------------------------------------------------------------
// Direct (non-MCP) SQL connection — the independent witness
// ---------------------------------------------------------------------------------------------

export async function withDirectConnection(fn) {
  const connection = resolveConnection();
  if (!EXPECTED_LOGIN) {
    throw new Error(
      'MSSQL_MCP_VERIFY_LOGIN is not set. Add it to .env (or the environment) with the read-only login this skill expects.',
    );
  }
  if (connection.username !== EXPECTED_LOGIN) {
    throw new Error(
      `Refusing to connect as "${connection.username}". This skill only ever uses the login in MSSQL_MCP_VERIFY_LOGIN.`,
    );
  }
  const pool = await new sql.ConnectionPool({
    server: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.username,
    password: connection.password,
    connectionTimeout: 10_000,
    requestTimeout: DIRECT_REQUEST_TIMEOUT_MS,
    options: connection.options,
  }).connect();
  try {
    return await fn({ pool, connection });
  } finally {
    await pool.close().catch(() => {});
  }
}

/** Run one bounded statement in object mode and return ordered columns plus row arrays. */
export async function directQuery(pool, text) {
  const result = await pool.request().query(text);
  const columns = Object.values(result.recordset.columns || {})
    .sort((a, b) => a.index - b.index)
    .map((column) => ({
      name: column.name,
      type: column.type?.declaration || column.type?.name || 'unknown',
      nullable: column.nullable ?? null,
    }));
  const rows = result.recordset.map((row) => columns.map((column) => row[column.name]));
  return { columns, rows, row_count: rows.length };
}

export const FINGERPRINT_SQL = `SELECT COUNT_BIG(1) AS row_count,
  CHECKSUM_AGG(BINARY_CHECKSUM(Id, Name, IsEnable)) AS row_fingerprint
FROM dbo._DIM_BranchGroup`;

export const TABLE_COLUMNS_SQL = `SELECT TOP (50) c.column_id, c.name AS column_name, t.name AS type_name,
  c.is_nullable, CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS is_primary_key
FROM sys.columns c
JOIN sys.types t ON t.user_type_id = c.user_type_id
LEFT JOIN (
  SELECT ic.column_id FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
  WHERE i.object_id = OBJECT_ID('dbo._DIM_BranchGroup') AND i.is_primary_key = 1
) pk ON pk.column_id = c.column_id
WHERE c.object_id = OBJECT_ID('dbo._DIM_BranchGroup')
ORDER BY c.column_id`;

// ---------------------------------------------------------------------------------------------
// MCP session A: raw newline-delimited JSON-RPC, records every frame
// ---------------------------------------------------------------------------------------------

export class RawSession {
  constructor({ label, runDir, redact }) {
    this.label = label;
    this.runDir = runDir;
    this.redact = redact;
    this.framesPath = path.join(runDir, `frames-${label}.jsonl`);
    this.stderrPath = path.join(runDir, `stderr-${label}.log`);
    this.stderr = '';
    this.buffer = '';
    this.nextId = 0;
    this.pending = new Map();
    this.exit = null;
    this.shutdown = null;
    this.pid = null;
    this.spawnedAt = null;
    this.forcedKill = false;
  }

  #record(direction, payload) {
    const line = this.redact(
      JSON.stringify({ ts: new Date().toISOString(), session: this.label, direction, payload }),
    );
    fs.appendFileSync(this.framesPath, `${line}\n`);
  }

  #rejectPending(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  #onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#record('stdout-nonjson', line);
        continue;
      }
      this.#record('in', message);
      const entry = message.id !== undefined ? this.pending.get(message.id) : undefined;
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        entry.resolve(message);
      }
    }
  }

  async start() {
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      MSSQL_MCP_CONFIG: CONFIG_PATH,
      MSSQL_MCP_DATA_DIR: path.join(this.runDir, 'mcp-data'),
      MSSQL_MCP_VERIFY_RUN_ID: path.basename(this.runDir),
    };
    this.child = spawn(process.execPath, [ENTRY], {
      cwd: REPO,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
    });
    this.child.stdout.on('data', (chunk) => this.#onData(chunk));
    this.child.on('exit', (code, signal) => {
      this.exit = { code, signal };
      this.#rejectPending(new Error(`MCP process exited (code=${code}, signal=${signal}).`));
    });
    await new Promise((resolve, reject) => {
      this.child.once('spawn', resolve);
      this.child.once('error', reject);
    });
    this.pid = this.child.pid;
    this.spawnedAt = new Date().toISOString();
    this.#record('meta', {
      event: 'spawn',
      pid: this.pid,
      spawnedAt: this.spawnedAt,
      entry: ENTRY,
      config: CONFIG_PATH,
    });
    return this;
  }

  request(method, params, timeoutMs = 60_000) {
    const id = ++this.nextId;
    const message = { jsonrpc: '2.0', id, method, params };
    this.#record('out', message);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${method} (id ${id}).`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  notify(method, params) {
    const message = { jsonrpc: '2.0', method, params };
    this.#record('out', message);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Close stdin and record whether the server exited on its own, and how fast. */
  async close() {
    if (!this.child || this.exit) {
      this.shutdown = { exitedBeforeClose: true, exit: this.exit };
      return this.shutdown;
    }
    const exited = new Promise((resolve) => this.child.once('exit', () => resolve(true)));
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    let closedCleanly = await Promise.race([exited, sleep(2500).then(() => false)]);
    if (!closedCleanly) {
      this.forcedKill = true;
      this.child.kill('SIGTERM');
      closedCleanly = await Promise.race([exited, sleep(2500).then(() => false)]);
    }
    if (!closedCleanly) {
      this.child.kill('SIGKILL');
      await Promise.race([exited, sleep(2500)]);
    }
    this.shutdown = {
      exitAfterStdinEnd: closedCleanly && !this.forcedKill,
      forcedKill: this.forcedKill,
      exit: this.exit,
    };
    fs.writeFileSync(this.stderrPath, this.redact(this.stderr));
    this.#record('meta', { event: 'exit', pid: this.pid, ...this.shutdown });
    return this.shutdown;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------------------
// MCP session B: the official SDK client, a separate process and a different implementation
// ---------------------------------------------------------------------------------------------

export async function sdkSession({ label, runDir, redact, onClose }) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    cwd: REPO,
    stderr: 'pipe',
    env: {
      MSSQL_MCP_CONFIG: CONFIG_PATH,
      MSSQL_MCP_DATA_DIR: path.join(runDir, 'mcp-data'),
      MSSQL_MCP_VERIFY_RUN_ID: path.basename(runDir),
    },
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const spawnedAt = new Date().toISOString();
  const framesPath = path.join(runDir, `frames-${label}.jsonl`);
  const recordFrame = (direction, payload) => {
    fs.appendFileSync(
      framesPath,
      `${redact(JSON.stringify({ ts: new Date().toISOString(), session: label, direction, payload }))}\n`,
    );
  };
  recordFrame('meta', { event: 'spawn', pid: transport.pid, spawnedAt, entry: ENTRY, config: CONFIG_PATH });
  const client = new Client({ name: `verify-${label}`, version: '1.0.0' });
  await client.connect(transport);
  const record = {
    label,
    client,
    pid: transport.pid,
    spawnedAt,
    recordFrame,
    serverInfo: client.getServerVersion(),
    /** A tool call that is recorded as a request/response pair, like session A's frames. */
    async callTool(name, args) {
      recordFrame('out', {
        jsonrpc: '2.0',
        id: `sdk-${name}`,
        method: 'tools/call',
        params: { name, arguments: args },
      });
      const result = await client.callTool({ name, arguments: args });
      recordFrame('in', { jsonrpc: '2.0', id: `sdk-${name}`, result });
      return result;
    },
    close: async () => {
      const exit = await client.close().then(
        () => ({ code: 0, signal: null }),
        (error) => ({ code: null, signal: null, error: error.message }),
      );
      fs.writeFileSync(path.join(runDir, `stderr-${label}.log`), redact(stderr));
      const result = { exit, stderr: redact(stderr) };
      if (onClose) await onClose({ pid: transport.pid, stderr });
      return result;
    },
  };
  return record;
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

export function createReport() {
  const checks = [];
  return {
    checks,
    check(id, ok, detail, options = {}) {
      checks.push({
        id,
        ok: Boolean(ok),
        blocking: options.blocking !== false,
        detail: detail === undefined ? null : detail,
      });
      return Boolean(ok);
    },
    note(id, detail) {
      checks.push({ id, ok: null, blocking: false, detail });
    },
    get failed() {
      return checks.filter((entry) => entry.blocking && entry.ok === false);
    },
    get verdict() {
      return this.failed.length === 0 ? 'pass' : 'fail';
    },
  };
}

export function writeJson(runDir, name, value) {
  const filePath = path.join(runDir, name);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

export function printChecks(report) {
  for (const entry of report.checks) {
    const mark = entry.ok === null ? 'INFO' : entry.ok ? 'PASS' : entry.blocking ? 'FAIL' : 'WARN';
    const detail = entry.detail === null ? '' : ` ${JSON.stringify(entry.detail)}`;
    process.stdout.write(`${mark}  ${entry.id}${detail}\n`);
  }
}

export function parseArgs(argv) {
  const args = { run: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--run') {
      args.run = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

export { sql };
