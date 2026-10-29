import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { WorkspaceStore } from '../src/workspace-store.js';

function makeContext() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-mcp-server-'));
  const fakeDatabase = {
    listConnectionDetails: async () => [{
      name: 'local',
      db_type: 'mssql',
      database: 'master',
      available_databases: ['master'],
    }],
    getConnection: () => ({ database: 'master', max_result_bytes: 262_144 }),
    listConnections: () => [{ name: 'local' }],
    query: async () => ({
      columns: [{ name: 'connection_test' }],
      row_count: 1,
      rows: [[1]],
      truncated: false,
    }),
    close: async () => {},
  };
  const context = createServer({
    database: fakeDatabase,
    workspace: new WorkspaceStore(directory),
  });
  return { context, directory };
}

test('MCP server — initialize and tools/list — exposes all DB Atelier-compatible tools', async () => {
  const { context, directory } = makeContext();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([context.server.connect(serverTransport), clientTransport.start()]);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  const result = await client.listTools();
  const names = result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'describe_table',
    'execute_sql',
    'get_erd',
    'get_schema_summary',
    'list_connections',
    'list_databases',
    'list_tables',
    'manage_query_folders',
    'manage_query_tab',
    'manage_saved_queries',
    'open_table',
    'search_columns',
  ]);
  await client.close();
  await context.server.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('MCP server — list_connections — returns JSON text compatible with DB Atelier', async () => {
  const { context, directory } = makeContext();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([context.server.connect(serverTransport), clientTransport.start()]);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  const result = await client.callTool({ name: 'list_connections', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), [{
    name: 'local',
    db_type: 'mssql',
    database: 'master',
    available_databases: ['master'],
  }]);
  await client.close();
  await context.server.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
