---
name: verify-sql-mcp
description: Verify the sql-mcp stdio MCP server by driving it with a real MCP client against the configured production SQL Server connection as its read-only login. Use when proving MCP tool behavior, checking a change did not break the read path, or confirming write attempts are refused. Never drives the app through a higher-privilege login.
---

# Verify sql-mcp

`sql-mcp` is a stdio MCP server, not a web app. There is no browser, no port, and no GUI. A user
surface here is an MCP client session: a process that speaks newline-delimited JSON-RPC over stdin
and stdout, which the server turns into SQL against SQL Server.

Everything below drives the server the way Zed and the harness actually launch it, and proves the
result against a second, independent view of the same database.

## Safety comes first

The skill drives exactly one configured connection, selected by `SQL_MCP_VERIFY_CONNECTION`
(default `prod`). For this project that connection is production, database `Uranus`. `config.json`
may hold other connections — a development connection, for example, that logs in with a
higher-privilege account — and the skill never drives them. The expected host and read-only login
come from `SQL_MCP_VERIFY_SERVER` and `SQL_MCP_VERIFY_LOGIN` in `.env`, not from this file.
There is no disposable database on the production server (`dbcreator = 0`,
`CREATE ANY DATABASE = 0`), so a test database cannot be created, and none is planned for.

Rules that the helpers enforce rather than merely describe:

- **Every run is read-only against production.** The login has `SELECT = 1` and `INSERT`, `UPDATE`,
  `DELETE`, `ALTER`, `CREATE TABLE`, `CONTROL` all `= 0` in `Uranus`, on `dbo._DIM_BranchGroup`,
  and in every other database it can see. `doctor.mjs` re-proves this on every run and fails closed.
- **Never drive through a higher-privilege login.** `lib.mjs` refuses to open a connection as
  anything other than the login in `SQL_MCP_VERIFY_LOGIN`, and `doctor.mjs` refuses to proceed if
  the selected connection names another login or database. This is why a development connection
  that logs in with a higher-privilege account is not a valid target even when production is
  unreachable.
- **Never edit the MCP config or the connection string to make a test pass.** `doctor.mjs` records
  the SHA-256 of `config.json` in `proof.json`; `drive.mjs` re-hashes it and refuses to drive if it
  changed. A test that only passes after editing configuration is a failed test.
- **No `BEGIN TRAN ... ROLLBACK` as a safety net.** Holding a write transaction on production
  blocks real users. Safety comes from permissions the login does not have.
- **Never DROP, DELETE, TRUNCATE, or create anything on the server** — not in the drive, not in
  cleanup. Local workspace deletes are allowed, and only inside the run's scratch
  `SQL_MCP_DATA_DIR`.
- **Every query is bounded:** `TOP`, explicit column names, no `SELECT *`, and a request timeout.
- **One instance, drives serialized.** One production login means no parallel drives.

## Launch

The server is a short-lived child process per session; "launch" means starting one and getting it to
a usable state. It does not connect to SQL Server until the first database tool is called.

```powershell
# from the repo root
node src/index.js
```

The helpers launch it correctly, so you rarely type that. Two environment variables matter, and
neither is a secret:

- `SQL_MCP_CONFIG` — absolute path to `config.json` (defaults to `./config.json`).
- `SQL_MCP_DATA_DIR` — where saved queries and tabs persist. The helpers point this at the run's
  scratch directory so a drive never touches your real workspace.

Credentials are read by the child from `.env` next to `config.json` (`username_env` / `password_env`).
The password is never placed on a command line, in argv, or in `config.json`.

**Ready** means the process answered `initialize` and `tools/list`. A process that merely started is
not ready; the server connects lazily, so readiness cannot be inferred from a listening socket.

**Teardown:** the server exits when its stdin closes, so a client that disconnects does not leave it
running. Before that fix it waited out the mssql pool idle timeout, 30 s per session. The drive
asserts this with `lifecycle.stdin-eof-exits`. `cleanup.mjs` still signals any process that outlives
its stdin, so a regression cannot strand one.

## Doctor

Prove read-only before any drive. This is the check that makes a negative test safe.

