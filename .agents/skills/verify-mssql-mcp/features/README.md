# mssql-mcp verification map

This directory is the maintained source for verifying the user-facing behavior of `mssql-mcp`.
Read this index before driving the server, then use the matching feature file as the recipe.

`mssql-mcp` is a stdio MCP server. Its user surface is an MCP client session, not a browser. There
are 12 tools; the map groups them by what a user is trying to accomplish.

## Baseline preconditions

- Production SQL Server is reachable at `127.0.0.1:1433` — usually through the operator's SSH tunnel
  to the production host. If the tunnel is down, every drive fails with `ETIMEOUT`; that is an
  environment failure, not a product failure.
- `config.json` may name several connections. The verified one is `prod`: host `127.0.0.1`, database
  `Uranus`, `read_only: true`, with credentials supplied through `MSSQL_MCP_SQLSERVER_PROD_USERNAME` /
  `MSSQL_MCP_SQLSERVER_PROD_PASSWORD`. The helpers drive `prod` unless
  `MSSQL_MCP_VERIFY_CONNECTION` names another connection, and the doctor still requires the login in
  `MSSQL_MCP_VERIFY_LOGIN` on the host in `MSSQL_MCP_VERIFY_SERVER`.
- A development connection that logs in with a higher-privilege account is **out of scope**. The
  doctor fails closed on it (`live.login` / `sysadmin-denied`), and no drive may target it.
- `.env` next to `config.json` holds the prod credentials and the expected identity
  (`MSSQL_MCP_VERIFY_LOGIN`, `MSSQL_MCP_VERIFY_SERVER`). They stay out of the repository. Never edit
  either file to make a test pass.
- `node .agents/skills/verify-mssql-mcp/scripts/doctor.mjs` reports `readOnly: true`. Do not drive
  without it. Pass the run directory it prints to `drive.mjs` and `cleanup.mjs` as `--run <dir>`;
  do not rely on "newest run" discovery, which cannot span a sandboxed and an escalated process.
- Drives are serialized. One production login, one drive at a time.

## Driving conventions

- Start every recipe from the baseline state.
- Drive through a real MCP client over stdio. Session A uses hand-written JSON-RPC frames
  (`RawSession`); session B uses the official SDK client in a separate process. Never substitute an
  in-process call for a session.
- Treat every statement as literal. Keep the `TOP`, the column list, and the `WHERE 1 = 0` unchanged.
- Every query stays bounded: `TOP`, explicit columns, no `SELECT *`, request timeout.
- Keep to `Uranus`. Opening another database is a scope violation even for a read.
- Never use `BEGIN TRAN ... ROLLBACK`; never DROP, DELETE, TRUNCATE, or create anything on the
  server. Local workspace deletes are allowed only inside the run's scratch `MSSQL_MCP_DATA_DIR`.

## Proof and skip reporting

- Capture the action and the resulting state: the request frame, the response frame with `isError`,
  and a separate read of the database.
- A value returned by one session is not proof. Proof is a second independent session plus a direct
  connection agreeing on rows, column names, and column types.
- Record the feature ID and the route used with every artifact.
- Report an unreachable path with the route attempted and the reason, marked
  `verified-unreachable`. Never stub it and never weaken the journey to make it pass.
- A check that fails because the product is wrong stays failing. Fix the product or report it.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It
then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with the MCP client` starts with `Preconditions:` and pairs each user action with an
   exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Read a query result](read-query.md) covers `execute_sql` reads: row shape, values, bounds, and
  cross-session agreement.
- [Write refusal](write-refusal.md) covers the read-only guarantee: the MCP guard and SQL Server both
  refusing writes, and the database staying unchanged.
- [Inspect schema metadata](schema-metadata.md) covers `list_connections`, `list_databases`,
  `list_tables`, `describe_table`, `search_columns`, `get_schema_summary`, and `get_erd`.
- [Preview a table](open-table.md) covers `open_table` and its bounded preview contract.
- [Persisted query workspace](query-workspace.md) covers `manage_saved_queries`,
  `manage_query_folders`, and `manage_query_tab`, which write local state; `manage_query_tab` with
  `execute: true` also runs a guarded read.

## Not covered by a stand-in

The write path is only verifiable as *refused*, because production denies writes and no disposable
database exists (`dbcreator = 0`, `CREATE ANY DATABASE = 0`). No local stand-in is reachable on this
machine; see the SKILL.md section "A stand-in for the write path does not exist on this machine".
