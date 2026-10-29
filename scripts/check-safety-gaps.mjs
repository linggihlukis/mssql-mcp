// Proves the three gaps, then proves them fixed. Rerun after the fix: same script, same checks.
//
//   1. read_only must default to true, so a config that omits the key cannot write.
//   2. A tool result must be bounded in bytes, not only in rows.
//   3. Closing stdin must exit the process without waiting for the pool idle timeout.
//
// Usage: node scripts/check-safety-gaps.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseManager, normalizeResult } from '../src/database.js';
import { createMssqlDialect } from '../src/dialects/mssql.js';
import { loadConfig } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

function record(id, ok, detail) {
  results.push({ id, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}\n`);
}

// ---------------------------------------------------------------------------- gap 1
function gap1() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-ro-'));
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      connections: [{ name: 'c', host: 'h', database: 'd', username_env: 'U', password_env: 'P' }],
    }),
  );
  const config = loadConfig({
    env: { MSSQL_MCP_CONFIG: path.join(dir, 'config.json'), U: 'u', P: 'p' },
  });
  const readOnly = config.connections[0].read_only;
  record('read_only defaults to true when the key is absent', readOnly === true, { readOnly });

  // And the default must actually block a write before the driver sees it.
  const executed = [];
  class FakePool {
    async connect() { return this; }
    request() {
      return {
        arrayRowMode: false,
        query: async (text) => {
          executed.push(text);
          return { columns: [{ name: 'v', type: { declaration: 'int' } }], recordset: [[1]] };
        },
      };
    }
    async close() {}
  }
  return (async () => {
    const manager = new DatabaseManager(config, {
      dialects: { mssql: createMssqlDialect({ driver: { ConnectionPool: FakePool } }) },
    });
    let outcome;
    try {
      await manager.query('c', 'DELETE FROM dbo.Users WHERE 1 = 0');
      outcome = 'executed';
    } catch (error) {
      outcome = error.code;
    }
    await manager.close();
    record('a config without read_only blocks a write before the driver', outcome === 'READ_ONLY_VIOLATION', {
      outcome,
      statementsReachingDriver: executed.length,
    });
    fs.rmSync(dir, { recursive: true, force: true });
  })();
}

// ---------------------------------------------------------------------------- gap 2
function gap2() {
  const rows = Array.from({ length: 500 }, () => ['x'.repeat(4000)]);
  const result = normalizeResult(
    { columns: [[{ name: 'body', type: { declaration: 'nvarchar' } }]], recordset: rows },
    500,
    rows.length,
    { maxBytes: 64 * 1024 },
  );
  // Measure the whole envelope the tool ships, pretty-printed exactly as toolResult does.
  const bytes = Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8');
  record('a large result is capped in bytes and reports truncated', bytes <= 64 * 1024 && result.truncated === true, {
    bytes,
    cap: 64 * 1024,
    rowCount: result.row_count,
    truncated: result.truncated,
  });

  // A small result must be untouched, and must not claim truncation.
  const small = normalizeResult(
    { columns: [[{ name: 'id', type: { declaration: 'int' } }]], recordset: [[1], [2]] },
    500,
    2,
    { maxBytes: 64 * 1024 },
  );
  record('a small result passes through unchanged', JSON.stringify(small.rows) === '[[1],[2]]' && small.truncated === false, {
    rows: small.rows,
    truncated: small.truncated,
  });

  // The cap must hold for the shipped envelope, not only an inner slice. Indentation and the
  // row_count/truncated keys are part of what reaches the client.
  const wide = Array.from({ length: 500 }, (_, i) => [`${i}`.padEnd(900, 'x')]);
  const wideResult = normalizeResult(
    { columns: [[{ name: 'body', type: { declaration: 'nvarchar' } }]], recordset: wide },
    500,
    wide.length,
    { maxBytes: 262_144 },
  );
  const shipped = Buffer.byteLength(JSON.stringify(wideResult, null, 2), 'utf8');
  record('the cap covers the whole pretty-printed envelope', shipped <= 262_144, {
    shipped,
    cap: 262_144,
    rowCount: wideResult.row_count,
  });
}

// ---------------------------------------------------------------------------- gap 3
function gap3() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'src', 'index.js')], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        MSSQL_MCP_CONFIG: path.join(root, 'config.json'),
        MSSQL_MCP_DATA_DIR: path.join(os.tmpdir(), 'gap-eof-data'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    const pending = new Map();
    let id = 0;
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      }
    });
    const request = (method, params) =>
      new Promise((done) => {
        const requestId = ++id;
        pending.set(requestId, done);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
      });

    let exited = null;
    child.on('exit', (code) => {
      exited = code;
    });

    (async () => {
      await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'gap-check', version: '1' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
      // Open a pool, which is what makes the process linger.
      await request('tools/call', {
        name: 'execute_sql',
        arguments: { connection: 'sqlserver_prod', sql: 'SELECT TOP (1) 1 AS x' },
      });
      const started = Date.now();
      child.stdin.end();
      const timer = setInterval(() => {
        if (exited !== null) {
          clearInterval(timer);
          const elapsedMs = Date.now() - started;
          record('closing stdin exits promptly after a pool is open', elapsedMs < 3000, { elapsedMs, code: exited });
          resolve();
        } else if (Date.now() - started > 8000) {
          clearInterval(timer);
          child.kill('SIGKILL');
          record('closing stdin exits promptly after a pool is open', false, { elapsedMs: Date.now() - started, code: null });
          resolve();
        }
      }, 100);
    })();
  });
}

await gap1();
gap2();
await gap3();

const failed = results.filter((entry) => !entry.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks pass\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
