// mysql-doctor.mjs — the preconditions a MySQL drive is allowed to assume.
//
// What this proves, and where:
//   1. the connection is configured as MySQL and read-only ....... config.json, resolved
//   2. the read-only guard refuses every write form MySQL accepts . the guard, in process
//   3. none of those statements reaches the driver ................ a counting dialect, in process
//   4. the driver refuses a second statement ...................... a raw mysql2 pool
//   5. the server answers the same reads as a direct client ....... a direct connection, no MCP
//   6. the state to compare against later is captured ............. fingerprint and object count
//
// What this reports without claiming:
//   * Whether the MySQL login is itself read-only. On this server it is not, and no read-only MySQL
//     login exists. The guard is therefore the enforcement point, which is why checks 2 and 3 are
//     blocking and why every write probe is expected to be refused before the driver.
//
// Usage:
//   node .agents/skills/verify-mssql-mcp/scripts/mysql-doctor.mjs [--run <dir>]

import crypto from 'node:crypto';
import fs from 'node:fs';
import mysql from 'mysql2/promise';
import { DatabaseManager } from '../../../../src/database.js';
import { createMysqlDialect } from '../../../../src/dialects/mysql.js';
import {
  CONFIG_PATH,
  MYSQL_COLUMNS_SQL,
  MYSQL_CONNECTION_NAME,
  MYSQL_FINGERPRINT_SQL,
  MYSQL_OBJECT_COUNT_SQL,
  MYSQL_READ_SCHEMA,
  MYSQL_READ_SQL,
  MYSQL_READ_TABLE,
  MYSQL_WRITE_PROBES,
  createReport,
  createRunDir,
  makeRedactor,
  mysqlDirectQuery,
  mysqlFingerprint,
  parseArgs,
  printChecks,
  resolveMysqlConnection,
  resolveRunDir,
  withMysqlDirect,
  writeJson,
} from './mysql-lib.mjs';

function configHash() {
  return crypto.createHash('sha256').update(fs.readFileSync(CONFIG_PATH)).digest('hex');
}

/**
 * A dialect that counts what reaches the driver, so "the guard refused it" can be separated from
 * "the driver happened to refuse it too".
 */
