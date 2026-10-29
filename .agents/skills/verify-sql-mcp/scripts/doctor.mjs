// doctor.mjs — prove the instance is read-only before anything is driven.
//
// Fail closed: any write bit granted, any login/database mismatch, or any unreachable identity check
// exits non-zero and writes proof.readOnly=false. drive.mjs refuses to run without readOnly=true.
//
// Usage:
//   node .agents/skills/verify-sql-mcp/scripts/doctor.mjs
//   node .agents/skills/verify-sql-mcp/scripts/doctor.mjs --run <dir>

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG_PATH,
  CONNECTION_NAME,
  EXPECTED_DATABASE,
  EXPECTED_LOGIN,
  EXPECTED_SERVER,
  FINGERPRINT_SQL,
  TABLE_COLUMNS_SQL,
  createReport,
  createRunDir,
  directQuery,
  makeRedactor,
  parseArgs,
  printChecks,
  readRawConfig,
  resolveConnection,
  withDirectConnection,
  writeJson,
} from './lib.mjs';

const HARNESS_CONFIG = path.join(
  process.env.USERPROFILE || '',
  '.dsh-mcp',
  'mcp-bundles',
  'cordis.patch.yml',
);

const WRITE_PERMISSIONS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'ALTER',
  'CREATE TABLE',
  'CONTROL',
];

const SERVER_WRITE_PERMISSIONS = ['CREATE ANY DATABASE', 'CONTROL SERVER', 'ALTER ANY DATABASE'];

