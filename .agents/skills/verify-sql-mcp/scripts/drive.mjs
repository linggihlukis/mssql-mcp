// drive.mjs — one serialized drive of the sql-mcp stdio server against production.
//
// What "done" requires, and where each piece is proven:
//   1. one MCP client session: initialize + tools/list .......... session A (raw JSON-RPC frames)
//   2. one read tool, row shape and values ...................... session A, re-proven by session B
//      against a second independent session .................... session B (SDK client, new process)
//                                                                plus a direct DB connection
//   3. a write tool is refused ................................. MCP guard rejects (A), and
//      independently the SQL Server denies it .................. direct DB, no MCP in the path
//
// Safety rules this file enforces, not merely documents:
//   * It refuses to run unless doctor.mjs recorded readOnly=true for the same config hashes.
//   * The negative statements are structurally writes that affect zero rows AND that the verification login
//     cannot execute. A broken guard therefore yields permission error 229, never a mutation.
//   * No BEGIN TRAN/ROLLBACK, no DDL, no DELETE/TRUNCATE/DROP, no CREATE, anywhere.
//   * One process at a time; drives are serialized.
//   * Evidence is written outside the repository and the password is redacted in every artifact.
//
// Usage:
//   node .agents/skills/verify-sql-mcp/scripts/drive.mjs --run <doctor run dir>

import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG_PATH,
  CONNECTION_NAME,
  DIRECT_REQUEST_TIMEOUT_MS,
  EXPECTED_DATABASE,
  EXPECTED_LOGIN,
  FINGERPRINT_SQL,
  READ_ROW_LIMIT,
  READ_SCHEMA,
  READ_SQL,
  READ_TABLE,
  TABLE_COLUMNS_SQL,
  WRITE_PROBES,
  RawSession,
  createReport,
  directQuery,
  makeRedactor,
  parseArgs,
  printChecks,
  resolveConnection,
  resolveRunDir,
  sdkSession,
  sleep,
  withDirectConnection,
  writeJson,
} from './lib.mjs';

import crypto from 'node:crypto';

function configHash() {
  return crypto.createHash('sha256').update(fs.readFileSync(CONFIG_PATH)).digest('hex');
}

