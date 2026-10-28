import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseManager } from '../src/database.js';
import { createMssqlDialect } from '../src/dialects/mssql.js';
import { createDatabaseTools } from '../src/tools/database-tools.js';

// The tools no longer touch a pool, so these fakes sit one layer lower: a fake driver that records
// every statement and bound parameter the dialect sends. The real manager and the real mssql dialect
// stay in the path, which is what the cost and parameter-binding assertions are about.
function fakeDatabase(recordset) {
  const calls = [];
  class FakePool {
    constructor(config) {
      this.config = config;
      this.connected = false;
    }

    async connect() {
      this.connected = true;
      return this;
    }

    request() {
      const inputs = {};
      return {
        arrayRowMode: false,
        input(name, value) {
          inputs[name] = value;
          calls.push(['input', name, value]);
        },
        query: async (text) => {
          calls.push(['query', text]);
          const rows = typeof recordset === 'function' ? recordset(text, inputs) : recordset;
          return { columns: [], recordset: rows };
        },
      };
    }

    async close() {}
  }

  const database = new DatabaseManager(
    {
      connections: [{
        name: 'local',
        db_type: 'mssql',
        host: '127.0.0.1',
        port: 1433,
        database: 'master',
        username: 'reader',
        password: 'secret',
        read_only: true,
        max_row_limit: 500,
        max_result_bytes: 262_144,
        query_timeout_ms: 1000,
        connection_timeout_ms: 1000,
        options: { encrypt: false, trustServerCertificate: true },
      }],
    },
    { dialects: { mssql: createMssqlDialect({ driver: { ConnectionPool: FakePool } }) } },
  );
  database.calls = calls;
  return database;
}

const usersColumnRow = {
  schema_name: 'dbo',
  object_name: 'Users',
  object_type: 'USER_TABLE',
  column_name: 'Id',
  data_type: 'int',
  max_length: 4,
  is_nullable: false,
  default_definition: null,
  is_primary_key: true,
  is_foreign_key: false,
  referenced_schema_name: null,
  referenced_object_name: null,
  referenced_column_name: null,
};

test('database tools — omitted schema — bind dbo instead of leaving @schema unbound', async () => {
  const database = fakeDatabase([usersColumnRow]);
  const tools = createDatabaseTools({ database });
  await tools.list_tables({ connection: 'local' });
  assert.deepEqual(database.calls[0], ['input', 'schema', 'dbo']);
});

test('database tools — describe_table — returns DB Atelier-compatible column fields', async () => {
  const database = fakeDatabase([usersColumnRow]);
  const tools = createDatabaseTools({ database });
  const result = await tools.describe_table({ connection: 'local', table: 'Users' });
  const value = JSON.parse(result.content[0].text);
  assert.deepEqual(value, {
    schema: 'dbo',
    table: 'Users',
    columns: [{ name: 'Id', nullable: false, primary_key: true, type: 'int' }],
  });
});

test('database tools — list_tables — maps each object to a name and a table/view type', async () => {
  const database = fakeDatabase([
    { schema_name: 'dbo', object_name: 'Users', object_type: 'USER_TABLE' },
    { schema_name: 'dbo', object_name: 'ActiveUsers', object_type: 'VIEW' },
  ]);
  const tools = createDatabaseTools({ database });
  const value = JSON.parse((await tools.list_tables({ connection: 'local' })).content[0].text);
  assert.deepEqual(value, [
    { name: 'Users', type: 'table' },
    { name: 'ActiveUsers', type: 'view' },
  ]);
});

test('database tools — list_tables — asks the server for objects, not for columns', async () => {
  // A cost guard rather than a behaviour test: the observable cost of list_tables is how many rows
  // the server returns to answer it. On Uranus the column join returns 3,622 rows to produce 178
  // objects and costs about 870 ms per call, so a reintroduced join must fail here rather than
  // silently doubling the latency of a tool an agent calls often.
  const database = fakeDatabase([]);
  const tools = createDatabaseTools({ database });
  await tools.list_tables({ connection: 'local' });
  const statements = database.calls.filter(([kind]) => kind === 'query').map(([, text]) => text);
  assert.equal(statements.length, 1);
  assert.doesNotMatch(statements[0], /sys\.columns/);
  assert.doesNotMatch(statements[0], /OUTER APPLY/);
});
