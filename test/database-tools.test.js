import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabaseTools } from '../src/tools/database-tools.js';

function fakeDatabase() {
  const calls = [];
  const rows = [
    {
      schema_name: 'dbo',
      object_name: 'Users',
      object_type: 'USER_TABLE',
      column_name: 'Id',
      data_type: 'int',
      is_nullable: false,
      is_primary_key: true,
      is_foreign_key: false,
      default_definition: null,
    },
  ];
  return {
    calls,
    getConnection: () => ({ database: 'master', max_result_bytes: 262_144 }),
    getPool: async (_connection, _database) => ({
      request: () => ({
        input: (name, value) => calls.push(['input', name, value]),
        query: async (sql) => {
          calls.push(['query', sql]);
          return { recordset: rows };
        },
      }),
    }),
  };
}

test('database tools — omitted schema — bind dbo instead of leaving @schema unbound', async () => {
  const database = fakeDatabase();
  const tools = createDatabaseTools({ database });
  await tools.list_tables({ connection: 'local' });
  assert.deepEqual(database.calls[0], ['input', 'schema', 'dbo']);
});

test('database tools — describe_table — returns DB Atelier-compatible column fields', async () => {
  const database = fakeDatabase();
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
  const database = {
    getConnection: () => ({ database: 'master', max_result_bytes: 262_144 }),
    getPool: async () => ({
      request: () => ({
        input() {},
        query: async () => ({
          recordset: [
            { schema_name: 'dbo', object_name: 'Users', object_type: 'USER_TABLE' },
            { schema_name: 'dbo', object_name: 'ActiveUsers', object_type: 'VIEW' },
          ],
        }),
      }),
    }),
  };
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
  const statements = [];
  const database = {
    getConnection: () => ({ database: 'master', max_result_bytes: 262_144 }),
    getPool: async () => ({
      request: () => ({
        input() {},
        query: async (text) => {
          statements.push(text);
          return { recordset: [] };
        },
      }),
    }),
  };
  const tools = createDatabaseTools({ database });
  await tools.list_tables({ connection: 'local' });
  assert.equal(statements.length, 1);
  assert.doesNotMatch(statements[0], /sys\.columns/);
  assert.doesNotMatch(statements[0], /OUTER APPLY/);
});