function countingDialect() {
  const real = createMysqlDialect();
  const state = { statements: [] };
  return {
    state,
    dialect: {
      ...real,
      createPool: () => ({
        query: async (options) => {
          state.statements.push(typeof options === 'string' ? options : options.sql);
          return [[], []];
        },
        end: async () => {},
      }),
      ready: async () => {},
      runQuery: async (_pool, sqlText) => {
        state.statements.push(sqlText);
        return { columns: [], rows: [], totalRows: 0 };
      },
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = args.run ? resolveRunDir(args.run) : createRunDir();
  const connection = resolveMysqlConnection();
  const redact = makeRedactor([connection.password]);
  const report = createReport();

  report.note('config.path', CONFIG_PATH);
  report.note('config.sha256', configHash());
  report.check(
    'config.connection',
    connection.raw.db_type === 'mysql' && connection.read_only === true,
    {
      name: connection.name,
      db_type: connection.raw.db_type,
      host: connection.host,
      port: connection.port,
      database: connection.database,
      read_only: connection.read_only,
    },
  );

  // 2. The guard, statement by statement.
  const dialect = createMysqlDialect();
  for (const probe of MYSQL_WRITE_PROBES) {
    let outcome = 'allowed';
    try {
      dialect.assertReadOnly(probe.sql);
    } catch (error) {
      outcome = error.code ?? 'rejected';
    }
    report.check(`guard.${probe.id}`, outcome === 'READ_ONLY_VIOLATION', { sql: probe.sql, outcome });
  }

  // 3. Nothing above may reach the driver, and a read must, so the counter is meaningful.
  const counting = countingDialect();
  const manager = new DatabaseManager(
    {
      connections: [{
        name: connection.name,
        db_type: 'mysql',
        host: connection.host,
        port: connection.port,
        database: connection.database,
        username: connection.username,
        password: connection.password,
        read_only: true,
        max_row_limit: connection.max_row_limit ?? 500,
        max_result_bytes: 262_144,
        query_timeout_ms: connection.query_timeout_ms ?? 60_000,
        connection_timeout_ms: 10_000,
        options: {},
      }],
    },
    { dialects: { mysql: counting.dialect } },
  );
  const reachedDriver = [];
  for (const probe of MYSQL_WRITE_PROBES) {
    try {
      await manager.query(connection.name, probe.sql);
      reachedDriver.push(probe.id);
    } catch (error) {
      if (error.code !== 'READ_ONLY_VIOLATION') reachedDriver.push(`${probe.id}:${error.code}`);
    }
  }
  report.check('guard.probes-never-reach-the-driver', counting.state.statements.length === 0, {
    statementsReachingDriver: counting.state.statements.length,
    probesThatSlipped: reachedDriver,
  });
  await manager.query(connection.name, 'SELECT 1 AS one');
  report.check('guard.a-read-does-reach-the-driver', counting.state.statements.length === 1, {
    statementsReachingDriver: counting.state.statements.length,
  });
  await manager.close();

  // 4. The driver, independent of the guard.
  const rawPool = mysql.createPool({
    host: connection.host,
    port: connection.port,
    user: connection.username,
    password: connection.password,
    database: connection.database,
    connectTimeout: 10_000,
  });
  let multiStatement = 'accepted';
  try {
    await rawPool.query('SELECT 1; SELECT 2');
  } catch (error) {
    multiStatement = error.code ?? 'rejected';
  } finally {
    await rawPool.end().catch(() => {});
  }
  report.check('driver.multiple-statements-refused', multiStatement !== 'accepted', { outcome: multiStatement });

  // 5 and 6. The independent witness.
  const direct = await withMysqlDirect(async ({ pool }) => {
    const [versionRows] = await pool.query('SELECT VERSION() AS version, DATABASE() AS current_database');
    const [grantRows] = await pool.query('SHOW GRANTS');
    const grants = grantRows.map((row) => Object.values(row)[0]);
    const fingerprint = await mysqlFingerprint(pool);
    const read = await mysqlDirectQuery(pool, MYSQL_READ_SQL);
    const columns = await mysqlDirectQuery(pool, MYSQL_COLUMNS_SQL);
    const [objectRows] = await pool.query({ sql: MYSQL_OBJECT_COUNT_SQL, rowsAsArray: true });
    return {
      version: versionRows[0].version,
      currentDatabase: versionRows[0].current_database,
      grants,
      fingerprint,
      read,
      columns,
      objectCount: Number(objectRows[0][0]),
    };
  });

  report.check('direct.connected', true, {
    version: direct.version,
    current_database: direct.currentDatabase,
  });
  report.check('direct.read-rows', direct.read.row_count > 0, {
    sql: MYSQL_READ_SQL,
    row_count: direct.read.row_count,
    columns: direct.read.columns.map((column) => column.name),
  });
  report.check(
    'direct.read-target-is-the-configured-schema',
    direct.currentDatabase === MYSQL_READ_SCHEMA,
    { expected: MYSQL_READ_SCHEMA, actual: direct.currentDatabase },
  );
  report.note('direct.columns', {
    table: MYSQL_READ_TABLE,
    columns: direct.columns.rows.map((row) => ({
      name: row[0],
      data_type: row[1],
      is_nullable: row[2],
      column_key: row[3],
    })),
  });
  // Recorded, not asserted: the point is that a later drive can prove nothing moved.
  report.note('direct.fingerprint', direct.fingerprint);
  report.note('direct.object-count', { schema: MYSQL_READ_SCHEMA, objects: direct.objectCount });
  report.note('direct.fingerprint-sql', MYSQL_FINGERPRINT_SQL);

  // The login's own powers, stated plainly rather than assumed away.
  const readOnlyLogin = direct.grants.every(
    (grant) => /^GRANT USAGE ON/i.test(grant) || /^GRANT SELECT ON/i.test(grant),
  );
  report.note('direct.grants', { login: connection.username, grants: direct.grants.map(redact) });
  if (readOnlyLogin) {
    report.check('direct.login-is-read-only', true, { login: connection.username });
  } else {
    report.note('direct.login-is-not-read-only', {
      login: connection.username,
      consequence:
        'The server would accept a write from this login. The read-only guard, proven above, is what refuses it, and every probe is expected to be refused before the driver is reached.',
    });
  }

  const doctor = {
    verdict: report.verdict,
    configHash: configHash(),
    connection: {
      name: connection.name,
      db_type: 'mysql',
      host: connection.host,
      port: connection.port,
      database: connection.database,
      username: connection.username,
      read_only: connection.read_only,
    },
    baseline: {
      fingerprint: direct.fingerprint,
      objectCount: direct.objectCount,
      read: { columns: direct.read.columns, rows: direct.read.rows },
    },
    checks: report.checks,
  };
  writeJson(runDir, 'mysql-doctor.json', JSON.parse(redact(JSON.stringify(doctor))));

  printChecks(report);
  process.stdout.write(`\nverdict: ${report.verdict}\nrun: ${runDir}\n`);
  if (report.verdict !== 'pass') process.exitCode = 1;
}

await main();