function parseToolJson(result) {
  const text = result?.content?.find((entry) => entry.type === 'text')?.text;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toolText(result) {
  return result?.content?.find((entry) => entry.type === 'text')?.text ?? null;
}

/**
 * A list tool returns a bare array when nothing was cut, and an object holding the list under a
 * named key plus `total_count` / `truncated` when the byte cap dropped entries. Normalise both so a
 * check never depends on which shape happened to be returned.
 */
function listPayload(value, key) {
  if (Array.isArray(value)) return { items: value, total: value.length, truncated: false };
  const items = Array.isArray(value?.[key]) ? value[key] : [];
  return {
    items,
    total: typeof value?.total_count === 'number' ? value.total_count : items.length,
    truncated: value?.truncated === true,
  };
}

function sortedById(rows) {
  return [...(rows ?? [])].sort((left, right) => {
    if (left[0] === right[0]) return 0;
    return left[0] < right[0] ? -1 : 1;
  });
}

/**
 * Read back every outbound tools/call frame and confirm each one stayed inside the configured
 * connection and database. This is evidence from what the drive actually sent, not an assertion
 * about what the server ought to have done.
 */
function auditCallScope(runDir, redact) {
  const callsAudited = [];
  const violations = [];
  const sessions = new Set();
  for (const name of fs.readdirSync(runDir)) {
    if (!name.startsWith('frames-') || !name.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(runDir, name), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (frame?.direction !== 'out' || frame?.payload?.method !== 'tools/call') continue;
      const { name: toolName, arguments: toolArgs } = frame.payload.params ?? {};
      const database = toolArgs?.database ?? null;
      const connection = toolArgs?.connection ?? null;
      sessions.add(frame.session);
      callsAudited.push({ session: frame.session, tool: toolName, connection, database });
      if (connection !== null && connection !== CONNECTION_NAME) {
        violations.push({ tool: toolName, reason: 'connection', connection });
      }
      if (database !== null && database !== EXPECTED_DATABASE) {
        violations.push({ tool: toolName, reason: 'database', database });
      }
    }
  }
  return {
    expected: { connection: CONNECTION_NAME, database: EXPECTED_DATABASE },
    callsAudited: callsAudited.length,
    sessions: [...sessions].sort(),
    databasesNamed: [...new Set(callsAudited.map((call) => call.database ?? EXPECTED_DATABASE))],
    toolsCalled: [...new Set(callsAudited.map((call) => call.tool))],
    violations,
    detail: redact(JSON.stringify(callsAudited)),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = resolveRunDir(args.run);
  const report = createReport();

  const connection = resolveConnection();
  const redact = makeRedactor([connection.password]);
  const results = { runDir, startedAt: new Date().toISOString() };
  const sessions = [];

  // ------------------------------------------------------------------ preconditions
  const proofPath = path.join(runDir, 'proof.json');
  if (!fs.existsSync(proofPath)) {
    process.stdout.write(`FAIL  preconditions.proof-missing ${proofPath}\n`);
    process.exitCode = 2;
    return;
  }
  const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  report.check('preconditions.doctor-passed', proof.readOnly === true, {
    readOnly: proof.readOnly,
    verdict: proof.verdict,
  });
  report.check('preconditions.config-unchanged', proof.facts?.configSha256 === configHash(), {
    doctor: proof.facts?.configSha256,
    now: configHash(),
  });
  report.check('preconditions.connection', connection.name === CONNECTION_NAME, {
    expected: CONNECTION_NAME,
    actual: connection.name,
  });

  if (report.failed.length > 0) {
    writeJson(runDir, 'drive.json', { ...results, verdict: 'blocked', checks: report.checks });
    printChecks(report);
    process.stdout.write('\nBLOCKED: doctor did not prove read-only for this config. Not driving.\n');
    process.exitCode = 2;
    return;
  }

  const before = await withDirectConnection(async ({ pool }) => ({
    fingerprint: await directQuery(pool, FINGERPRINT_SQL),
    columns: await directQuery(pool, TABLE_COLUMNS_SQL),
    database: await directQuery(pool, 'SELECT TOP (1) DB_ID() AS database_id, DB_NAME() AS database_name'),
  }));
  results.before = before;
  const targetDatabaseId = before.database.rows[0][0];

  // The independent witness is read before any MCP session so every comparison below can use it,
  // including the preview and metadata checks that run before session B exists.
  const directRead = await withDirectConnection(async ({ pool }) => directQuery(pool, READ_SQL));
  results.readDirect = directRead;
  const directRows = directRead.rows;
  const directColumnNames = directRead.columns.map((column) => column.name);
  const directTypes = directRead.columns.map((column) => column.type);

  try {
    // ---------------------------------------------------------------- session A (raw frames)
    const sessionA = new RawSession({ label: 'A-raw', runDir, redact });
    sessions.push(sessionA);
    await sessionA.start();
    results.sessionA = { pid: sessionA.pid, frames: path.basename(sessionA.framesPath) };
    const callA = async (name, args) => {
      const response = await sessionA.request('tools/call', { name, arguments: args });
      return {
        response,
        value: parseToolJson(response.result),
        text: toolText(response.result) ?? '',
        isError: response.result?.isError === true,
      };
    };

    const initA = await sessionA.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'verify-raw', version: '1.0.0' },
    });
    results.initialize = initA.result;
    report.check('mcp.initialize', initA.result?.serverInfo?.name === 'sql-mcp', initA.result);
    sessionA.notify('notifications/initialized', {});

    const listA = await sessionA.request('tools/list', {});
    const toolNames = (listA.result?.tools ?? []).map((tool) => tool.name).sort();
    results.tools = toolNames;
    report.check('mcp.tools-list', toolNames.length === 12, { count: toolNames.length });
    report.check(
      'mcp.tools-list-expected',
      ['execute_sql', 'describe_table', 'open_table', 'list_tables'].every((name) =>
        toolNames.includes(name),
      ),
      toolNames,
    );
    // No dedicated write tool exists. execute_sql is the direct route; manage_query_tab with
    // execute: true is the second, also guarded route.
    const writeToolNames = toolNames.filter((name) => /insert|update|delete|write|drop|truncate/i.test(name));
    report.note('mcp.write-tool-surface', {
      dedicatedWriteTool: writeToolNames.length > 0 ? writeToolNames : null,
      routeAttempted: 'execute_sql',
    });

    // ---------------------------------------------------------------- the read journey
    const readA = await sessionA.request('tools/call', {
      name: 'execute_sql',
      arguments: {
        connection: CONNECTION_NAME,
        database: EXPECTED_DATABASE,
        row_limit: READ_ROW_LIMIT,
        sql: READ_SQL,
      },
    });
    results.readSessionA = readA.result;
    report.check('read.sessionA-not-error', readA.result?.isError !== true, {
      isError: readA.result?.isError ?? false,
    });
    const readAValue = parseToolJson(readA.result);

    // ---------------------------------------------------------------- schema metadata
    // All seven discovery tools, in the same session, against the selected connection.
    results.schema = {};

    const connections = await callA('list_connections', {});
    results.schema.list_connections = connections.value;
    report.check('schema.list-connections-not-error', !connections.isError, connections.text);
    const connectionList = listPayload(connections.value, 'connections');
    const selectedEntry = connectionList.items.find((entry) => entry?.name === CONNECTION_NAME);
    report.check('schema.list-connections-has-selected', Boolean(selectedEntry), {
      expected: CONNECTION_NAME,
      names: connectionList.items.map((entry) => entry?.name),
    });
    report.check(
      'schema.list-connections-shape',
      selectedEntry?.db_type === 'mssql' &&
        selectedEntry?.database === EXPECTED_DATABASE &&
        Array.isArray(selectedEntry?.available_databases) &&
        selectedEntry.available_databases.includes(EXPECTED_DATABASE),
      selectedEntry,
    );
    // The tool opens a master pool for every configured connection, not only the selected one.
    report.note('schema.list-connections-pools', {
      reason: 'one master pool per configured connection',
      names: connectionList.items.map((entry) => entry?.name),
    });

    const databases = await callA('list_databases', { connection: CONNECTION_NAME });
    results.schema.list_databases = databases.value;
    report.check('schema.list-databases-not-error', !databases.isError, databases.text);
    report.check(
      'schema.list-databases-shape',
      databases.value?.current === EXPECTED_DATABASE &&
        Array.isArray(databases.value?.databases) &&
        databases.value.databases.includes(EXPECTED_DATABASE),
      databases.value,
    );

    const tables = await callA('list_tables', { connection: CONNECTION_NAME, schema: READ_SCHEMA });
    const tableList = listPayload(tables.value, 'items');
    results.schema.list_tables = {
      total: tableList.total,
      returned: tableList.items.length,
      truncated: tableList.truncated,
    };
    report.check('schema.list-tables-not-error', !tables.isError, tables.text);
    const branchGroup = tableList.items.find((entry) => entry?.name === READ_TABLE);
    report.check('schema.list-tables-has-target', Boolean(branchGroup), {
      expected: READ_TABLE,
      returned: tableList.items.length,
      truncated: tableList.truncated,
    });
    report.check('schema.list-tables-labels-type', branchGroup?.type === 'table', branchGroup);
    report.check(
      'schema.list-tables-shape',
      tableList.items.length > 0 &&
        tableList.items.every(
          (entry) => typeof entry?.name === 'string' && ['table', 'view'].includes(entry?.type),
        ),
      { count: tableList.items.length },
    );

    const described = await callA('describe_table', {
      connection: CONNECTION_NAME,
      schema: READ_SCHEMA,
      table: READ_TABLE,
    });
    results.schema.describe_table = described.value;
    report.check('schema.describe-not-error', !described.isError, described.text);
    const describedColumns = described.value?.columns ?? [];
    report.check(
      'schema.describe-columns',
      JSON.stringify(describedColumns.map((column) => column.name)) ===
        JSON.stringify(directColumnNames) &&
        JSON.stringify(describedColumns.map((column) => column.type)) ===
          JSON.stringify(directTypes),
      { described: describedColumns, direct: directColumnNames, directTypes },
    );
    report.check(
      'schema.describe-primary-key',
      describedColumns[0]?.primary_key === true &&
        describedColumns[0]?.nullable === false &&
        describedColumns.slice(1).every((column) => column.nullable === true),
      describedColumns,
    );
    // The description promises foreign-key flags; the handler does not emit them. Pin the actual
    // shape so the map cannot silently claim a field the client never receives.
    report.check(
      'schema.describe-no-foreign-key-field',
      describedColumns.every((column) => !('is_foreign_key' in column)),
      describedColumns,
    );

    const searched = await callA('search_columns', {
      connection: CONNECTION_NAME,
      schema: READ_SCHEMA,
      pattern: 'SubGolongan',
    });
    results.schema.search_columns = searched.value;
    report.check('schema.search-not-error', !searched.isError, searched.text);
    const searchMatches = searched.value?.matches ?? [];
    report.check(
      'schema.search-count',
      searched.value?.truncated === true
        ? searched.value.count >= searchMatches.length
        : searched.value?.count === searchMatches.length,
      {
        count: searched.value?.count,
        returned: searchMatches.length,
        truncated: searched.value?.truncated ?? false,
      },
    );
    report.check(
      'schema.search-matches-shape',
      searchMatches.length > 0 &&
        searchMatches.every(
          (match) =>
            typeof match?.column === 'string' &&
            typeof match?.table === 'string' &&
            typeof match?.type === 'string',
        ),
      { count: searchMatches.length },
    );

    const summary = await callA('get_schema_summary', {
      connection: CONNECTION_NAME,
      schema: READ_SCHEMA,
    });
    const summaryTables = summary.value?.tables ?? [];
    results.schema.get_schema_summary = {
      total: summary.value?.total_tables ?? null,
      returned: summaryTables.length,
      truncated: summary.value?.truncated ?? false,
    };
    report.check('schema.summary-not-error', !summary.isError, summary.text);
    report.check(
      'schema.summary-count',
      summary.value?.truncated === true
        ? summary.value.total_tables >= summaryTables.length
        : summary.value?.total_tables === summaryTables.length,
      {
        total: summary.value?.total_tables,
        returned: summaryTables.length,
        truncated: summary.value?.truncated ?? false,
      },
    );
    report.check(
      'schema.summary-column-count',
      summaryTables.length > 0 &&
        summaryTables.every((entry) => Number.isInteger(entry?.column_count)),
      { tables: summaryTables.length },
    );

    const erd = await callA('get_erd', {
      connection: CONNECTION_NAME,
      schema: READ_SCHEMA,
      tables: [READ_TABLE],
    });
    results.schema.get_erd = erd.value;
    report.check('schema.erd-not-error', !erd.isError, erd.text);
    report.check(
      'schema.erd-one-table',
      erd.value?.tables?.length === 1 && erd.value.tables[0]?.name === READ_TABLE,
      erd.value?.tables,
    );
    report.check(
      'schema.erd-relationships-count',
      erd.value?.truncated === true
        ? erd.value.total_relationships >= (erd.value?.relationships?.length ?? 0)
        : erd.value?.total_relationships === (erd.value?.relationships?.length ?? 0),
      {
        total: erd.value?.total_relationships,
        returned: erd.value?.relationships?.length ?? 0,
      },
    );

    // ---------------------------------------------------------------- open_table preview
    const opened = await callA('open_table', {
      connection: CONNECTION_NAME,
      schema: READ_SCHEMA,
      table: READ_TABLE,
    });
    results.openTable = opened.value;
    report.check('open.not-error', !opened.isError, opened.text);
    const preview = opened.value?.preview;
    report.check(
      'open.preview-identity',
      opened.value?.opened === true &&
        opened.value?.connection === CONNECTION_NAME &&
        opened.value?.schema === READ_SCHEMA &&
        opened.value?.table === READ_TABLE,
      opened.value,
    );
    report.check(
      'open.preview-note',
      typeof opened.value?.note === 'string' &&
        opened.value.note.includes('stdio server cannot open a GUI window'),
      opened.value?.note,
    );
    // `open_table` builds the flag as `result.truncated || marker.truncated`, so a complete preview
    // omits it entirely instead of reporting false. Pin the shape the client actually receives; the
    // inconsistency with `execute_sql` (which always reports a boolean) is reported as a product gap.
    const previewTruncated = preview?.truncated;
    report.check(
      'open.preview-bound',
      Number.isInteger(preview?.row_count) &&
        preview.row_count <= 100 &&
        preview.row_count === (preview?.rows?.length ?? -1) &&
        (previewTruncated === undefined || typeof previewTruncated === 'boolean'),
      {
        row_count: preview?.row_count,
        rows: preview?.rows?.length,
        truncated: previewTruncated,
      },
    );
    report.note('open.preview-truncated-flag', {
      observed: previewTruncated === undefined ? 'absent' : previewTruncated,
      reason:
        'open_table omits truncated when the preview is complete; execute_sql always reports a boolean',
    });
    report.check(
      'open.preview-matches-direct',
      JSON.stringify(sortedById(preview?.rows)) === JSON.stringify(sortedById(directRows)),
      { preview: preview?.rows, direct: directRows },
    );

    const missingTable = await callA('open_table', {
      connection: CONNECTION_NAME,
      schema: READ_SCHEMA,
      table: 'verify_probe_absent',
    });
    report.check('open.missing-is-error', missingTable.isError, missingTable.text);
    report.check(
      'open.missing-message',
      missingTable.text.includes('Invalid object name'),
      missingTable.text,
    );

    const unsafeTable = await callA('open_table', {
      connection: CONNECTION_NAME,
      schema: READ_SCHEMA,
      table: `${READ_TABLE}; DROP TABLE x`,
    });
    report.check('open.unsafe-is-error', unsafeTable.isError, unsafeTable.text);
    report.check(
      'open.unsafe-message',
      unsafeTable.text.includes(`Invalid table "${READ_TABLE}; DROP TABLE x".`),
      unsafeTable.text,
    );

    // ---------------------------------------------------------------- local query workspace
    // Scratch state only: SQL_MCP_DATA_DIR points inside the run directory.
    results.workspace = {};

    const folder = await callA('manage_query_folders', {
      action: 'create',
      connection: CONNECTION_NAME,
      database: EXPECTED_DATABASE,
      name: 'verify',
    });
    results.workspace.folder = folder.value;
    report.check(
      'workspace.folder-create',
      !folder.isError && folder.value?.status === 'created' && typeof folder.value?.folderId === 'string',
      folder.value ?? folder.text,
    );
    const folderId = folder.value?.folderId;

    const saved = await callA('manage_saved_queries', {
      action: 'create',
      connection: CONNECTION_NAME,
      database: EXPECTED_DATABASE,
      title: 'verify',
      content: 'SELECT 1',
      folderId,
    });
    results.workspace.saved = saved.value;
    report.check(
      'workspace.query-create',
      !saved.isError && saved.value?.status === 'created' && typeof saved.value?.queryId === 'string',
      saved.value ?? saved.text,
    );
    const queryId = saved.value?.queryId;

    const listed = await callA('manage_saved_queries', {
      action: 'list',
      connection: CONNECTION_NAME,
      database: EXPECTED_DATABASE,
    });
    const listedQueries = listed.value?.queries ?? [];
    report.check(
      'workspace.query-list',
      !listed.isError &&
        listed.value?.count === listedQueries.length &&
        listedQueries.some((entry) => entry?.id === queryId) &&
        listedQueries.every((entry) => !('content' in entry)),
      { count: listed.value?.count, ids: listedQueries.map((entry) => entry?.id) },
    );

    const got = await callA('manage_saved_queries', { action: 'get', queryId });
    report.check(
      'workspace.query-get',
      !got.isError && got.value?.id === queryId && got.value?.content === 'SELECT 1',
      got.value ?? got.text,
    );

    const updated = await callA('manage_saved_queries', {
      action: 'update',
      queryId,
      title: 'verify-2',
    });
    report.check(
      'workspace.query-update',
      !updated.isError && updated.value?.status === 'updated' && updated.value?.title === 'verify-2',
      updated.value ?? updated.text,
    );

    const tab = await callA('manage_query_tab', {
      action: 'create',
      connection: CONNECTION_NAME,
      database: EXPECTED_DATABASE,
      title: 'verify-tab',
      sql: 'SELECT TOP (1) DB_NAME() AS db',
      execute: true,
    });
    results.workspace.tab = tab.value;
    report.check(
      'workspace.tab-create-executes',
      !tab.isError && tab.value?.status === 'created' && typeof tab.value?.tabId === 'string',
      tab.value ?? tab.text,
    );
    const tabId = tab.value?.tabId;

    const openedTab = await callA('manage_query_tab', { action: 'open', tabId });
    report.check(
      'workspace.tab-open',
      !openedTab.isError && openedTab.value?.status === 'opened',
      openedTab.value ?? openedTab.text,
    );

    const updatedTab = await callA('manage_query_tab', {
      action: 'update',
      tabId,
      sql: 'SELECT TOP (1) DB_NAME() AS db',
      execute: true,
    });
    report.check(
      'workspace.tab-update-executes',
      !updatedTab.isError && updatedTab.value?.status === 'updated',
      updatedTab.value ?? updatedTab.text,
    );

    // A rejected execute still persists the tab. Use the zero-row probe, never a destructive one.
    const rejectedTab = await callA('manage_query_tab', {
      action: 'create',
      connection: CONNECTION_NAME,
      database: EXPECTED_DATABASE,
      title: 'verify-write-tab',
      sql: WRITE_PROBES.find((probe) => probe.id === 'update').sql,
      execute: true,
    });
    report.check(
      'workspace.tab-execute-guarded',
      rejectedTab.isError &&
        rejectedTab.text.includes('Read-only connections reject "UPDATE" statements'),
      rejectedTab.text,
    );
    const listedAfterRejected = await callA('manage_saved_queries', {
      action: 'list',
      connection: CONNECTION_NAME,
      database: EXPECTED_DATABASE,
    });
    report.check(
      'workspace.rejected-tab-persists',
      (listedAfterRejected.value?.queries ?? []).some(
        (entry) => entry?.title === 'verify-write-tab',
      ),
      { titles: (listedAfterRejected.value?.queries ?? []).map((entry) => entry?.title) },
    );

    const renamedFolder = await callA('manage_query_folders', {
      action: 'rename',
      folderId,
      name: 'verify-renamed',
    });
    report.check(
      'workspace.folder-rename',
      !renamedFolder.isError &&
        renamedFolder.value?.status === 'renamed' &&
        renamedFolder.value?.name === 'verify-renamed',
      renamedFolder.value ?? renamedFolder.text,
    );

    const closedTab = await callA('manage_query_tab', { action: 'close', tabId });
    report.check(
      'workspace.tab-close',
      !closedTab.isError && closedTab.value?.status === 'closed',
      closedTab.value ?? closedTab.text,
    );

    // Keep the scratch store as evidence before the finally block removes the scratch directory.
    // Deletes happen after session B has read the store, so this copy shows the pre-delete state.
    const workspacePath = path.join(runDir, 'mcp-data', 'workspace.json');
    report.check('workspace.store-exists', fs.existsSync(workspacePath), workspacePath);
    if (fs.existsSync(workspacePath)) {
      fs.copyFileSync(workspacePath, path.join(runDir, 'workspace-before-cleanup.json'));
    }

    // ---------------------------------------------------------------- session B (independent)
    // A second process, driven through the official SDK client instead of hand-written frames.
    const sessionB = await sdkSession({
      label: 'B-sdk',
      runDir,
      redact,
      onClose: async ({ pid }) => {
        results.sessionB = { ...(results.sessionB || {}), pid, stopped: true };
      },
    });
    results.sessionB = { pid: sessionB.pid, serverInfo: sessionB.serverInfo };
    report.check(
      'mcp.sessionB-independent',
      sessionB.pid !== sessionA.pid && Boolean(sessionB.pid),
      { sessionAPid: sessionA.pid, sessionBPid: sessionB.pid },
    );

    const readB = await sessionB.callTool('execute_sql', {
      connection: CONNECTION_NAME,
      database: EXPECTED_DATABASE,
      row_limit: READ_ROW_LIMIT,
      sql: READ_SQL,
    });
    results.readSessionB = readB;
    report.check('read.sessionB-not-error', readB?.isError !== true, {
      isError: readB?.isError ?? false,
    });
    const readBValue = parseToolJson(readB);

    // Persistence: session B is a separate process started after the workspace was written, so a
    // successful read here proves the store survived a restart.
    const persisted = await sessionB.callTool('manage_saved_queries', { action: 'get', queryId });
    const persistedValue = parseToolJson(persisted);
    report.check(
      'workspace.persists-across-sessions',
      persisted?.isError !== true && persistedValue?.content === 'SELECT 1',
      persistedValue ?? toolText(persisted),
    );

    // Local deletes are allowed in the run's scratch store, and only there. They run after the
    // persistence proof so the second session still finds the saved query.
    const deletedQuery = await callA('manage_saved_queries', { action: 'delete', queryId });
    report.check(
      'workspace.query-delete',
      !deletedQuery.isError && deletedQuery.value?.status === 'deleted',
      deletedQuery.value ?? deletedQuery.text,
    );

    const deletedFolder = await callA('manage_query_folders', { action: 'delete', folderId });
    report.check(
      'workspace.folder-delete',
      !deletedFolder.isError &&
        deletedFolder.value?.status === 'deleted' &&
        deletedFolder.value?.folderId === folderId,
      deletedFolder.value ?? deletedFolder.text,
    );

    // ---------------------------------------------------------------- compare values
    report.check(
      'read.values-sessionA-equals-direct',
      JSON.stringify(readAValue?.rows) === JSON.stringify(directRows),
      { mcp: readAValue?.rows, direct: directRows },
    );
    report.check(
      'read.values-sessionB-equals-direct',
      JSON.stringify(readBValue?.rows) === JSON.stringify(directRows),
      { mcp: readBValue?.rows, direct: directRows },
    );
    report.check(
      'read.values-sessions-agree',
      JSON.stringify(readAValue?.rows) === JSON.stringify(readBValue?.rows),
      null,
    );

    // Row shape: the declared column contract, checked against the catalog and the direct read.
    const mcpColumnNames = (readAValue?.columns ?? []).map((column) => column.name);
    const mcpColumnTypes = (readAValue?.columns ?? []).map((column) => column.data_type);
    report.check('read.shape-column-count', mcpColumnNames.length === directColumnNames.length, {
      mcp: mcpColumnNames,
      direct: directColumnNames,
    });
    report.check(
      'read.shape-column-names',
      JSON.stringify(mcpColumnNames) === JSON.stringify(directColumnNames),
      { mcp: mcpColumnNames, direct: directColumnNames },
    );
    report.check(
      'read.shape-column-types',
      JSON.stringify(mcpColumnTypes) === JSON.stringify(directTypes),
      { mcp: mcpColumnTypes, direct: directTypes },
    );
    report.check(
      'read.shape-row-count',
      readAValue?.row_count === directRows.length &&
        readBValue?.row_count === directRows.length,
      { mcpA: readAValue?.row_count, mcpB: readBValue?.row_count, direct: directRows.length },
    );
    report.check(
      'read.shape-bounded',
      (readAValue?.rows?.length ?? Infinity) <= READ_ROW_LIMIT &&
        typeof readAValue?.truncated === 'boolean',
      { rows: readAValue?.rows?.length, truncated: readAValue?.truncated },
    );
    report.check(
      'read.catalog-agrees-with-returned-columns',
      JSON.stringify(before.columns.rows.map((row) => row[1])) === JSON.stringify(directColumnNames),
      {
        catalog: before.columns.rows.map((row) => row[1]),
        direct: directColumnNames,
      },
    );

    // ---------------------------------------------------------------- write refusal, part 1
    // The MCP guard under test. Safe even if the guard is broken: the verification login lacks the permission.
    results.writeRefusal = { mcpGuard: [], serverDenial: [] };
    for (const probe of WRITE_PROBES) {
      const refused = await sessionA.request('tools/call', {
        name: 'execute_sql',
        arguments: { connection: CONNECTION_NAME, database: EXPECTED_DATABASE, sql: probe.sql },
      });
      const text = toolText(refused.result) ?? '';
      const entry = {
        probe: probe.id,
        statement: probe.sql,
        isError: refused.result?.isError ?? false,
        message: text,
      };
      results.writeRefusal.mcpGuard.push(entry);
      report.check(`write.guard-rejects-${probe.id}`, refused.result?.isError === true, entry);
      report.check(
        `write.guard-names-${probe.id}`,
        text.includes(`Read-only connections reject "${probe.word}"`),
        { message: text },
      );
    }

    // ---------------------------------------------------------------- write refusal, part 2
    // No MCP in this path at all: a plain driver connection. If this returns a permission error,
    // the read-only guarantee comes from SQL Server, not from the guard that was just exercised.
    for (const probe of WRITE_PROBES) {
      const denial = await withDirectConnection(async ({ pool }) => {
        try {
          await pool.request().query(probe.sql);
          return { denied: false, number: null, message: 'statement succeeded' };
        } catch (error) {
          return { denied: true, number: error.number ?? null, message: error.message };
        }
      });
      results.writeRefusal.serverDenial.push({ probe: probe.id, statement: probe.sql, ...denial });
      report.check(`write.server-denies-${probe.id}`, denial.denied === true, denial);
      report.check(`write.server-error-229-${probe.id}`, denial.number === 229, {
        number: denial.number,
      });
    }

    // ---------------------------------------------------------------- nothing mutated
    const after = await withDirectConnection(async ({ pool }) => ({
      fingerprint: await directQuery(pool, FINGERPRINT_SQL),
    }));
    results.after = after;
    report.check(
      'safety.fingerprint-unchanged',
      JSON.stringify(before.fingerprint.rows) === JSON.stringify(after.fingerprint.rows),
      { before: before.fingerprint.rows, after: after.fingerprint.rows },
    );

    // ---------------------------------------------------------------- one database only
    // A DMV-based check is impossible here: the verification login has VIEW SERVER STATE = 0, so
    // sys.dm_exec_sessions shows only the querying session (verified: visible_other_sessions = 0).
    // Any "sessions outside Uranus" query therefore returns 0 no matter what the MCP did, which
    // would be a check that always passes — worse than no check.
    //
    // Scope is proven structurally instead, from the frames this drive actually recorded: every
    // tools/call the MCP received must name the configured connection and either omit `database`
    // (meaning the configured one) or name Uranus explicitly.
    const scope = auditCallScope(runDir, redact);
    results.databaseScope = scope;
    report.check('safety.single-database', scope.violations.length === 0, {
      callsAudited: scope.callsAudited,
      databasesNamed: scope.databasesNamed,
      violations: scope.violations,
    });
    // The audit must have seen both sessions, or it is not covering the whole drive.
    report.check('safety.scope-audit-covers-both-sessions', scope.sessions.length === 2, {
      sessions: scope.sessions,
    });
    report.note('safety.dmv-attribution-unavailable', {
      reason: 'VIEW SERVER STATE = 0; sys.dm_exec_sessions exposes only the querying session',
      sessionsVisibleToLogin: 1,
    });

    // ---------------------------------------------------------------- shutdown
    const shutdownB = await sessionB.close();
    results.sessionBShutdown = shutdownB ?? { stopped: true };
    const shutdownA = await sessionA.close();
    results.sessionAShutdown = shutdownA;
    report.check('lifecycle.sessionA-exited', Boolean(shutdownA.exit), shutdownA);
    // The server exits when stdin closes, so a client that disconnects does not leave it running
    // until the pool idle timeout. A regression here strands a process per session.
    report.check('lifecycle.stdin-eof-exits', shutdownA.exitAfterStdinEnd === true, {
      exitAfterStdinEnd: shutdownA.exitAfterStdinEnd,
      forcedKill: shutdownA.forcedKill,
    });
  } catch (error) {
    report.check('drive.error', false, redact(error.message));
    results.error = redact(error.stack || error.message);
  } finally {
    for (const session of sessions) {
      if (session instanceof RawSession && !session.exit) {
        await session.close().catch(() => {});
      }
    }
    // Scratch only: the MCP workspace copy this run created. Evidence stays.
    const scratch = path.join(runDir, 'mcp-data');
    if (fs.existsSync(scratch)) {
      fs.rmSync(scratch, { recursive: true, force: true });
      results.scratchRemoved = path.basename(scratch);
    }
  }

  results.finishedAt = new Date().toISOString();
  results.verdict = report.verdict;
  results.failed = report.failed.map((entry) => entry.id);
  writeJson(runDir, 'drive.json', { ...results, checks: report.checks });
  printChecks(report);
  process.stdout.write(`\nverdict: ${results.verdict}\nrun: ${runDir}\n`);
  process.exitCode = report.verdict === 'pass' ? 0 : 1;
}

await main();