function sha256File(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function configFacts(raw, connection) {
  const names = (raw.connections || []).map((entry) => entry.name);
  return {
    configPath: CONFIG_PATH,
    configSha256: sha256File(CONFIG_PATH),
    harnessConfigPath: HARNESS_CONFIG,
    harnessConfigSha256: sha256File(HARNESS_CONFIG),
    connectionNames: names,
    connectionName: connection.name,
    host: connection.host,
    port: connection.port,
    configuredDatabase: connection.database,
    configuredLogin: connection.username,
    readOnlyFlag: connection.read_only,
    secretsFromEnv: Boolean(connection.raw.username_env || connection.raw.password_env),
  };
}

function permissionQuery() {
  const columns = WRITE_PERMISSIONS.map(
    (permission) =>
      `  HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', '${permission}') AS can_${permission
        .toLowerCase()
        .replaceAll(' ', '_')}`,
  ).join(',\n');
  const serverColumns = SERVER_WRITE_PERMISSIONS.map(
    (permission) =>
      `  HAS_PERMS_BY_NAME(NULL, NULL, '${permission}') AS can_${permission
        .toLowerCase()
        .replaceAll(' ', '_')}`,
  ).join(',\n');
  return `SELECT
  SUSER_SNAME() AS login_name,
  ORIGINAL_LOGIN() AS original_login,
  USER_NAME() AS database_user,
  DB_NAME() AS database_name,
  DB_ID() AS database_id,
  @@SERVERNAME AS server_name,
  CAST(SERVERPROPERTY('ServerName') AS nvarchar(128)) AS server_property_name,
  CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS product_version,
  HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'SELECT') AS can_select,
${columns},
${serverColumns},
  IS_SRVROLEMEMBER('sysadmin') AS is_sysadmin,
  IS_SRVROLEMEMBER('dbcreator') AS is_dbcreator,
  IS_MEMBER('db_owner') AS is_db_owner,
  IS_MEMBER('db_datawriter') AS is_datawriter,
  IS_MEMBER('db_ddladmin') AS is_ddladmin,
  IS_MEMBER('db_datareader') AS is_datareader`;
}

// Every database the login can see, judged from Uranus only — this run never opens another one.
function crossDatabaseQuery() {
  const columns = WRITE_PERMISSIONS.map(
    (permission) =>
      `  MAX(CASE WHEN HAS_PERMS_BY_NAME(d.name, 'DATABASE', '${permission}') = 1 THEN 1 ELSE 0 END) AS any_${permission
        .toLowerCase()
        .replaceAll(' ', '_')}`,
  ).join(',\n');
  return `SELECT
  COUNT_BIG(1) AS database_count,
${columns}
FROM sys.databases d
WHERE HAS_DBACCESS(d.name) = 1`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = args.run ? path.resolve(args.run) : createRunDir();
  fs.mkdirSync(runDir, { recursive: true });

  const report = createReport();
  let connection;
  let redact = makeRedactor([]);

  try {
    const raw = readRawConfig();
    connection = resolveConnection(CONNECTION_NAME);
    redact = makeRedactor([connection.password]);
    const facts = configFacts(raw, connection);

    // 1. Configuration identity — the connection this skill drives must be the expected one.
    // The config may hold other connections; only the selected one is driven, and the live checks
    // below still require EXPECTED_LOGIN. A second connection is not a reason to fail, but it is
    // recorded so the run states which one it used.
    report.check(
      'config.connection-selected',
      facts.connectionName === CONNECTION_NAME && facts.connectionNames.includes(CONNECTION_NAME),
      { expected: CONNECTION_NAME, selected: facts.connectionName, available: facts.connectionNames },
    );
    report.check('config.expected-login-set', Boolean(EXPECTED_LOGIN), {
      detail: 'set SQL_MCP_VERIFY_LOGIN in .env or the environment',
    });
    report.check('config.expected-server-set', Boolean(EXPECTED_SERVER), {
      detail: 'set SQL_MCP_VERIFY_SERVER in .env or the environment',
    });
    report.note('config.connections-present', { names: facts.connectionNames });
    report.check('config.login', facts.configuredLogin === EXPECTED_LOGIN, {
      expected: EXPECTED_LOGIN,
      actual: facts.configuredLogin,
    });
    report.check('config.database', facts.configuredDatabase === EXPECTED_DATABASE, {
      expected: EXPECTED_DATABASE,
      actual: facts.configuredDatabase,
    });
    report.check('config.read-only-flag', facts.readOnlyFlag === true, {
      expected: true,
      actual: facts.readOnlyFlag,
    });
    report.check('config.secrets-not-in-argv', facts.secretsFromEnv === true, {
      detail: 'credentials must come from username_env/password_env, never the config or argv',
      actual: facts.secretsFromEnv,
    });
    report.note('config.hashes', {
      configSha256: facts.configSha256,
      harnessConfigSha256: facts.harnessConfigSha256,
    });

    // 2. Live identity + permission matrix from the one allowed database.
    const live = await withDirectConnection(async ({ pool }) => {
      const identity = await directQuery(pool, permissionQuery());
      const crossDb = await directQuery(pool, crossDatabaseQuery());
      const tableColumns = await directQuery(pool, TABLE_COLUMNS_SQL);
      const objectPerms = await directQuery(
        pool,
        `SELECT
  HAS_PERMS_BY_NAME('dbo._DIM_BranchGroup', 'OBJECT', 'SELECT') AS object_select,
  HAS_PERMS_BY_NAME('dbo._DIM_BranchGroup', 'OBJECT', 'INSERT') AS object_insert,
  HAS_PERMS_BY_NAME('dbo._DIM_BranchGroup', 'OBJECT', 'UPDATE') AS object_update,
  HAS_PERMS_BY_NAME('dbo._DIM_BranchGroup', 'OBJECT', 'DELETE') AS object_delete,
  HAS_PERMS_BY_NAME('dbo._DIM_BranchGroup', 'OBJECT', 'ALTER') AS object_alter,
  HAS_PERMS_BY_NAME('dbo._DIM_BranchGroup', 'OBJECT', 'CONTROL') AS object_control`,
      );
      const fingerprint = await directQuery(pool, FINGERPRINT_SQL);
      const openTransactions = await directQuery(
        pool,
        `SELECT TOP (10) COUNT_BIG(1) AS sessions_with_open_transaction
FROM sys.dm_exec_sessions s
WHERE s.login_name = SUSER_SNAME() AND s.open_transaction_count > 0`,
      );
      return { identity, crossDb, tableColumns, objectPerms, fingerprint, openTransactions };
    });

    const identity = Object.fromEntries(
      live.identity.columns.map((column, index) => [column.name, live.identity.rows[0][index]]),
    );
    report.check('live.login', identity.login_name === EXPECTED_LOGIN, {
      expected: EXPECTED_LOGIN,
      actual: identity.login_name,
    });
    report.check('live.original-login', identity.original_login === EXPECTED_LOGIN, {
      expected: EXPECTED_LOGIN,
      actual: identity.original_login,
    });
    report.check('live.database', identity.database_name === EXPECTED_DATABASE, {
      expected: EXPECTED_DATABASE,
      actual: identity.database_name,
    });
    report.check('live.server', identity.server_property_name === EXPECTED_SERVER, {
      expected: EXPECTED_SERVER,
      actual: identity.server_property_name,
    });
    report.note('live.product', { version: identity.product_version });

    // 3. The read-only proof proper. SELECT must be granted; every write bit must be denied.
    report.check('perms.select-granted', identity.can_select === 1, {
      expected: 1,
      actual: identity.can_select,
    });
    for (const permission of WRITE_PERMISSIONS) {
      const key = `can_${permission.toLowerCase().replaceAll(' ', '_')}`;
      report.check(`perms.${key}-denied`, identity[key] === 0, {
        expected: 0,
        actual: identity[key],
      });
    }
    for (const permission of SERVER_WRITE_PERMISSIONS) {
      const key = `can_${permission.toLowerCase().replaceAll(' ', '_')}`;
      report.check(`perms.${key}-denied`, identity[key] === 0, {
        expected: 0,
        actual: identity[key],
      });
    }
    report.check('perms.sysadmin-denied', identity.is_sysadmin === 0, {
      expected: 0,
      actual: identity.is_sysadmin,
    });
    report.check('perms.dbcreator-denied', identity.is_dbcreator === 0, {
      expected: 0,
      actual: identity.is_dbcreator,
    });
    report.check('perms.db-owner-denied', identity.is_db_owner === 0, {
      expected: 0,
      actual: identity.is_db_owner,
    });
    report.check('perms.db-datawriter-denied', identity.is_datawriter === 0, {
      expected: 0,
      actual: identity.is_datawriter,
    });
    report.check('perms.db-ddladmin-denied', identity.is_ddladmin === 0, {
      expected: 0,
      actual: identity.is_ddladmin,
    });

    // 4. Object-level permission on the exact table the read journey uses.
    const objectPerms = Object.fromEntries(
      live.objectPerms.columns.map((column, index) => [column.name, live.objectPerms.rows[0][index]]),
    );
    report.check('object.select-granted', objectPerms.object_select === 1, objectPerms);
    for (const key of [
      'object_insert',
      'object_update',
      'object_delete',
      'object_alter',
      'object_control',
    ]) {
      report.check(`object.${key}-denied`, objectPerms[key] === 0, {
        expected: 0,
        actual: objectPerms[key],
      });
    }

    // 5. No other database grants a write bit. Judged from Uranus; no second database is opened.
    const crossDb = Object.fromEntries(
      live.crossDb.columns.map((column, index) => [column.name, live.crossDb.rows[0][index]]),
    );
    for (const permission of WRITE_PERMISSIONS) {
      const key = `any_${permission.toLowerCase().replaceAll(' ', '_')}`;
      report.check(`cross-database.${key}-denied`, crossDb[key] === 0, {
        expected: 0,
        actual: crossDb[key],
      });
    }
    report.note('cross-database.databases-with-access', {
      count: Number(crossDb.database_count),
    });

    // 6. No write transaction is open on production before the drive.
    const openTransactions = live.openTransactions.rows[0][0];
    report.check('production.no-open-write-transaction', Number(openTransactions) === 0, {
      expected: 0,
      actual: Number(openTransactions),
    });

    const proof = {
      generatedAt: new Date().toISOString(),
      runDir,
      readOnly: report.failed.length === 0,
      verdict: report.verdict,
      expected: {
        login: EXPECTED_LOGIN,
        database: EXPECTED_DATABASE,
        server: EXPECTED_SERVER,
      },
      facts,
      identity,
      objectPerms,
      crossDatabase: crossDb,
      readJourney: {
        table: 'dbo._DIM_BranchGroup',
        columns: live.tableColumns.rows.map((row) => ({
          column_id: row[0],
          name: row[1],
          type: row[2],
          nullable: Boolean(row[3]),
          primary_key: Boolean(row[4]),
        })),
        fingerprint: {
          row_count: Number(live.fingerprint.rows[0][0]),
          row_fingerprint: Number(live.fingerprint.rows[0][1]),
        },
      },
      checks: report.checks,
    };

    writeJson(runDir, 'proof.json', proof);
    printChecks(report);
    process.stdout.write(`\nverdict: ${proof.verdict}\nreadOnly: ${proof.readOnly}\nrun: ${runDir}\n`);

    if (!proof.readOnly) {
      process.stdout.write(
        '\nBLOCKED: the login holds at least one write permission. Do not drive. Report blocked.\n',
      );
      process.exitCode = 2;
    }
  } catch (error) {
    report.check('doctor.error', false, redact(error.message));
    const proof = {
      generatedAt: new Date().toISOString(),
      runDir,
      readOnly: false,
      verdict: 'fail',
      error: redact(error.message),
      checks: report.checks,
    };
    writeJson(runDir, 'proof.json', proof);
    printChecks(report);
    process.stdout.write(`\nverdict: fail\nreadOnly: false\nrun: ${runDir}\n`);
    process.exitCode = 2;
  }
}

await main();