```powershell
node .agents/skills/verify-sql-mcp/scripts/doctor.mjs
```

Exit `0` and `readOnly: true` mean the instance is worth driving. Exit `2` means **blocked**: report
it and do not drive. The doctor writes `proof.json` into a fresh run directory and prints that path.

It asserts, in one run:

| Check | Requirement |
| --- | --- |
| `live.login`, `live.original-login` | exactly `SQL_MCP_VERIFY_LOGIN` |
| `live.database` | exactly `Uranus` |
| `live.server` | `SQL_MCP_VERIFY_SERVER` |
| `perms.select-granted` | `HAS_PERMS_BY_NAME(...,'DATABASE','SELECT') = 1` |
| `perms.can_insert-denied` … `perms.can_control-denied` | `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `CREATE TABLE`, `CONTROL` all `= 0` |
| `perms.can_create_any_database-denied`, `perms.can_control_server-denied` | `= 0` |
| `perms.sysadmin/dbcreator/db-owner/datawriter/ddladmin-denied` | all `= 0` |
| `object.*` | the same matrix on `dbo._DIM_BranchGroup` specifically |
| `cross-database.any_*-denied` | no other database grants a write bit (judged from `Uranus`; no second database is opened) |
| `production.no-open-write-transaction` | no session of this login holds an open transaction |
| `config.*` | selected connection exists, expected login/server present in the environment, expected login/database, `read_only: true`, secrets from env, every configured connection name recorded, config hashes recorded |

**If any write bit is granted, stop and report blocked.** Do not drive. The doctor exits `2` and
writes `readOnly: false`; `drive.mjs` refuses to run without a `readOnly: true` proof.

## Drive

```powershell
node .agents/skills/verify-sql-mcp/scripts/drive.mjs --run <run dir printed by doctor>
```

`drive.mjs` runs one serialized drive and writes `drive.json` next to the proof. What it proves:

1. **One MCP client session** — `initialize` then `tools/list`, as raw newline-delimited JSON-RPC.
   Every frame, both directions, is recorded to `frames-A-raw.jsonl`. All 12 tools are expected.
2. **One read tool, proven twice.** `execute_sql` reads `dbo._DIM_BranchGroup`. The same read is
   then repeated by a **second independent session** — a different process driven through the
   official MCP SDK client, not hand-written frames — and by a **direct DB connection** with no MCP
   in the path. Rows, column names, column types, and row count must all agree.
3. **A write tool is refused, proven twice.** `execute_sql` is the direct route; `manage_query_tab`
   with `execute: true` is the second, also guarded route. There is no dedicated write tool. The
   refusal is shown as:
   - the MCP guard rejecting the call (`isError: true`, message naming the statement), and
   - SQL Server denying the same statement over a direct connection, independently of the guard,
     with error `229`.
4. **Nothing mutated.** A row count plus `CHECKSUM_AGG(BINARY_CHECKSUM(...))` fingerprint is taken
   before and after and must match.
5. **One database only.** Every `tools/call` frame the drive recorded is audited: each must name
   `prod` and either omit `database` or name `Uranus`. The audit asserts it covered **both**
   sessions, so an undercount cannot pass silently.
6. **Every discovery tool.** `list_connections`, `list_databases`, `list_tables`, `describe_table`,
   `search_columns`, `get_schema_summary`, and `get_erd` are called in session A and checked against
   the direct read. `list_connections` opens a `master` pool for every configured connection, so it
   is the one call that also reaches `dev`.
7. **`open_table`.** A valid preview (bounded, identity echoed, note present, rows equal to the
   direct read), a missing table (`Invalid object name`), and an unsafe name (rejected before SQL).
8. **The local workspace.** Folder/query/tab create, list, get, update, rename, close, delete;
   `execute: true` runs through the same guard; a rejected execute still persists the tab; and a
   second process reads the saved query back, proving persistence across a restart.

### Why the database-scope check is structural, not a DMV query

The verification login has `VIEW SERVER STATE = 0`, so `sys.dm_exec_sessions` returns exactly one
row — the session running the query. `host_process_id` does not match the MCP child pid either. A
"sessions outside Uranus" DMV query therefore returns `0` regardless of what the MCP did: a check
that can never fail. Do not reintroduce one. Scope is proven from the recorded request frames
instead, which is direct evidence of what the drive asked for.

### The negative tests stay safe even if the guard is broken

Each write probe is a statement that is a write by construction and that the verification login
**cannot execute**, and that touches zero rows even if it somehow ran:

```sql
INSERT INTO dbo._DIM_BranchGroup (Name, IsEnable) SELECT TOP (0) 'verify-probe', 1
UPDATE dbo._DIM_BranchGroup SET Name = Name WHERE 1 = 0
```

If the read-only guard were removed or broken, these still fail with `229 The INSERT/UPDATE
permission was denied`. A broken guard yields a permission error, never a mutation. This is why the
read-only proof is a precondition: the negative test is only safe because of it.

## MySQL

The server speaks two dialects. `mysql-doctor.mjs` and `mysql-drive.mjs` are the MySQL counterparts
of the two commands above, and they share the session machinery, reporting and evidence handling in
`lib.mjs`.

```powershell
node .agents/skills/verify-sql-mcp/scripts/mysql-doctor.mjs
node .agents/skills/verify-sql-mcp/scripts/mysql-drive.mjs --run <run dir printed by doctor>
```

They drive the connection named `mysql` in `config.json` — the local Laragon server on
`127.0.0.1:3306`, schema `eosys`, table `departments`. Override the connection with
`SQL_MCP_VERIFY_MYSQL_CONNECTION`. The read target is fixed in `mysql-lib.mjs` rather than
discovered, so a run cannot silently drift to another table.

**The MySQL login is not read-only, and this is the one place the two dialects differ in kind.**
`eosys` holds `ALL PRIVILEGES` on its own schemas (recorded as `direct.grants` in the doctor). A
MySQL doctor therefore cannot prove safety the way the SQL Server one does, by showing the login is
powerless. The read-only guard is the enforcement point, so the doctor proves it directly:

| Check | Requirement |
| --- | --- |
| `config.connection` | `db_type: mysql`, `read_only: true` |
| `guard.<probe>` | each of 15 write forms is refused with `READ_ONLY_VIOLATION` |
| `guard.probes-never-reach-the-driver` | a counting dialect records zero statements from any probe |
| `guard.a-read-does-reach-the-driver` | the same counter sees exactly one statement for a real read |
| `driver.multiple-statements-refused` | a raw mysql2 pool rejects `SELECT 1; SELECT 2` |
| `direct.*` | version, current schema, the read, column metadata, fingerprint, object count |

The probes are the forms MySQL accepts that a naive guard misses. Each was confirmed against this
server before it was written down: `SELECT ... INTO OUTFILE` and `INTO DUMPFILE` (this server sets
`secure-file-priv=""`, so OUTFILE writes a file), `SELECT ... INTO @var`, `FOR UPDATE`,
`LOCK IN SHARE MODE`, `WITH ... UPDATE`, `WITH ... DELETE`, `EXPLAIN ANALYZE UPDATE`, and a write
hidden inside an executable comment (`/*!50000 ... */`, which MySQL runs). Multi-statement is
covered twice, by the guard and by `multipleStatements: false`.

`mysql-drive.mjs` proves the same shape as the SQL Server drive — two independent sessions, a direct
connection as the witness, every refusal named, and a fingerprint that must not move — plus three
things specific to MySQL:

- **Schema equals database.** Every recorded call must name the `mysql` connection and either omit
  `schema`/`database` or name `eosys`; the audit treats both keys as the same scope escape.
- **Column metadata against `information_schema`.** Types, nullability and `COLUMN_KEY = 'PRI'` are
  compared to what the catalog says, not to what the tool said last time. This is where a string
  leaking through as a boolean would surface, since `Boolean('NO')` is `true`.
- **Both dialects in one server.** `list_connections` must report the mssql and mysql entries side
  by side, which is the only check that the dialect seam holds for a mixed config.

The `eosys` schema declares no foreign keys, so `get_erd` returning `total_relationships: 0` is
recorded as `INFO`, not asserted. A non-zero count there would be a fabricated edge.

## Evidence

Evidence goes outside the repository, because JSON-RPC frames contain production rows. The root is
the first writable candidate of `%LOCALAPPDATA%\sql-mcp-verify\` and
`%TEMP%\sql-mcp-verify\`; the chosen path is printed by every helper. Override with
`SQL_MCP_VERIFY_EVIDENCE` to pin one directory. Never write evidence under the repo, and never
commit it.

**Always pass `--run <dir>` explicitly**, using the path doctor printed. Do not rely on
"newest run" discovery: `%TEMP%` differs between a sandboxed agent process
(`...\Temp\dsh-<id>\`) and an escalated one (`...\Temp\`), so an escalated `drive.mjs` cannot see a
run a sandboxed `doctor.mjs` created. That is not a bug in the run, only in the default lookup, and
the explicit path avoids it entirely.

One run directory holds:

| Artifact | Contents |
| --- | --- |
| `proof.json` | doctor verdict, identity, full permission matrix, config hashes, catalog + fingerprint baseline |
| `frames-A-raw.jsonl`, `frames-B-sdk.jsonl` | every JSON-RPC frame, both directions, with timestamps |
| `drive.json` | parsed tool results, `isError`, comparisons, write refusals, shutdown, every check |
| `stderr-A-raw.log`, `stderr-B-sdk.log` | server diagnostics (stdout stays protocol-only) |
| `workspace-before-cleanup.json` | the scratch workspace store, copied before cleanup removes it |
| `cleanup.json` | which pids were stopped, which scratch state was removed, what evidence was kept |

**Proof standards.** Exercise the real user path — a real MCP client over stdio, not an in-process
call and not a unit test. Capture the action and the resulting state: the request frame, the response
frame with `isError`, and a separate read of the database. A value returned by one session is not
proof; it is proof when a second session and a direct connection agree. Never weaken a journey to
make it pass, and never report a skipped check as verified.

The password is redacted in every artifact (`makeRedactor` strips the live secret and any
`password=`-shaped text). Verify with a search before sharing a run directory.

## Cleanup

```powershell
node .agents/skills/verify-sql-mcp/scripts/cleanup.mjs --run <run dir>
```

Cleanup stops only the MCP processes this run started — pids recorded in its own frames, checked
with a signal-0 liveness probe and a start-time comparison so a recycled pid is never signalled — and
removes only the run's own scratch state (`mcp-data`, the throwaway MCP workspace copy). Nothing is
killed by process name. If a pid is still alive and its start time cannot be read, cleanup reports
`unverified` and exits non-zero rather than claiming a teardown it cannot prove.
**There is no test data to remove:** this skill never writes to the server.

Cleanup never deletes evidence. `cleanup.json` lists the artifacts it kept. Run cleanup after every
failed iteration too, so a broken attempt does not strand a process.

## A stand-in for the write path does not exist on this machine

The write path cannot be exercised as a *success* here: production denies writes, and no disposable
database exists. A local stand-in was attempted and is **not reachable**:

- Docker Desktop is installed and its engine answers (`29.8.1`), but the VM has ~940 MB of memory
  (`~/.wslconfig` sets `memory=1073741824`).
- `mcr.microsoft.com/mssql/server:2022-latest` refuses to start: *"requires a machine with at least
  2000 megabytes of memory"*.
- `mcr.microsoft.com/azure-sql-edge:latest` starts and then dies: `Failed allocate pages:
  FAIL_PAGE_ALLOCATION`, `Available Physical Memory 63.05 mb`.
- No LocalDB is installed (`sqllocaldb` is absent; no `SqlLocalDB.exe` or `sqlservr.exe` on disk).

**Therefore this skill is read-only-only against production.** The write path is verified as
*refused*, which is the behaviour production must have. If a stand-in becomes reachable later, cover
the write path there and mark it clearly as a stand-in, listing every setup step it performed that
production will not — do not weaken the production journey to accommodate it.

If a future run has no write tool at all, record the write path as `verified-unreachable` with the
route attempted (`execute_sql`) and the reason. Do not stub it.

## Helpers

All helpers live in `scripts/` and are run with `node` from the repo root. They import `mssql` and
the MCP SDK from the repo's `node_modules`, so no install step is needed.

| Command | Purpose |
| --- | --- |
| `node .agents/skills/verify-sql-mcp/scripts/doctor.mjs` | Prove read-only; writes `proof.json`; exit `2` = blocked |
| `node .agents/skills/verify-sql-mcp/scripts/drive.mjs --run <dir>` | One serialized drive; writes `drive.json` |
| `node .agents/skills/verify-sql-mcp/scripts/cleanup.mjs --run <dir>` | Stop this run's processes, remove scratch, keep evidence |
| `node .agents/skills/verify-sql-mcp/scripts/mysql-doctor.mjs` | Prove the MySQL guard and capture the baseline; writes `mysql-doctor.json`; exit `2` = blocked |
| `node .agents/skills/verify-sql-mcp/scripts/mysql-drive.mjs --run <dir>` | One serialized MySQL drive; writes `mysql-drive.json` |

Set `SQL_MCP_VERIFY_LOGIN` and `SQL_MCP_VERIFY_SERVER` in `.env` (or the environment) to the
read-only login and production host the doctor must see. They are not committed; with either unset,
the helpers refuse to connect and the doctor exits `2`.

Set `SQL_MCP_VERIFY_CONNECTION` to drive a different configured connection. The doctor still
requires that connection to resolve to the login in `SQL_MCP_VERIFY_LOGIN` on the host in
`SQL_MCP_VERIFY_SERVER`; a higher-privilege login fails closed.

`scripts/lib.mjs` holds the shared contract: expected login/database, the bounded read statement,
the write probes, the evidence roots, the redactor, and the two session implementations
(`RawSession` for hand-written frames, `sdkSession` for the independent SDK client).

`scripts/mysql-lib.mjs` holds the MySQL half: the read target, the fifteen write probes, a direct
connection that accepts Laragon's empty password, and the fingerprint and catalog queries. It
re-exports the session and reporting helpers from `lib.mjs` so a MySQL helper imports one file.

Set `SQL_MCP_VERIFY_MYSQL_CONNECTION` to drive a different configured MySQL connection, and
`SQL_MCP_VERIFY_MYSQL_LOGIN` to make the MySQL helpers refuse any other login. The second is
optional because the local server has one account; leaving it unset means the configured login is
used and reported, not checked.

## Defects this skill has reported

A verification skill that reports a real defect is working. Keep its assertions strict when one
fails, and fix the server rather than the check.

**Fixed, 2026-10-23.** `execute_sql` returned only the first column of a multi-column result, named
`column_1` with type `unknown`, and returned one value per row instead of one row of values. The
cause was in `src/database.js`: under `request.arrayRowMode = true`, `mssql` exposes column metadata
as an array of per-recordset arrays (`result.columns[0]` is the column array), and `normalizeResult`
treated `result.columns` as the column array itself, so it read `columns[0].name`, got `undefined`,
and fell back to `column_1`. Rows were then built by mapping over that single entry. The fix
flattens one level in `columnDescriptors`, and `test/database.test.js` now asserts the shape `mssql`
actually returns rather than a flat array it never returns. The drive is green as of that fix.

**Reported, 2026-10-28 (product gap, not fixed here).** `open_table` builds its preview flag as
`result.truncated || marker.truncated`. When the preview is complete both sides are falsy, so the
expression is `undefined` and `truncated` disappears from the JSON; `execute_sql` always reports a
boolean. The drive pins the shape the client actually receives and records
`open.preview-truncated-flag` as an INFO note. The fix is product work: use `Boolean(...)` in
`src/tools/workspace-tools.js`.

If a check here fails again, treat it as a new finding: reproduce with `drive.mjs`, trace the
mechanism with real driver output, fix the cause, and re-run the drive. Do not relax the assertion.

## Feature map

Start at [`features/README.md`](features/README.md). Drive one mapped feature per run unless the
change under test spans more; the map exists so later runs can cover the rest.
