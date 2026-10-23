// Proves every tool result respects the connection's max_result_bytes. Rerun after the fix.
//
// A tool result that ignores the cap ships megabytes to the client: get_erd on a 128-table schema
// measured 539,646 bytes against a 262,144-byte cap. execute_sql was capped; the catalog tools were
// not, so this check drives each tool through a fake pool that returns more catalog rows than the
// cap allows and measures the text the client receives.
//
// Usage: node scripts/check-result-caps.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../src/database.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { createDatabaseTools } from '../src/tools/database-tools.js';
import { createWorkspaceTools } from '../src/tools/workspace-tools.js';

// Small enough that every tool whose payload grows with schema size must hit it, so a regression
// cannot hide behind a fixture that happens to collapse to a few rows.
const CAP = 8 * 1024;
const OBJECTS = 400;
const COLUMNS_PER_OBJECT = 5;

const results = [];

function record(id, ok, detail) {
  results.push({ id, ok, detail });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}\n`);
}

function catalogRows() {
  const rows = [];
  for (let object = 0; object < OBJECTS; object += 1) {
    for (let column = 0; column < COLUMNS_PER_OBJECT; column += 1) {
      rows.push({
        schema_name: 'dbo',
        object_name: `TABLE_${String(object).padStart(3, '0')}`,
        object_type: 'USER_TABLE',
        column_name: `Column_${column}_With_A_Long_Descriptive_Name`,
        data_type: 'nvarchar',
        max_length: 256,
        is_nullable: true,
        default_definition: null,
        is_primary_key: column === 0,
        is_foreign_key: false,
        referenced_schema_name: null,
        referenced_object_name: null,
        referenced_column_name: null,
      });
    }
  }
  return rows;
}

function fakeDatabase() {
  const rows = catalogRows();
  class FakePool {
    constructor(config) {
      this.config = config;
      this.connected = true;
    }

    async connect() {
      return this;
    }

    request() {
      const inputs = {};
      const request = {
        arrayRowMode: false,
        input(name, value) {
          inputs[name] = value;
        },
        query: async (text) => {
          // list_connections and list_databases read sys.databases; keep that realistic, or the pin
          // measures a payload no real server produces.
          if (/sys\.databases/i.test(text)) {
            const names = ['master', 'model', 'msdb', 'tempdb', 'Uranus'].map((name) => ({ name }));
            return request.arrayRowMode
              ? { columns: [[{ name: 'name', nullable: false, type: { declaration: 'nvarchar' } }]], recordset: names.map((row) => [row.name]) }
              : { columns: [[{ name: 'name', nullable: false, type: { declaration: 'nvarchar' } }]], recordset: names };
          }
          const selected = inputs.table
            ? rows.filter((row) => row.object_name === inputs.table)
            : rows;
          const names = Object.keys(rows[0]);
          const columns = [names.map((name) => ({ name, nullable: true, type: { declaration: 'nvarchar' } }))];
          // The catalog tools read named properties; execute_sql reads positional arrays. Honour
          // whichever mode the caller asked for, or the pin measures a shape nothing produces.
          return request.arrayRowMode
            ? { columns, recordset: selected.map((row) => names.map((name) => row[name])) }
            : { columns, recordset: selected };
        },
      };
      return request;
    }

    async close() {}
  }

  return new DatabaseManager(
    {
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'caps-')),
      connections: [{
        name: 'capped',
        db_type: 'mssql',
        host: '127.0.0.1',
        port: 1433,
        database: 'd',
        username: 'u',
        password: 'p',
        read_only: true,
        max_row_limit: 500,
        max_result_bytes: CAP,
        query_timeout_ms: 1000,
        connection_timeout_ms: 1000,
        options: { encrypt: false, trustServerCertificate: true },
      }],
    },
    { driver: { ConnectionPool: FakePool } },
  );
}

function bytesOf(result) {
  return result.content.reduce((total, block) => total + Buffer.byteLength(block.text ?? '', 'utf8'), 0);
}

const database = fakeDatabase();
const databaseTools = createDatabaseTools({ database });
const workspace = new WorkspaceStore(fs.mkdtempSync(path.join(os.tmpdir(), 'caps-ws-')));
const workspaceTools = createWorkspaceTools({ database, workspace });
const connection = 'capped';

const cases = [
  ['list_connections', () => databaseTools.list_connections()],
  ['list_databases', () => databaseTools.list_databases({ connection })],
  ['list_tables', () => databaseTools.list_tables({ connection, schema: 'dbo' })],
  ['get_schema_summary', () => databaseTools.get_schema_summary({ connection, schema: 'dbo' })],
  ['get_erd', () => databaseTools.get_erd({ connection, schema: 'dbo' })],
  ['search_columns', () => databaseTools.search_columns({ connection, schema: 'dbo', pattern: 'Column' })],
  ['describe_table', () => databaseTools.describe_table({ connection, schema: 'dbo', table: 'TABLE_000' })],
  ['execute_sql', () => databaseTools.execute_sql({ connection, sql: 'SELECT 1 AS value' })],
  ['open_table', () => workspaceTools.open_table({ connection, schema: 'dbo', table: 'TABLE_000' })],
];

for (const [name, call] of cases) {
  let result;
  try {
    result = await call();
  } catch (error) {
    record(`${name} result fits max_result_bytes`, false, { error: error.message });
    continue;
  }
  const bytes = bytesOf(result);
  const first = result.content[0]?.text ?? '';
  let parsed;
  let validJson = true;
  try {
    parsed = JSON.parse(first);
  } catch {
    validJson = false;
  }
  // A capped result must still carry data. A bare notice is a failure, not a cap: it would mean the
  // tool gave up instead of returning the largest prefix that fits.
  const carriesData = validJson && parsed !== null && !(parsed.truncated === true && parsed.max_bytes !== undefined);
  record(`${name} result fits max_result_bytes`, bytes <= CAP && validJson && carriesData, {
    bytes,
    cap: CAP,
    validJson,
    carriesData,
    truncated: parsed?.truncated,
    blocks: result.content.length,
  });
}

await database.close();

const failed = results.filter((entry) => !entry.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks pass\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
