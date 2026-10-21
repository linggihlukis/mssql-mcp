import { quoteIdentifier } from '../database.js';
import { AppError } from '../errors.js';

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function required(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(`${field} must be a non-empty string.`, { code: 'INVALID_INPUT' });
  }
  return value.trim();
}

function scopedArgs(database, args) {
  if (args.database || !args.connection) return args;
  return { ...args, database: database.getConnection(args.connection).database };
}

export function createWorkspaceTools({ database, workspace }) {
  return {
    manage_saved_queries: async (args) => {
      switch (args.action) {
        case 'create': {
          const query = workspace.createQuery(scopedArgs(database, args));
          return toolResult({
            status: 'created',
            database: query.database,
            queryId: query.id,
            title: query.title,
          });
        }
        case 'list': {
          const scoped = scopedArgs(database, args);
          const queries = workspace.listQueries(scoped.connection, scoped.database).map(
            ({ content, ...summary }) => summary,
          );
          return toolResult({ count: queries.length, queries });
        }
        case 'get':
          return toolResult(workspace.getQuery(args.queryId));
        case 'update': {
          const query = workspace.updateQuery(args);
          return toolResult({ status: 'updated', queryId: query.id, title: query.title });
        }
        case 'delete':
          return toolResult({ status: 'deleted', queryId: workspace.deleteQuery(args.queryId).queryId });
        default:
          throw new AppError(`Unsupported saved-query action "${args.action}".`, { code: 'INVALID_INPUT' });
      }
    },

    manage_query_folders: async (args) => {
      switch (args.action) {
        case 'list': {
          const scoped = scopedArgs(database, args);
          const folders = workspace.listFolders(scoped.connection, scoped.database);
          return toolResult({ count: folders.length, folders });
        }
        case 'create': {
          const folder = workspace.createFolder(scopedArgs(database, args));
          return toolResult({ status: 'created', folderId: folder.id, name: folder.name });
        }
        case 'rename': {
          const folder = workspace.renameFolder(args.folderId, args.name);
          return toolResult({ status: 'renamed', folderId: folder.id, name: folder.name });
        }
        case 'delete': {
          const result = workspace.deleteFolder(args.folderId);
          return toolResult({ status: 'deleted', folderId: result.folderId, deletedSubfolders: result.deletedSubfolders });
        }
        default:
          throw new AppError(`Unsupported query-folder action "${args.action}".`, { code: 'INVALID_INPUT' });
      }
    },

    manage_query_tab: async (args) => {
      switch (args.action) {
        case 'create': {
          const tab = workspace.createTab(scopedArgs(database, args));
          if (args.execute) {
            await database.query(tab.connection, tab.sql, { database: tab.database });
          }
          return toolResult({ status: 'created', tabId: tab.id, title: tab.title });
        }
        case 'open': {
          const tab = workspace.openTab(args.tabId, args.queryId);
          return toolResult({ status: 'opened', tabId: tab.id, title: tab.title });
        }
        case 'update': {
          const tab = workspace.updateTab(args);
          if (args.execute) {
            await database.query(tab.connection, tab.sql, { database: tab.database });
          }
          return toolResult({ status: 'updated', tabId: tab.id });
        }
        case 'close':
          return toolResult({ status: 'closed', tabId: workspace.closeTab(args.tabId).tabId });
        default:
          throw new AppError(`Unsupported query-tab action "${args.action}".`, { code: 'INVALID_INPUT' });
      }
    },

    open_table: async ({ connection, schema, table }) => {
      const schemaName = schema || 'dbo';
      const safeSchema = quoteIdentifier(schemaName, 'schema');
      const safeTable = quoteIdentifier(required(table, 'table'), 'table');
      const result = await database.query(
        connection,
        `SELECT TOP (100) * FROM ${safeSchema}.${safeTable};`,
        { rowLimit: 100 },
      );
      return toolResult({
        connection,
        schema: schemaName,
        table,
        preview: result,
        opened: true,
        note: 'Returned a bounded preview; a stdio server cannot open a GUI window.',
      });
    },
  };
}
