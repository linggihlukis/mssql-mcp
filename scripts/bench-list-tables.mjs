// Measures what list_tables costs against what it needs, and proves both queries agree.
//
// list_tables joins every column of every object and runs two OUTER APPLY blocks to answer a
// question that only needs object names. This script times the current query against a names-only
// variant, alternating so warmup and drift favour neither, then asserts the two produce identical
// tool output.
//
// Usage: node scripts/bench-list-tables.mjs
// Needs a reachable SQL Server and config.json. Read-only: it runs two SELECTs.

import { loadConfig } from '../src/config.js';
import { DatabaseManager } from '../src/database.js';

const PAIRS = 7;

const CURRENT = `
      SELECT
        s.name AS schema_name, o.name AS object_name, o.type_desc AS object_type, c.name AS column_name,
        ty.name AS data_type, c.max_length, c.is_nullable, dc.definition AS default_definition,
        CAST(CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS bit) AS is_primary_key,
        CAST(CASE WHEN fk.parent_column_id IS NULL THEN 0 ELSE 1 END AS bit) AS is_foreign_key,
        fk.referenced_schema_name, fk.referenced_object_name, fk.referenced_column_name
      FROM sys.objects o
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      LEFT JOIN sys.columns c ON c.object_id = o.object_id
      LEFT JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
      OUTER APPLY (
        SELECT ic.column_id FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        WHERE i.object_id = o.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id
      ) pk
      OUTER APPLY (
        SELECT fkc.parent_column_id, rs.name AS referenced_schema_name, ro.name AS referenced_object_name, rc.name AS referenced_column_name
        FROM sys.foreign_key_columns fkc
        JOIN sys.objects ro ON ro.object_id = fkc.referenced_object_id
        JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
        JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
        WHERE fkc.parent_object_id = o.object_id AND fkc.parent_column_id = c.column_id
      ) fk
      WHERE o.type IN ('U', 'V') AND s.name = 'dbo'
      ORDER BY s.name, o.name, c.column_id`;

const NAMES_ONLY = `
      SELECT s.name AS schema_name, o.name AS object_name, o.type_desc AS object_type
      FROM sys.objects o
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.type IN ('U', 'V') AND s.name = 'dbo'
      ORDER BY s.name, o.name`;

function toToolOutput(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = `${row.schema_name}.${row.object_name}`;
    if (!seen.has(key)) {
      seen.set(key, { name: row.object_name, type: row.object_type === 'VIEW' ? 'view' : 'table' });
    }
  }
  return [...seen.values()];
}

function stats(runs) {
  const values = runs.map((run) => run.ms).sort((a, b) => a - b);
  return {
    median: values[Math.floor(values.length / 2)],
    min: values[0],
    max: values.at(-1),
    rows: runs[0].rows,
    all: runs.map((run) => run.ms),
  };
}

const config = loadConfig();
const connection = config.connections[0];
const database = new DatabaseManager(config);
const pool = await database.getPool(connection.name, connection.database);

async function once(sql) {
  const started = process.hrtime.bigint();
  const result = await pool.request().query(sql);
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, rows: result.recordset.length };
}

// Warm both sides so the first-call compile cost lands outside the timed pairs.
await once(CURRENT);
await once(NAMES_ONLY);

const current = [];
const names = [];
for (let pair = 0; pair < PAIRS; pair += 1) {
  current.push(await once(CURRENT));
  names.push(await once(NAMES_ONLY));
}

const currentRows = (await pool.request().query(CURRENT)).recordset;
const namesRows = (await pool.request().query(NAMES_ONLY)).recordset;
const identical = JSON.stringify(toToolOutput(currentRows)) === JSON.stringify(toToolOutput(namesRows));

const a = stats(current);
const b = stats(names);
const fmt = (value) => value.toFixed(0).padStart(5);

process.stdout.write(`current query   median ${fmt(a.median)} ms  range ${fmt(a.min)} to ${fmt(a.max)}  rows=${a.rows}\n`);
process.stdout.write(`names only      median ${fmt(b.median)} ms  range ${fmt(b.min)} to ${fmt(b.max)}  rows=${b.rows}\n`);
process.stdout.write(`median delta    ${fmt(a.median - b.median)} ms  (${((1 - b.median / a.median) * 100).toFixed(0)}% less)\n`);
process.stdout.write(`identical output: ${identical}\n`);
process.stdout.write(`runs per side   ${PAIRS}, alternating\n`);
process.stdout.write(`\nall current ms: ${a.all.map((ms) => ms.toFixed(0)).join(', ')}\n`);
process.stdout.write(`all names   ms: ${b.all.map((ms) => ms.toFixed(0)).join(', ')}\n`);

await database.close();
process.exitCode = identical ? 0 : 1;
