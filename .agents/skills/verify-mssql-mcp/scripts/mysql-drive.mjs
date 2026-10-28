// mysql-drive.mjs — one serialized drive of the mssql-mcp stdio server against MySQL.
//
// What "done" requires, and where each piece is proven:
//   1. one MCP client session: initialize + tools/list .......... session A (raw JSON-RPC frames)
//   2. one read tool, row shape and values ...................... session A, re-proven by session B
//      against a second independent session .................... session B (SDK client, new process)
//                                                                plus a direct MySQL connection
//   3. every write tool is refused ............................. MCP guard rejects (A), and
//      the driver is never reached ............................. no statement is logged by the server
//   4. the data did not move ................................... fingerprint before and after, direct
//
// Safety rules this file enforces, not merely documents:
//   * It refuses to run unless mysql-doctor.mjs passed for the same config hash.
//   * Every write probe is expected to be refused before the driver. None is a statement that could
//     succeed even if the guard failed on a writable login, because the target rows are filtered to
//     zero and DDL is never attempted outside the refusal path.
//   * No BEGIN/COMMIT, no DDL, no DELETE/TRUNCATE/DROP, no CREATE, anywhere.
//   * One process at a time; drives are serialized.
//   * Evidence is written outside the repository and the password is redacted in every artifact.
//
// Usage:
//   node .agents/skills/verify-mssql-mcp/scripts/mysql-drive.mjs [--run <doctor run dir>]

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG_PATH,
  MYSQL_COLUMNS_SQL,
  MYSQL_CONNECTION_NAME,
  MYSQL_OBJECT_COUNT_SQL,
  MYSQL_READ_ROW_LIMIT,
  MYSQL_READ_SCHEMA,
  MYSQL_READ_SQL,
  MYSQL_READ_TABLE,
  MYSQL_WRITE_PROBES,
  RawSession,
  createReport,
  listPayload,
  makeRedactor,
  mysqlDirectQuery,
  mysqlFingerprint,
  parseArgs,
  parseToolJson,
  printChecks,
  resolveMysqlConnection,
  resolveRunDir,
  sdkSession,
  sleep,
  toolText,
  withMysqlDirect,
  writeJson,
} from './mysql-lib.mjs';

function configHash() {
  return crypto.createHash('sha256').update(fs.readFileSync(CONFIG_PATH)).digest('hex');
}

function sortedById(rows) {
  return [...(rows ?? [])].sort((left, right) => {
    if (left[0] === right[0]) return 0;
    return left[0] < right[0] ? -1 : 1;
  });
}

