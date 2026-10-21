# MSSQL MCP Tool Parity Implementation Plan

> Implement task-by-task with checkpoint verification between each.

**Goal:** Replace DB Atelier's MCP tool surface with a local stdio server that reaches SQL Server and preserves compatible tool names, schemas, result shapes, and query-workspace persistence.

**Architecture:** A thin stdio JSON-RPC/MCP entry point dispatches validated tool calls to an in-process connection manager and workspace store. The connection manager owns configured SQL Server pools and metadata/query operations; the workspace store owns saved queries, tabs, and folders in a local JSON/SQLite-compatible file. `open_table` returns a preview rather than controlling a GUI.

**Tech Stack:** Node.js LTS, official MCP TypeScript SDK if dependency review confirms it is available/appropriate, `mssql` SQL Server driver, built-in filesystem/path utilities, and the repository's available test runner.

**Time Estimate:** 1–2 days for the complete MCP tool surface plus focused parity tests; additional time only if driver installation or SQL Server behavior requires environment-specific work.

---

### Task 1: Establish the Node project and dependency boundary

**Context:** The target directory is empty. The server needs a reproducible entry point, locked dependencies, and tests without touching the Laravel app.

**Files:**
- Create: `mssql-mcp/package.json`
- Create: `mssql-mcp/package-lock.json`
- Create: `mssql-mcp/.gitignore`
- Create: `mssql-mcp/README.md`

**Step 1: Inspect available runtimes and package managers**

Run:

```bash
node --version
npm --version
```

Expected: Node.js and npm are available.

**Step 2: Select dependencies**

Use the official MCP SDK and the maintained `mssql` driver. Do not add a framework or GUI dependency. Record the reason for each runtime dependency in `README.md`.

**Step 3: Add scripts**

Provide `start`, `test`, and `lint`/syntax-check scripts appropriate to the selected language/toolchain. Do not add a script that can run destructive SQL against the configured real server.

**Step 4: Install and lock dependencies**

Run:

```bash
npm install
```

Expected: a lockfile is created and dependency installation completes.

**Checkpoint:** A clean install can start the project and the test command exists.

---

### Task 2: Define validated configuration and connection management

**Context:** DB Atelier supports named connections and the target needs LAN SQL Server access without copying DB Atelier's encrypted password format or exposing secrets.

**Files:**
- Create: `mssql-mcp/src/config.js` (or `.ts`)
- Create: `mssql-mcp/src/database.js` (or `.ts`)
- Create: `mssql-mcp/src/errors.js` (or `.ts`)
- Create: `mssql-mcp/config.example.json`
- Create: `mssql-mcp/test/config.test.js` (or `.test.ts`)
- Create: `mssql-mcp/test/database.test.js` (or `.test.ts`)

**Step 1: Write failing configuration tests**

Cover missing connection name, invalid port, missing host, and environment-variable password loading. Run the focused test command and verify failure before implementation.

**Step 2: Implement configuration loading**

Support a configuration path via `MSSQL_MCP_CONFIG`, defaulting to a server-local config file. Allow per-connection password values from environment variables or a credential-provider boundary; never log passwords. Fail fast with actionable errors.

**Step 3: Implement the connection manager**

Support named MSSQL connections, connection pooling, explicit database selection, connection timeout, request timeout, and safe pool close. Expose methods for database listing, metadata, and query execution. Keep SQL/driver errors wrapped as operational errors suitable for MCP responses.

**Step 4: Add mocked database tests**

Use a small adapter seam so metadata/query logic can be tested without writing to a real database. Test that database names and result rows are normalized to DB Atelier-compatible shapes.

**Checkpoint:** Configuration is validated and the database layer has no hardcoded credentials or test writes.

---

### Task 3: Implement the DB Atelier-compatible database tools

**Context:** These eight tools are the core parity surface and must preserve the observed names and required arguments.

**Files:**
- Create: `mssql-mcp/src/tools/database-tools.js` (or `.ts`)
- Create: `mssql-mcp/src/tools/schemas.js` (or `.ts`)
- Create: `mssql-mcp/test/database-tools.test.js` (or `.test.ts`)

**Step 1: Write failing contract tests**

Assert registration and required input fields for:

- `list_connections`
- `list_databases`
- `list_tables`
- `describe_table`
- `execute_sql`
- `search_columns`
- `get_schema_summary`
- `get_erd`

Test invalid connection, missing required arguments, row-limit bounds, and database/schema defaults.

**Step 2: Implement metadata queries**

Use SQL Server catalog views/DMVs with parameterized identifiers/values where applicable. Quote identifiers safely. Normalize schema, table, view, column, type, nullability, key, default, and foreign-key data to the observed result shapes.

**Step 3: Implement `execute_sql`**

Support read-only and explicitly writable configured connections. Enforce maximum row limits and query timeouts. Return columns, rows, row count, and truncation state in the observed shape. Do not silently swallow SQL errors.

**Step 4: Implement ERD and column search**

Return structured tables/columns/relationships and case-insensitive column matches without loading unbounded data.

**Checkpoint:** The eight database tools have stable schemas and deterministic normalized results.

---

