import { z } from 'zod/v4';

const optionalString = z.string().optional();
const optionalDatabase = z.string().optional();
const optionalSchema = z.string().optional();
const optionalRowLimit = z.number().int().positive().optional();

export const databaseToolSchemas = {
  list_connections: {},
  list_databases: {
    connection: z.string().min(1).describe('Connection name'),
  },
  list_tables: {
    connection: z.string().min(1).describe('Connection name'),
    database: optionalDatabase.describe('Database name (defaults to the connection\'s configured database)'),
    schema: optionalSchema.describe('Schema name (defaults to public/default)'),
  },
  describe_table: {
    connection: z.string().min(1).describe('Connection name'),
    database: optionalDatabase.describe('Database name (defaults to the connection\'s configured database)'),
    schema: optionalSchema.describe('Schema name (defaults to public/default)'),
    table: z.string().min(1).describe('Table name'),
  },
  execute_sql: {
    connection: z.string().min(1).describe('Connection name'),
    database: optionalDatabase.describe('Database name (defaults to the connection\'s configured database)'),
    row_limit: optionalRowLimit.describe('Maximum rows to return (default 500)'),
    sql: z.string().min(1).describe('SQL query to execute'),
  },
  search_columns: {
    connection: z.string().min(1).describe('Connection name'),
    database: optionalDatabase.describe('Database name (defaults to the connection\'s configured database)'),
    pattern: z.string().min(1).describe('Column name substring to search for'),
    schema: optionalSchema.describe('Schema name (defaults to public/default)'),
  },
  get_schema_summary: {
    connection: z.string().min(1).describe('Connection name'),
    database: optionalDatabase.describe('Database name (defaults to the connection\'s configured database)'),
    schema: optionalSchema.describe('Schema name (defaults to public/default)'),
  },
  get_erd: {
    connection: z.string().min(1).describe('Connection name'),
    database: optionalDatabase.describe('Database name (defaults to the connection\'s configured database)'),
    schema: optionalSchema.describe('Schema name (defaults to public/default)'),
    tables: z.array(z.string().min(1)).optional().describe('Optional list of table names to include (defaults to all tables in schema)'),
  },
};

export const workspaceToolSchemas = {
  manage_query_tab: {
    action: z.enum(['create', 'open', 'update', 'close']).describe('The action to perform'),
    connection: optionalString.describe('Connection name (required for create)'),
    database: optionalString.describe('Database to scope the saved query to (for create; defaults to the connection\'s current database)'),
    execute: z.boolean().optional().describe('Whether to execute the query immediately (default false)'),
    folderId: z.string().nullable().optional().describe('Folder ID to place the query in (for create; null = root)'),
    queryId: optionalString.describe('Saved query ID to open (required for open)'),
    sql: optionalString.describe('SQL to write into the editor'),
    tabId: optionalString.describe('Tab ID returned from a previous create/open (required for update/close)'),
    title: optionalString.describe('Tab title (optional)'),
  },
  manage_saved_queries: {
    action: z.enum(['create', 'list', 'get', 'update', 'delete']).describe('The action to perform'),
    connection: optionalString.describe('Connection name (required for create/list)'),
    content: optionalString.describe('SQL content (for create/update)'),
    database: optionalString.describe('Database name (defaults to the connection\'s configured database; used for create/list to scope queries)'),
    folderId: z.string().nullable().optional().describe('Folder ID to place the query in (for create; null = root)'),
    queryId: optionalString.describe('Saved query ID (required for get/update/delete)'),
    title: optionalString.describe('Query title (for create/update)'),
  },
  manage_query_folders: {
    action: z.enum(['list', 'create', 'rename', 'delete']).describe('The action to perform'),
    connection: optionalString.describe('Connection name (required for list/create)'),
    database: optionalString.describe('Database name (defaults to the connection\'s configured database)'),
    folderId: optionalString.describe('Folder ID (required for rename/delete)'),
    name: optionalString.describe('Folder name (for create/rename)'),
    parentId: z.string().nullable().optional().describe('Parent folder ID (for create; null = root)'),
  },
  open_table: {
    connection: z.string().min(1).describe('Connection name'),
    schema: optionalSchema.describe('Schema name (defaults to public/default)'),
    table: z.string().min(1).describe('Table name to open'),
  },
};
