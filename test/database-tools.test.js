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
