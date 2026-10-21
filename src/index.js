#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { DatabaseManager } from './database.js';
import { errorMessage } from './errors.js';
import { WorkspaceStore } from './workspace-store.js';
import { createDatabaseTools } from './tools/database-tools.js';
import { createWorkspaceTools } from './tools/workspace-tools.js';
import { databaseToolSchemas, workspaceToolSchemas } from './tools/schemas.js';

const SERVER_INFO = {
  name: 'mssql-mcp',
  version: '0.1.0',
};

function logError(message, error) {
  process.stderr.write(`[mssql-mcp] ${message}: ${errorMessage(error)}\n`);
}

function registerTools(server, handlers) {
  for (const [name, handler] of Object.entries(handlers)) {
    server.registerTool(
      name,
      {
        description: toolDescriptions[name],
        inputSchema: schemasForTool(name),
      },
      async (args) => {
        try {
          return await handler(args);
        } catch (error) {
          logError(`Tool ${name} failed`, error);
          return {
            isError: true,
            content: [{ type: 'text', text: `Tool ${name} failed: ${errorMessage(error)}` }],
          };
        }
      },
    );
  }
}

function schemasForTool(name) {
  const shape = databaseToolSchemas[name] || workspaceToolSchemas[name];
  if (!shape) throw new Error(`No schema registered for tool ${name}.`);
  return shape;
}

const toolDescriptions = {
  list_connections: 'List all configured database connections with their available databases.',
  list_databases: 'List all databases available on a connection.',
  list_tables: 'List all tables and views in a schema.',
  describe_table: 'Get detailed column info: names, types, nullability, primary keys, foreign keys, defaults.',
  execute_sql: 'Execute a SQL query. Returns columns and rows as JSON with a bounded row limit.',
  search_columns: 'Search for columns across all tables in a schema by name pattern.',
  get_schema_summary: 'Get a lightweight overview of all tables and views in a schema.',
  get_erd: 'Get tables, columns, and foreign-key relationships for a schema.',
  manage_query_tab: 'Create, open, update, or close a persisted query tab.',
  manage_saved_queries: 'Create, list, get, update, or delete persisted saved SQL queries.',
  manage_query_folders: 'List, create, rename, or delete persisted saved-query folders.',
  open_table: 'Return a bounded table preview for a table or view.',
};

export function createServer({ config, database, workspace } = {}) {
  const resolvedConfig = config || (database && workspace ? { dataDir: process.cwd() } : loadConfig());
  const databaseManager = database || new DatabaseManager(resolvedConfig);
  const workspaceStore = workspace || new WorkspaceStore(resolvedConfig.dataDir);
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
  const handlers = {
    ...createDatabaseTools({ database: databaseManager }),
    ...createWorkspaceTools({ database: databaseManager, workspace: workspaceStore }),
  };
  registerTools(server, handlers);
  return { server, database: databaseManager, workspace: workspaceStore };
}

export async function start() {
  const context = createServer();
  const transport = new StdioServerTransport();
  transport.onerror = (error) => logError('stdio transport failed', error);
  process.once('SIGINT', async () => {
    await context.server.close();
    await context.database.close();
    process.exit(0);
  });
  process.once('SIGTERM', async () => {
    await context.server.close();
    await context.database.close();
    process.exit(0);
  });
  await context.server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => {
    logError('Server startup failed', error);
    process.exitCode = 1;
  });
}

export { toolDescriptions };
