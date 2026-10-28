# Persisted query workspace

A user saves queries, organises them into folders, and keeps editor tabs open across restarts. This
is local state stored in a JSON file under `MSSQL_MCP_DATA_DIR` — the workspace itself never touches
SQL Server, though `manage_query_tab` with `execute: true` runs the tab's SQL through the same
read-only guard as `execute_sql`. It is the one part of the surface that legitimately writes, and it
writes only to the local filesystem.

## Sub-features

- `ws-save` — `manage_saved_queries` create/list/get/update/delete.
- `ws-folders` — `manage_query_folders` list/create/rename/delete, recursive on delete.
- `ws-tabs` — `manage_query_tab` create/open/update/close, optionally executing on create/update.
- `ws-scope` — items are scoped to a connection and database pair.
- `ws-persist` — state survives a server restart.
- `ws-atomic` — writes are temp-file-plus-rename, so a crash does not corrupt the store.

## How to get to it (user POV)

- Call `manage_saved_queries`, `manage_query_folders`, or `manage_query_tab` from any MCP client.
- The workspace is per `MSSQL_MCP_DATA_DIR`; the harness uses `data/`, while a verification run uses
  its own scratch directory.

## Driving it with the MCP client

Preconditions:

- `doctor.mjs` reported `readOnly: true`.
- `MSSQL_MCP_DATA_DIR` points at the run's scratch directory, **not** the user's real `data/`. A
  drive that writes to the real workspace destroys saved queries.

- **Create a folder.** Call `manage_query_folders` with
  `{ action: "create", connection: "prod", database: "Uranus", name: "verify" }`. The
  result has `status: "created"` and a `folderId`.
- **Create a saved query.** Call `manage_saved_queries` with
  `{ action: "create", connection, database, title: "verify", content: "SELECT 1", folderId }`.
  The result has `status: "created"` and a `queryId`.
- **List and get.** Call with `{ action: "list", connection, database }` and expect `count` ≥ 1;
  then `{ action: "get", queryId }` and expect the stored content back.
- **Update.** Call with `{ action: "update", queryId, title: "verify-2" }`. The result has
  `status: "updated"` and the new title.
- **Create a tab and execute.** Call `manage_query_tab` with
  `{ action: "create", connection, database, title: "verify-tab", sql: "SELECT TOP (1) DB_NAME() AS db", execute: true }`.
  The tab is created **and** the read runs against SQL Server.
- **Prove persistence.** Stop the MCP process, start a new one with the same `MSSQL_MCP_DATA_DIR`,
  and call `{ action: "get", queryId }`. The query is still there.
- **Proof.** Keep the frames and the scratch `workspace.json` before cleanup removes it.

## Gotchas

- `execute: true` on `manage_query_tab` runs the tab's SQL through the same read-only guard as
  `execute_sql`. A write there is refused identically — do not use it as a bypass probe.
- **A rejected execute still persists the tab.** `createTab` writes the saved query before the guard
  runs, so a `manage_query_tab` call that returns `isError: true` has still added a saved query to
  the store. Measured: after one rejected write tab, `manage_saved_queries list` returns the tab's
  title. Harmless in scratch; a reason never to point a drive at the real `data/`.
- `delete` here deletes *local workspace state*, not database rows. It is allowed, but do it only
  inside the run's scratch directory, never against the user's real `data/`.
- The scope defaults to the connection's configured database when `database` is omitted. Create and
  list filter by the exact connection+database pair, so a different database creates a separate
  scope. `get`, `update`, and `delete` resolve by ID alone and are unscoped, so a different database
  does not hide an item from `get`.
- Deleting a folder cascades to its subfolders and their queries. Fine in scratch; never point this
  at the real workspace.
- The store is a plain JSON file rewritten on every mutation. Concurrent writers lose updates, which
  is another reason drives are serialized.
- `manage_query_tab` create and `manage_saved_queries` create share an ID space — the tab ID is the
  saved-query ID. Do not assume they are independent.
