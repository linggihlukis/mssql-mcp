import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

const EMPTY_STATE = Object.freeze({ folders: [], queries: [], tabs: [] });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(`${field} must be a non-empty string.`, { code: 'INVALID_INPUT' });
  }
  return value.trim();
}

export class WorkspaceStore {
  constructor(dataDir, { fileName = 'workspace.json' } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.filePath = path.join(this.dataDir, fileName);
    this.state = this.load();
  }

  load() {
    try {
      const content = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(content);
      return {
        folders: Array.isArray(parsed.folders) ? parsed.folders : [],
        queries: Array.isArray(parsed.queries) ? parsed.queries : [],
        tabs: Array.isArray(parsed.tabs) ? parsed.tabs : [],
      };
    } catch (error) {
      if (error.code === 'ENOENT') return clone(EMPTY_STATE);
      throw new AppError(`Could not read workspace file "${this.filePath}".`, {
        code: 'WORKSPACE_READ_FAILED',
        cause: error,
      });
    }
  }

  save() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, this.filePath);
  }

  scopeMatches(item, connection, database) {
    return item.connection === connection && item.database === database;
  }

  requireScope(connection, database) {
    return {
      connection: requiredText(connection, 'connection'),
      database: requiredText(database || 'default', 'database'),
    };
  }

  listFolders(connection, database) {
    const scope = this.requireScope(connection, database);
    return this.state.folders.filter((folder) => this.scopeMatches(folder, scope.connection, scope.database));
  }

  createFolder({ connection, database, name, parentId = null }) {
    const scope = this.requireScope(connection, database);
    const folderName = requiredText(name, 'name');
    if (parentId && !this.state.folders.some((folder) =>
      folder.id === parentId && this.scopeMatches(folder, scope.connection, scope.database),
    )) {
      throw new AppError(`Parent folder "${parentId}" was not found in this workspace scope.`, {
        code: 'FOLDER_NOT_FOUND',
      });
    }
    const folder = {
      id: randomUUID(),
      connection: scope.connection,
      database: scope.database,
      name: folderName,
      parentId,
    };
    this.state.folders.push(folder);
    this.save();
    return clone(folder);
  }

  renameFolder(folderId, name) {
    const folder = this.state.folders.find((item) => item.id === requiredText(folderId, 'folderId'));
    if (!folder) throw new AppError(`Folder "${folderId}" was not found.`, { code: 'FOLDER_NOT_FOUND' });
    folder.name = requiredText(name, 'name');
    this.save();
    return clone(folder);
  }

  deleteFolder(folderId) {
    const id = requiredText(folderId, 'folderId');
    const ids = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of this.state.folders) {
        if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
          ids.add(folder.id);
          changed = true;
        }
      }
    }
    if (!this.state.folders.some((folder) => folder.id === id)) {
      throw new AppError(`Folder "${folderId}" was not found.`, { code: 'FOLDER_NOT_FOUND' });
    }
    const deletedSubfolders = [...ids].filter((folderIdValue) => folderIdValue !== id).length;
    this.state.folders = this.state.folders.filter((folder) => !ids.has(folder.id));
    this.state.queries = this.state.queries.filter((query) => !ids.has(query.folderId));
    this.state.tabs = this.state.tabs.filter((tab) => !ids.has(tab.folderId));
    this.save();
    return { deleted: true, folderId: id, deletedSubfolders };
  }

  listQueries(connection, database) {
    const scope = this.requireScope(connection, database);
    return this.state.queries.filter((query) => this.scopeMatches(query, scope.connection, scope.database));
  }

  createQuery({ connection, database, title, content, folderId = null }) {
    const scope = this.requireScope(connection, database);
    const query = {
      id: randomUUID(),
      connection: scope.connection,
      database: scope.database,
      title: requiredText(title || 'Untitled query', 'title'),
      content: typeof content === 'string' ? content : '',
      folderId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.state.queries.push(query);
    this.save();
    return clone(query);
  }

  getQuery(queryId) {
    const id = requiredText(queryId, 'queryId');
    const query = this.state.queries.find((item) => item.id === id);
    if (!query) throw new AppError(`Saved query "${queryId}" was not found.`, { code: 'QUERY_NOT_FOUND' });
    return clone(query);
  }

  updateQuery({ queryId, title, content, folderId }) {
    const id = requiredText(queryId, 'queryId');
    const query = this.state.queries.find((item) => item.id === id);
    if (!query) throw new AppError(`Saved query "${queryId}" was not found.`, { code: 'QUERY_NOT_FOUND' });
    if (title !== undefined) query.title = requiredText(title, 'title');
    if (content !== undefined) query.content = String(content);
    if (folderId !== undefined) query.folderId = folderId;
    query.updatedAt = new Date().toISOString();
    this.save();
    return clone(query);
  }

  deleteQuery(queryId) {
    const id = requiredText(queryId, 'queryId');
    const before = this.state.queries.length;
    this.state.queries = this.state.queries.filter((query) => query.id !== id);
    if (before === this.state.queries.length) {
      throw new AppError(`Saved query "${queryId}" was not found.`, { code: 'QUERY_NOT_FOUND' });
    }
    this.state.tabs = this.state.tabs.filter((tab) => tab.queryId !== id);
    this.save();
    return { deleted: true, queryId: id };
  }

  listTabs(connection, database) {
    const scope = this.requireScope(connection, database);
    return this.state.tabs.filter((tab) => this.scopeMatches(tab, scope.connection, scope.database));
  }

  createTab({ connection, database, title, sql, folderId = null, execute = false }) {
    const query = this.createQuery({ connection, database, title, content: sql, folderId });
    const tab = {
      id: query.id,
      queryId: query.id,
      connection: query.connection,
      database: query.database,
      title: query.title,
      sql: query.content,
      folderId: query.folderId,
      execute: Boolean(execute),
      openedAt: new Date().toISOString(),
    };
    this.state.tabs.push(tab);
    this.save();
    return clone(tab);
  }

  openTab(tabId, queryId) {
    const id = requiredText(tabId || queryId, 'tabId');
    const existing = this.state.tabs.find((tab) => tab.id === id || tab.queryId === id);
    if (existing) return clone(existing);
    const query = this.getQuery(queryId || tabId);
    const tab = {
      id: query.id,
      queryId: query.id,
      connection: query.connection,
      database: query.database,
      title: query.title,
      sql: query.content,
      folderId: query.folderId,
      execute: false,
      openedAt: new Date().toISOString(),
    };
    this.state.tabs.push(tab);
    this.save();
    return clone(tab);
  }

  updateTab({ tabId, sql, title, execute }) {
    const id = requiredText(tabId, 'tabId');
    const tab = this.state.tabs.find((item) => item.id === id);
    if (!tab) throw new AppError(`Tab "${tabId}" was not found.`, { code: 'TAB_NOT_FOUND' });
    if (sql !== undefined) tab.sql = String(sql);
    if (title !== undefined) tab.title = requiredText(title, 'title');
    if (execute !== undefined) tab.execute = Boolean(execute);
    this.updateQuery({ queryId: tab.queryId, title: tab.title, content: tab.sql, folderId: tab.folderId });
    this.save();
    return clone(tab);
  }

  closeTab(tabId) {
    const id = requiredText(tabId, 'tabId');
    const before = this.state.tabs.length;
    this.state.tabs = this.state.tabs.filter((tab) => tab.id !== id);
    if (before === this.state.tabs.length) {
      throw new AppError(`Tab "${tabId}" was not found.`, { code: 'TAB_NOT_FOUND' });
    }
    this.save();
    return { closed: true, tabId: id };
  }
}