### Task 4: Implement persisted query workspace parity

**Context:** DB Atelier exposes tabs, saved queries, and folders. These are local workspace state, not SQL Server state, and can be reproduced without a GUI.

**Files:**
- Create: `mssql-mcp/src/workspace-store.js` (or `.ts`)
- Create: `mssql-mcp/src/tools/workspace-tools.js` (or `.ts`)
- Create: `mssql-mcp/test/workspace-tools.test.js` (or `.test.ts`)

**Step 1: Write failing persistence tests**

Cover create/list/get/update/delete for saved queries, folder creation/rename/deletion, and tab create/open/update/close. Include connection/database scoping and restart persistence.

**Step 2: Implement atomic local persistence**

Store workspace data under an application data directory or `MSSQL_MCP_DATA_DIR`. Use a temp-file-plus-rename write pattern. Validate IDs and prevent path traversal. Keep folder deletion behavior recursive as documented by DB Atelier.

**Step 3: Implement compatible tools**

Implement:

- `manage_query_tab`
- `manage_saved_queries`
- `manage_query_folders`

Preserve the observed action names and required/optional fields. The tab ID returned by create must be usable as the saved-query ID if parity requires it.

**Step 4: Implement `open_table`**

Return table metadata plus a bounded preview/result payload. Document that it cannot focus a GUI window over stdio.

**Checkpoint:** Workspace tools survive process restart and do not mutate SQL Server unless explicitly requested through execution.

---

### Task 5: Add the stdio MCP entry point

**Context:** Zed should launch the server directly, eliminating DB Atelier's HTTP port, token, startup ordering, and IPv4/IPv6 issues.

**Files:**
- Create: `mssql-mcp/src/index.js` (or `.ts`)
- Create: `mssql-mcp/test/stdio-contract.test.js` (or `.test.ts`)
- Modify: `mssql-mcp/package.json`
- Modify: `mssql-mcp/README.md`

**Step 1: Write a failing stdio contract test**

Launch the process, send newline-delimited JSON-RPC initialize and tools/list messages, and assert valid responses. Assert that stdout contains only protocol messages and diagnostics go to stderr.

**Step 2: Implement MCP server registration**

Register all 12 tool names with compatible JSON schemas. Dispatch to the database/workspace services. Convert operational failures into MCP tool errors without crashing the process.

**Step 3: Implement lifecycle behavior**

Handle SIGINT/SIGTERM by closing pools and exiting cleanly. Keep stdout protocol-only. Avoid server startup connections until a tool requires one unless startup validation is explicitly configured.

**Step 4: Add Zed configuration instructions**

Document a stdio entry similar to:

```json
"mssql-mcp": {
  "command": "node",
  "args": ["C:/path/to/mssql-mcp/src/index.js"],
  "env": {
    "MSSQL_MCP_CONFIG": "C:/path/to/mssql-mcp/config.json"
  }
}
```

Use an absolute path or a stable executable wrapper appropriate to Windows.

**Checkpoint:** Zed can launch the process and discover all 12 tools without an HTTP endpoint.

---

### Task 6: Run safe integration/parity validation

**Context:** The live SQL Server is reachable, but validation must avoid destructive changes and credentials must remain private.

**Files:**
- Create: `mssql-mcp/test/integration-readonly.test.js` (or `.test.ts`, optional when credentials are present)
- Modify: `mssql-mcp/README.md`

**Step 1: Run automated tests**

```bash
npm test
```

Expected: all unit and protocol tests pass.

**Step 2: Run syntax/lint checks**

```bash
npm run lint
```

Expected: no project diagnostics.

**Step 3: Run read-only live checks**

Use only safe statements such as:

```sql
SELECT 1 AS connection_test;
SELECT DB_NAME() AS database_name;
```

Exercise all metadata tools against `sqlserver_5`, plus bounded `open_table` and query-workspace operations. Do not run DDL/DML.

**Step 4: Compare parity**

Compare tool names, required fields, defaults, and representative result shapes against the observed DB Atelier tool contract. Record the intentional `open_table` difference in the README.

**Checkpoint:** The server works in stdio mode, reaches the LAN SQL Server, and has no dependency on DB Atelier's HTTP process.

---

## Verification

### Automated
- [ ] Clean install succeeds: `npm ci`
- [ ] Unit and protocol tests pass: `npm test`
- [ ] Lint/syntax checks pass: `npm run lint`
- [ ] No secrets are present in tracked files.

### Manual
- [ ] Zed launches the stdio server.
- [ ] `tools/list` returns all 12 expected names.
- [ ] `sqlserver_5` can list databases and execute `SELECT 1`.
- [ ] Metadata tools return bounded, normalized results.
- [ ] Saved queries/folders/tabs persist after restart.
- [ ] `open_table` returns a bounded preview and clearly documents its non-GUI behavior.
- [ ] Malformed input and database failures return actionable MCP errors.

### Definition of Done
- [ ] All tasks complete.
- [ ] All checkpoints verified.
- [ ] All tests pass.
- [ ] README documents installation, configuration, security, Zed setup, and known parity differences.
- [ ] No GUI or Laravel application code was added.
