# Write refusal

A user (or a misbehaving agent) asks the MCP server to write to production. The server must refuse,
and SQL Server must refuse independently, and the data must be unchanged afterwards. This is the
guarantee that makes it safe to point an agent at production at all.

## Sub-features

- `write-guard` rejects `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `EXEC`, DDL, and multi-statement
  payloads before any connection is opened.
- `write-guard-comments` rejects a write hidden behind SQL comments.
- `write-server-denial` fails with SQL Server error `229` even with the guard bypassed.
- `write-no-mutation` leaves the row count and row fingerprint unchanged.
- `write-no-dedicated-tool` records that no dedicated write tool exists; `execute_sql` is the direct
  route and `manage_query_tab` with `execute: true` is the second, also guarded route.
- `write-no-transaction` never opens a transaction as a safety net.

## How to get to it (user POV)

- Call `execute_sql` with a statement that writes.
- There is no separate write tool in the 12-tool surface. `execute_sql` is the direct route;
  `manage_query_tab` with `execute: true` reaches the same guard.

## Driving it with the MCP client

Preconditions:

- `doctor.mjs` reported `readOnly: true`, including `perms.can_insert-denied`,
  `perms.can_update-denied`, and `perms.can_delete-denied` all `= 0`.
- The target table is `dbo._DIM_BranchGroup` in `Uranus`.

- **Guard rejects INSERT.** Call `execute_sql` with
  `INSERT INTO dbo._DIM_BranchGroup (Name, IsEnable) SELECT TOP (0) 'verify-probe', 1`. Run
  `node .agents/skills/verify-mssql-mcp/scripts/drive.mjs --run <dir>`. The response has
  `isError: true` and the text contains `Read-only connections reject "INSERT" statements.` (the
  full text is prefixed by `Tool execute_sql failed: `).
- **Guard rejects UPDATE.** Call `execute_sql` with
  `UPDATE dbo._DIM_BranchGroup SET Name = Name WHERE 1 = 0`. The response has `isError: true` and
  the text contains `Read-only connections reject "UPDATE" statements.`
- **Server denies it independently.** With no MCP in the path, send the same two statements over a
  direct `mssql` connection. Both must fail with error number `229`
  (`The INSERT/UPDATE permission was denied on the object ...`). This proves the guarantee comes
  from permissions, not from the guard under test.
- **Nothing changed.** Compare the row count and `CHECKSUM_AGG(BINARY_CHECKSUM(Id, Name, IsEnable))`
  before and after. They must be identical.
- **Proof.** Keep `drive.json` (`write.guard-rejects-*`, `write.server-denies-*`,
  `write.server-error-229-*`, `safety.fingerprint-unchanged`) and the corresponding frames in
  `frames-A-raw.jsonl`.

## Gotchas

- **The negative test must stay safe if the guard is broken.** Use statements the login cannot
  execute and that touch zero rows: `SELECT TOP (0)` and `WHERE 1 = 0`. A plain
  `DELETE FROM dbo._DIM_BranchGroup` is *not* acceptable as a probe — it relies on the guard, which
  is the thing under test.
- **Never use `BEGIN TRAN ... ROLLBACK`.** It holds locks on a production table and blocks real
  users. The read-only proof is the safety net.
- `EXEC sp_who` succeeds for this login (`EXECUTE` is granted at server level in some paths). Do not
  use `EXEC` as a denial probe; it will confuse the result.
- `TRUNCATE TABLE` is rejected by the MCP guard before SQL (`Read-only connections reject
  "TRUNCATE" statements.`). Error `1088` ("does not exist or you do not have permissions") is only
  reachable on a direct connection with no MCP in the path; assert the error you actually expect
  per route.
- A write that "did not error" is a production incident, not a test failure. If a probe ever
  succeeds, stop the drive, report it, and check the fingerprint immediately.
- If the server has no write tool at all, mark the write path `verified-unreachable` with the route
  attempted (`execute_sql`) and the reason. Do not stub it.