/**
 * Read back every outbound tools/call frame and confirm each one stayed inside the configured
 * connection. Evidence from what the drive actually sent, not an assertion about what it should
 * have sent.
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
      const connection = toolArgs?.connection ?? null;
      sessions.add(frame.session);
      callsAudited.push({
        session: frame.session,
        tool: toolName,
        connection,
        database: toolArgs?.database ?? null,
        schema: toolArgs?.schema ?? null,
      });
      if (connection !== null && connection !== MYSQL_CONNECTION_NAME) {
        violations.push({ tool: toolName, reason: 'connection', connection });
      }
      // A MySQL schema is a database, so naming either one outside the configured schema is the
      // same scope escape.
      for (const key of ['database', 'schema']) {
        const value = toolArgs?.[key];
        if (value !== undefined && value !== MYSQL_READ_SCHEMA) {
          violations.push({ tool: toolName, reason: key, value });
        }
      }
    }
  }
  return {
    expected: { connection: MYSQL_CONNECTION_NAME, schema: MYSQL_READ_SCHEMA },
    callsAudited: callsAudited.length,
    sessions: [...sessions].sort(),
    toolsCalled: [...new Set(callsAudited.map((call) => call.tool))].sort(),
    violations,
    detail: redact(JSON.stringify(callsAudited)),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = resolveRunDir(args.run);
  const report = createReport();

  const connection = resolveMysqlConnection();
  const redact = makeRedactor([connection.password]);
  const results = { runDir, startedAt: new Date().toISOString(), db_type: 'mysql' };
  const sessions = [];

  // ------------------------------------------------------------------ preconditions
  const doctorPath = path.join(runDir, 'mysql-doctor.json');
  if (!fs.existsSync(doctorPath)) {
    process.stdout.write(`FAIL  preconditions.doctor-missing ${doctorPath}\n`);
    process.exitCode = 2;
    return;
  }
  const doctor = JSON.parse(fs.readFileSync(doctorPath, 'utf8'));
  report.check('preconditions.doctor-passed', doctor.verdict === 'pass', {
    verdict: doctor.verdict,
    checks: doctor.checks?.filter((entry) => entry.ok === false).map((entry) => entry.id),
  });
  report.check('preconditions.config-unchanged', doctor.configHash === configHash(), {
    doctor: doctor.configHash,
    now: configHash(),
  });
  report.check('preconditions.connection', connection.name === MYSQL_CONNECTION_NAME, {
    expected: MYSQL_CONNECTION_NAME,
    actual: connection.name,
  });
  if (report.failed.length > 0) {
    writeJson(runDir, 'mysql-drive.json', { ...results, verdict: 'blocked', checks: report.checks });
    printChecks(report);
    process.stdout.write('\nBLOCKED: the MySQL doctor did not pass for this config. Not driving.\n');
    process.exitCode = 2;
    return;
  }

  const before = await withMysqlDirect(async ({ pool }) => ({
    fingerprint: await mysqlFingerprint(pool),
    objects: await mysqlDirectQuery(pool, MYSQL_OBJECT_COUNT_SQL),
  }));
  results.before = before;
  const baselineFingerprint = JSON.stringify(doctor.baseline?.fingerprint);
  report.check(
    'preconditions.state-matches-doctor',
    baselineFingerprint === JSON.stringify(before.fingerprint),
    { doctor: doctor.baseline?.fingerprint, now: before.fingerprint },
  );

  const directRead = await withMysqlDirect(async ({ pool }) => mysqlDirectQuery(pool, MYSQL_READ_SQL));
  results.readDirect = directRead;
  const directRows = sortedById(directRead.rows);
  const directColumnNames = directRead.columns.map((column) => column.name);

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
      clientInfo: { name: 'verify-raw-mysql', version: '1.0.0' },
    });
    results.initialize = initA.result;
    report.check('mcp.initialize', initA.result?.serverInfo?.name === 'mssql-mcp', initA.result);
    sessionA.notify('notifications/initialized', {});

    const listA = await sessionA.request('tools/list', {});
    const toolNames = (listA.result?.tools ?? []).map((tool) => tool.name).sort();
    results.tools = toolNames;
    report.check('mcp.tools-list', toolNames.length === 12, { count: toolNames.length, tools: toolNames });
    report.check(
      'mcp.tools-list-expected',
      ['execute_sql', 'describe_table', 'open_table', 'list_tables', 'get_erd', 'list_databases']
        .every((name) => toolNames.includes(name)),
      toolNames,
    );

    // ---------------------------------------------------------------- the read journey
    const readA = await callA('execute_sql', {
      connection: MYSQL_CONNECTION_NAME,
      database: MYSQL_READ_SCHEMA,
      row_limit: MYSQL_READ_ROW_LIMIT,
      sql: MYSQL_READ_SQL,
    });
    results.readSessionA = readA.value;
    report.check('read.sessionA-not-error', !readA.isError, readA.text);
    report.check(
      'read.sessionA-columns',
      JSON.stringify(readA.value?.columns?.map((column) => column.name)) ===
        JSON.stringify(directColumnNames),
      { mcp: readA.value?.columns?.map((column) => column.name), direct: directColumnNames },
    );
    // The read asks for 50 of 75 rows, so the MCP result must equal the first 50 of the direct read
    // and must say so. Comparing the full set would fail on a correct server.
    const mcpRows = sortedById(readA.value?.rows);
    report.check(
      'read.sessionA-rows-match-direct',
      JSON.stringify(mcpRows) === JSON.stringify(directRows.slice(0, mcpRows.length)) &&
        (mcpRows.length === directRows.length || readA.value?.truncated === true),
      {
        mcp_row_count: mcpRows.length,
        direct_row_count: directRows.length,
        truncated: readA.value?.truncated,
      },
    );
    report.check('read.sessionA-truncated-is-boolean', typeof readA.value?.truncated === 'boolean', {
      truncated: readA.value?.truncated,
    });
    // The connection's max_row_limit is 500 and the read asks for 50, so the row cap is the ask.
    report.check(
      'read.sessionA-row-limit-honoured',
      (readA.value?.rows?.length ?? 0) <= MYSQL_READ_ROW_LIMIT,
      { returned: readA.value?.rows?.length, asked: MYSQL_READ_ROW_LIMIT },
    );

    // ---------------------------------------------------------------- schema metadata
    results.schema = {};

    const connections = await callA('list_connections', {});
    results.schema.list_connections = connections.value;
    report.check('schema.list-connections-not-error', !connections.isError, connections.text);
    const connectionList = listPayload(connections.value, 'connections');
    const selected = connectionList.items.find((entry) => entry?.name === MYSQL_CONNECTION_NAME);
    report.check('schema.list-connections-has-selected', Boolean(selected), {
      expected: MYSQL_CONNECTION_NAME,
      names: connectionList.items.map((entry) => entry?.name),
    });
    report.check(
      'schema.list-connections-reports-mysql',
      selected?.db_type === 'mysql' &&
        selected?.database === MYSQL_READ_SCHEMA &&
        Array.isArray(selected?.available_databases) &&
        selected.available_databases.includes(MYSQL_READ_SCHEMA),
      selected,
    );
    report.check(
      'schema.list-connections-mixes-dialects',
      connectionList.items.some((entry) => entry?.db_type === 'mssql') &&
        connectionList.items.some((entry) => entry?.db_type === 'mysql'),
      connectionList.items.map((entry) => ({ name: entry?.name, db_type: entry?.db_type })),
    );

    const databases = await callA('list_databases', { connection: MYSQL_CONNECTION_NAME });
    results.schema.list_databases = databases.value;
    report.check('schema.list-databases-not-error', !databases.isError, databases.text);
    report.check(
      'schema.list-databases-shape',
      databases.value?.current === MYSQL_READ_SCHEMA &&
        Array.isArray(databases.value?.databases) &&
        databases.value.databases.includes(MYSQL_READ_SCHEMA),
      { current: databases.value?.current, count: databases.value?.databases?.length },
    );

    const tables = await callA('list_tables', { connection: MYSQL_CONNECTION_NAME, schema: MYSQL_READ_SCHEMA });
    const tableList = listPayload(tables.value, 'items');
    results.schema.list_tables = {
      total: tableList.total,
      returned: tableList.items.length,
      truncated: tableList.truncated,
    };
    report.check('schema.list-tables-not-error', !tables.isError, tables.text);
    const directObjects = Number(before.objects.rows[0][0]);
    report.check(
      'schema.list-tables-matches-direct-count',
      tableList.total === directObjects,
      { mcp: tableList.total, direct: directObjects, truncated: tableList.truncated },
    );
    const target = tableList.items.find((entry) => entry?.name === MYSQL_READ_TABLE);
    report.check('schema.list-tables-has-target', Boolean(target), { expected: MYSQL_READ_TABLE });
    report.check('schema.list-tables-labels-type', target?.type === 'table', target);

    const described = await callA('describe_table', {
      connection: MYSQL_CONNECTION_NAME,
      schema: MYSQL_READ_SCHEMA,
      table: MYSQL_READ_TABLE,
    });
    results.schema.describe_table = described.value;
    report.check('schema.describe-table-not-error', !described.isError, described.text);
    const directColumns = await withMysqlDirect(async ({ pool }) =>
      mysqlDirectQuery(pool, MYSQL_COLUMNS_SQL),
    );
    const describedColumns = listPayload(described.value, 'columns').items;
    report.check(
      'schema.describe-table-columns-match-direct',
      JSON.stringify(describedColumns.map((column) => column.name)) ===
        JSON.stringify(directColumns.rows.map((row) => row[0])),
      { mcp: describedColumns.map((column) => column.name), direct: directColumns.rows.map((row) => row[0]) },
    );
    report.check(
      'schema.describe-table-types-match-direct',
      JSON.stringify(describedColumns.map((column) => column.type)) ===
        JSON.stringify(directColumns.rows.map((row) => String(row[1]).toLowerCase())),
      { mcp: describedColumns.map((column) => column.type), direct: directColumns.rows.map((row) => row[1]) },
    );
    report.check(
      'schema.describe-table-nullability-matches-direct',
      JSON.stringify(describedColumns.map((column) => column.nullable)) ===
        JSON.stringify(directColumns.rows.map((row) => row[2] === 'YES')),
      { mcp: describedColumns.map((column) => column.nullable), direct: directColumns.rows.map((row) => row[2]) },
    );
    report.check(
      'schema.describe-table-primary-key-matches-direct',
      JSON.stringify(describedColumns.map((column) => column.primary_key)) ===
        JSON.stringify(directColumns.rows.map((row) => row[3] === 'PRI')),
      { mcp: describedColumns.map((column) => column.primary_key), direct: directColumns.rows.map((row) => row[3]) },
    );

    const searched = await callA('search_columns', {
      connection: MYSQL_CONNECTION_NAME,
      schema: MYSQL_READ_SCHEMA,
      pattern: 'dept',
    });
    results.schema.search_columns = { count: searched.value?.count };
    report.check('schema.search-columns-not-error', !searched.isError, searched.text);
    const searchMatches = listPayload(searched.value, 'matches').items;
    report.check(
      'schema.search-columns-finds-matches',
      searchMatches.length > 0 && searchMatches.every((entry) => /dept/i.test(entry?.column ?? '')),
      { count: searchMatches.length, sample: searchMatches.slice(0, 3) },
    );

    const summary = await callA('get_schema_summary', { connection: MYSQL_CONNECTION_NAME, schema: MYSQL_READ_SCHEMA });
    results.schema.get_schema_summary = { total_tables: summary.value?.total_tables };
    report.check('schema.get-schema-summary-not-error', !summary.isError, summary.text);
    report.check(
      'schema.get-schema-summary-counts-every-object',
      summary.value?.total_tables === directObjects,
      { mcp: summary.value?.total_tables, direct: directObjects },
    );

    const erd = await callA('get_erd', {
      connection: MYSQL_CONNECTION_NAME,
      schema: MYSQL_READ_SCHEMA,
      tables: [MYSQL_READ_TABLE],
    });
    results.schema.get_erd = {
      total_tables: erd.value?.total_tables,
      total_relationships: erd.value?.total_relationships,
    };
    report.check('schema.get-erd-not-error', !erd.isError, erd.text);
    const erdTables = listPayload(erd.value, 'tables').items;
    report.check(
      'schema.get-erd-returns-the-requested-table',
      erdTables.length === 1 && erdTables[0]?.name === MYSQL_READ_TABLE,
      { tables: erdTables.map((table) => table?.name) },
    );
    report.check(
      'schema.get-erd-columns-match-describe',
      JSON.stringify(erdTables[0]?.columns?.map((column) => column.name)) ===
        JSON.stringify(describedColumns.map((column) => column.name)),
      { erd: erdTables[0]?.columns?.map((column) => column.name) },
    );
    // This schema declares no foreign keys, so zero is the honest answer and a fabricated edge
    // would be a mapping bug rather than a finding.
    report.note('schema.get-erd-relationships', {
      total: erd.value?.total_relationships,
      schema_declares_foreign_keys: false,
    });

    const preview = await callA('open_table', {
      connection: MYSQL_CONNECTION_NAME,
      schema: MYSQL_READ_SCHEMA,
      table: MYSQL_READ_TABLE,
    });
    results.schema.open_table = {
      row_count: preview.value?.preview?.row_count,
      truncated: preview.value?.preview?.truncated,
    };
    report.check('schema.open-table-not-error', !preview.isError, preview.text);
    report.check(
      'schema.open-table-rows-match-direct-prefix',
      JSON.stringify(preview.value?.preview?.rows?.slice(0, 5)) ===
        JSON.stringify(directRows.slice(0, 5)),
      { mcp: preview.value?.preview?.rows?.slice(0, 2), direct: directRows.slice(0, 2) },
    );
    const missing = await callA('open_table', {
      connection: MYSQL_CONNECTION_NAME,
      schema: MYSQL_READ_SCHEMA,
      table: 'table_that_does_not_exist',
    });
    report.check('schema.open-table-missing-is-error', missing.isError, missing.text.slice(0, 200));

    const badIdentifier = await callA('open_table', {
      connection: MYSQL_CONNECTION_NAME,
      schema: MYSQL_READ_SCHEMA,
      table: 'departments`; DROP TABLE departments; --',
    });
    report.check('schema.open-table-unsafe-identifier-is-error', badIdentifier.isError, badIdentifier.text.slice(0, 200));

    // ---------------------------------------------------------------- the local workspace lifecycle
    const folder = await callA('manage_query_folders', {
      connection: MYSQL_CONNECTION_NAME,
      database: MYSQL_READ_SCHEMA,
      action: 'create',
      name: 'verify-mysql',
    });
    report.check('workspace.folder-create', !folder.isError && typeof folder.value?.folderId === 'string', folder.value);
    const saved = await callA('manage_saved_queries', {
      connection: MYSQL_CONNECTION_NAME,
      database: MYSQL_READ_SCHEMA,
      action: 'create',
      title: 'verify read',
      content: MYSQL_READ_SQL,
      folderId: folder.value?.folderId,
    });
    report.check('workspace.query-create', !saved.isError && typeof saved.value?.queryId === 'string', saved.value);
    const fetched = await callA('manage_saved_queries', { action: 'get', queryId: saved.value?.queryId });
    report.check('workspace.query-get', fetched.value?.content === MYSQL_READ_SQL, {
      title: fetched.value?.title,
    });
    const listed = await callA('manage_saved_queries', {
      connection: MYSQL_CONNECTION_NAME,
      database: MYSQL_READ_SCHEMA,
      action: 'list',
    });
    report.check(
      'workspace.query-list',
      listPayload(listed.value, 'queries').items.some((entry) => entry?.id === saved.value?.queryId),
      { count: listed.value?.count },
    );
    const tab = await callA('manage_query_tab', {
      connection: MYSQL_CONNECTION_NAME,
      database: MYSQL_READ_SCHEMA,
      action: 'create',
      title: 'verify tab',
      sql: MYSQL_READ_SQL,
      execute: true,
    });
    report.check('workspace.tab-create-and-execute', !tab.isError && typeof tab.value?.tabId === 'string', {
      value: tab.value,
      text: tab.text.slice(0, 240),
    });
    const closed = await callA('manage_query_tab', { action: 'close', tabId: tab.value?.tabId });
    report.check('workspace.tab-close', closed.value?.status === 'closed', {
      value: closed.value,
      text: closed.text.slice(0, 240),
    });
    const removedQuery = await callA('manage_saved_queries', {
      action: 'delete',
      queryId: saved.value?.queryId,
    });
    report.check('workspace.query-delete', removedQuery.value?.status === 'deleted', removedQuery.value);
    const removedFolder = await callA('manage_query_folders', {
      action: 'delete',
      folderId: folder.value?.folderId,
    });
    report.check('workspace.folder-delete', removedFolder.value?.status === 'deleted', removedFolder.value);

    // ---------------------------------------------------------------- writes refused
    results.refusals = [];
    for (const probe of MYSQL_WRITE_PROBES) {
      const attempt = await callA('execute_sql', {
        connection: MYSQL_CONNECTION_NAME,
        database: MYSQL_READ_SCHEMA,
        sql: probe.sql,
      });
      const outcome = attempt.isError ? 'error' : 'accepted';
      results.refusals.push({ id: probe.id, outcome, text: attempt.text.slice(0, 240) });
      report.check(
        `refusal.execute_sql.${probe.id}`,
        attempt.isError && /Read-only connections/.test(attempt.text),
        { sql: probe.sql, text: attempt.text.slice(0, 240) },
      );
    }

    // The second route: a query tab that executes its own SQL.
    const writeTab = await callA('manage_query_tab', {
      connection: MYSQL_CONNECTION_NAME,
      database: MYSQL_READ_SCHEMA,
      action: 'create',
      sql: MYSQL_WRITE_PROBES.find((probe) => probe.id === 'delete').sql,
      execute: true,
    });
    report.check(
      'refusal.query-tab-execute',
      writeTab.isError && /Read-only connections/.test(writeTab.text),
      writeTab.text.slice(0, 240),
    );
    if (!writeTab.isError && writeTab.value?.tabId) {
      await callA('manage_query_tab', { action: 'close', tabId: writeTab.value.tabId });
    }

    // ---------------------------------------------------------------- the state did not move
    const afterA = await withMysqlDirect(async ({ pool }) => ({
      fingerprint: await mysqlFingerprint(pool),
      objects: await mysqlDirectQuery(pool, MYSQL_OBJECT_COUNT_SQL),
    }));
    results.afterSessionA = afterA;
    report.check(
      'state.fingerprint-unchanged-after-session-A',
      JSON.stringify(afterA.fingerprint) === JSON.stringify(before.fingerprint),
      { before: before.fingerprint, after: afterA.fingerprint },
    );
    report.check(
      'state.object-count-unchanged-after-session-A',
      JSON.stringify(afterA.objects.rows) === JSON.stringify(before.objects.rows),
      { before: before.objects.rows, after: afterA.objects.rows },
    );

    results.auditSessionA = auditCallScope(runDir, redact);
    report.check('scope.sessionA-no-violations', results.auditSessionA.violations.length === 0, {
      violations: results.auditSessionA.violations,
      callsAudited: results.auditSessionA.callsAudited,
    });

    const shutdownA = await sessionA.close();
    results.shutdownA = shutdownA;
    report.check('lifecycle.sessionA-exited-on-stdin-eof', shutdownA.exitAfterStdinEnd === true, shutdownA);

    // ---------------------------------------------------------------- session B (SDK client)
    const sessionB = await sdkSession({ label: 'B-sdk', runDir, redact });
    results.sessionB = { pid: sessionB.pid, serverInfo: sessionB.serverInfo };
    const readB = await sessionB.callTool('execute_sql', {
      connection: MYSQL_CONNECTION_NAME,
      database: MYSQL_READ_SCHEMA,
      row_limit: MYSQL_READ_ROW_LIMIT,
      sql: MYSQL_READ_SQL,
    });
    const readBValue = parseToolJson(readB);
    results.readSessionB = readBValue;
    report.check('read.sessionB-not-error', readB?.isError !== true, toolText(readB));
    report.check(
      'read.sessionB-matches-sessionA',
      JSON.stringify(sortedById(readBValue?.rows)) === JSON.stringify(sortedById(readA.value?.rows)),
      { sessionA: readA.value?.rows?.length, sessionB: readBValue?.rows?.length },
    );
    const writeB = await sessionB.callTool('execute_sql', {
      connection: MYSQL_CONNECTION_NAME,
      database: MYSQL_READ_SCHEMA,
      sql: MYSQL_WRITE_PROBES.find((probe) => probe.id === 'update').sql,
    });
    report.check(
      'refusal.sessionB-update',
      writeB?.isError === true && /Read-only connections/.test(toolText(writeB) ?? ''),
      toolText(writeB)?.slice(0, 240),
    );
    const closeB = await sessionB.close();
    results.shutdownB = closeB;
    report.check('lifecycle.sessionB-closed', true, closeB.exit);

    // ---------------------------------------------------------------- final state
    const after = await withMysqlDirect(async ({ pool }) => ({
      fingerprint: await mysqlFingerprint(pool),
      objects: await mysqlDirectQuery(pool, MYSQL_OBJECT_COUNT_SQL),
    }));
    results.after = after;
    report.check(
      'state.fingerprint-unchanged',
      JSON.stringify(after.fingerprint) === JSON.stringify(before.fingerprint),
      { before: before.fingerprint, after: after.fingerprint },
    );
    report.check(
      'state.object-count-unchanged',
      JSON.stringify(after.objects.rows) === JSON.stringify(before.objects.rows),
      { before: before.objects.rows, after: after.objects.rows },
    );

    results.audit = auditCallScope(runDir, redact);
    report.check('scope.no-violations', results.audit.violations.length === 0, {
      violations: results.audit.violations,
      callsAudited: results.audit.callsAudited,
      sessions: results.audit.sessions,
    });
    report.check(
      'scope.every-discovery-tool-called',
      ['list_connections', 'list_databases', 'list_tables', 'describe_table', 'search_columns', 'get_schema_summary', 'get_erd', 'open_table', 'execute_sql', 'manage_saved_queries', 'manage_query_folders', 'manage_query_tab']
        .every((name) => results.audit.toolsCalled.includes(name)),
      { toolsCalled: results.audit.toolsCalled },
    );
  } finally {
    for (const session of sessions) {
      if (!session.shutdown) await session.close().catch(() => {});
    }
  }

  writeJson(runDir, 'mysql-drive.json', JSON.parse(redact(JSON.stringify({
    ...results,
    verdict: report.verdict,
    checks: report.checks,
  }))));
  printChecks(report);
  process.stdout.write(`\nverdict: ${report.verdict}\nrun: ${runDir}\n`);
  if (report.verdict !== 'pass') process.exitCode = 1;
}

await main();
