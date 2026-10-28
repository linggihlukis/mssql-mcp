# Read a query result

A user runs a read query through the MCP `execute_sql` tool and gets back a bounded result whose
columns and rows match what the database actually holds. This is the primary surface: it is how an
agent inspects production data.

## Sub-features

- `read-basic` returns the rows of a bounded `SELECT` with explicit columns.
- `read-shape` returns column metadata — name, data type, nullability — in declaration order.
- `read-values` returns values in the same order as the declared columns, one array per row.
- `read-bounded` honours `row_limit` and reports `truncated` rather than returning everything.
- `read-cross-session` returns identical results from a second, independent MCP session.
- `read-database-scoped` reads only from the configured database unless a database is named.

## How to get to it (user POV)

- Call the `execute_sql` tool from any MCP client: `{ connection, database, row_limit, sql }`.
- In Zed, that is the `mssql-mcp` context server's `execute_sql` tool.
- In this harness, it is the `mssql` MCP server's `execute_sql` tool.

## Driving it with the MCP client

Preconditions:

- `doctor.mjs` reported `readOnly: true` for the current `config.json` hash.
- The SSH tunnel to the production host is up and `127.0.0.1:1433` accepts a TCP connection.
- `dbo._DIM_BranchGroup` exists in `Uranus` with columns `Id` (int, not null, PK), `Name`
  (varchar(256), null), `IsEnable` (tinyint, null).

- **Read the table.** Call `execute_sql` with
  `SELECT TOP (5) Id, Name, IsEnable FROM dbo._DIM_BranchGroup ORDER BY Id`. Run
  `node .agents/skills/verify-mssql-mcp/scripts/drive.mjs --run <dir>`. The response frame has
  `isError` absent or `false`, and one text content block containing JSON.
- **Check the shape.** The JSON must carry `columns`, `row_count`, `rows`, `truncated`. `columns`
  must be three entries in order, named `Id`, `Name`, `IsEnable`, with data types `int`, `varchar`,
  `tinyint`.
- **Check the values.** `rows` must be two arrays of three values, matching the direct read:
  `[[1,"BBM1",1],[2,"BBM2",1]]` on the current data.
- **Check the bounds.** `row_count` equals the number of returned rows, and `truncated` is a boolean.
  A `row_limit` above the connection's `max_row_limit` is clamped, never exceeded.
- **Prove it independently.** Repeat the same call in a second MCP session (a separate process) and
  over a direct `mssql` connection. All three must agree on rows, column names, and column types.
  `drive.mjs` does exactly this and records the comparison in `drive.json`.
- **Proof.** Keep `drive.json` (`read.*` checks), `frames-A-raw.jsonl` (the request and response
  frames), and the direct read recorded under `readDirect`.

## Gotchas

- `mssql` returns `result.columns` as an array of per-recordset arrays when `arrayRowMode` is on;
  `result.columns[0]` is the column array. Code that treats `result.columns` as the column array
  silently collapses to one unnamed column. That defect shipped once and was fixed in
  `normalizeResult`; keep the assertion, because it is the only thing that catches a regression.
- The metadata container differs by mode: object mode keys columns by name, while `arrayRowMode`
  gives an array of per-recordset arrays. The type is read from `type.declaration` on each
  descriptor; `createColumns` sets it in both modes.
- The production login can read `Athena`, `Gaia`, `Plutus`, `Selene`, `master`, `msdb`, `tempdb`
  and `Uranus`. Reading the wrong one is a scope violation even though it succeeds; assert the
  database.
- `list_databases` enumerates every database on the server, including ones the login cannot open.
  Enumeration is not access.
- Database scope cannot be checked through `sys.dm_exec_sessions`: the login has
  `VIEW SERVER STATE = 0` and sees only its own session. Assert scope from the request frames
  (`safety.single-database` in `drive.json`), not from a DMV.
- The tunnel drops occasionally. `ETIMEOUT` on connect is an environment failure; retry once and
  record it, do not treat it as a product failure.
- `read-shape` and `read-values` failed once, reproducibly, returning one column named `column_1`
  with rows `[[1],[2]]`. That was `normalizeResult` reading `result.columns` as a flat array while
  `arrayRowMode` makes it an array of arrays. Fixed on 2026-10-23; the drive is green. If these
  checks fail again, the same flattening regressed — do not weaken the assertion.
