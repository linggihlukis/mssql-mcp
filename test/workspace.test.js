import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceStore } from '../src/workspace-store.js';
import { createWorkspaceTools } from '../src/tools/workspace-tools.js';

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sql-mcp-workspace-'));
}

function textResult(result) {
  return JSON.parse(result.content[0].text);
}

test('WorkspaceStore — query/folder/tab lifecycle — persists compatible workspace state', () => {
  const directory = tempDirectory();
  const first = new WorkspaceStore(directory);
  const folder = first.createFolder({ connection: 'local', database: 'master', name: 'Reports' });
  const query = first.createQuery({
    connection: 'local',
    database: 'master',
    title: 'Health check',
    content: 'SELECT 1',
    folderId: folder.id,
  });
  const tab = first.openTab(query.id);
  assert.equal(tab.queryId, query.id);
  assert.equal(first.listQueries('local', 'master').length, 1);
  assert.equal(first.listFolders('local', 'master').length, 1);

  const second = new WorkspaceStore(directory);
  assert.equal(second.getQuery(query.id).content, 'SELECT 1');
  assert.equal(second.listTabs('local', 'master').length, 1);
  second.updateTab({ tabId: tab.id, sql: 'SELECT 1 AS connection_test', title: 'Updated' });
  assert.equal(second.getQuery(query.id).content, 'SELECT 1 AS connection_test');
  second.deleteFolder(folder.id);
  assert.equal(second.listQueries('local', 'master').length, 0);
  assert.equal(second.listTabs('local', 'master').length, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('WorkspaceStore — foreign parent folder — is rejected', () => {
  const directory = tempDirectory();
  const store = new WorkspaceStore(directory);
  const folder = store.createFolder({ connection: 'local', database: 'master', name: 'Private' });
  assert.throws(
    () => store.createFolder({ connection: 'other', database: 'master', name: 'Invalid', parentId: folder.id }),
    /not found in this workspace scope/,
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test('Workspace tools — DB Atelier result shapes — return compact status objects', async () => {
  const directory = tempDirectory();
  const workspace = new WorkspaceStore(directory);
  const database = {
    query: async () => ({}),
    getConnection: () => ({ database: 'master', max_result_bytes: 262_144 }),
    listConnections: () => [{ name: 'local' }],
  };
  const tools = createWorkspaceTools({ workspace, database });

  const created = textResult(await tools.manage_saved_queries({
    action: 'create', connection: 'local', database: 'master', title: 'Health', content: 'SELECT 1', folderId: null,
  }));
  assert.deepEqual(Object.keys(created).sort(), ['database', 'queryId', 'status', 'title'].sort());
  const listed = textResult(await tools.manage_saved_queries({ action: 'list', connection: 'local', database: 'master' }));
  assert.equal(listed.count, 1);
  assert.equal('content' in listed.queries[0], false);
  const updated = textResult(await tools.manage_saved_queries({
    action: 'update', queryId: created.queryId, title: 'Health updated', content: 'SELECT 1 AS n', folderId: null,
  }));
  assert.deepEqual(updated, { status: 'updated', queryId: created.queryId, title: 'Health updated' });
  const deleted = textResult(await tools.manage_saved_queries({ action: 'delete', queryId: created.queryId }));
  assert.deepEqual(deleted, { status: 'deleted', queryId: created.queryId });

  const folder = textResult(await tools.manage_query_folders({
    action: 'create', connection: 'local', database: 'master', name: 'Reports', parentId: null,
  }));
  assert.deepEqual(Object.keys(folder).sort(), ['folderId', 'name', 'status'].sort());
  const folders = textResult(await tools.manage_query_folders({ action: 'list', connection: 'local', database: 'master' }));
  assert.deepEqual(folders.count, 1);
  const renamed = textResult(await tools.manage_query_folders({ action: 'rename', folderId: folder.folderId, name: 'Renamed' }));
  assert.deepEqual(renamed, { status: 'renamed', folderId: folder.folderId, name: 'Renamed' });
  const removed = textResult(await tools.manage_query_folders({ action: 'delete', folderId: folder.folderId }));
  assert.deepEqual(removed, { status: 'deleted', folderId: folder.folderId, deletedSubfolders: 0 });

  fs.rmSync(directory, { recursive: true, force: true });
});

test('WorkspaceStore — missing query — returns an actionable error', () => {
  const directory = tempDirectory();
  const store = new WorkspaceStore(directory);
  assert.throws(() => store.getQuery('missing'), /Saved query "missing" was not found/);
  fs.rmSync(directory, { recursive: true, force: true });
});
