# mssql-mcp

A local stdio MCP server for Microsoft SQL Server and MySQL. It gives an MCP client read access to
a database: browse connections, databases, tables, and columns, run bounded queries, and keep saved
queries and tabs in a local workspace.

The name predates the second dialect. Both are supported through the same twelve tools, and one
`config.json` can hold connections of either kind side by side.

It works with any MCP client that can launch a local process. No HTTP port, no bearer token, no
GUI.

## Requirements

- Node.js 18.19 or newer. The `mssql` and `mysql2` drivers require it.
- Network access to a SQL Server or MySQL instance, and a login for it.

## Why stdio

The client launches the server as a child process and talks JSON-RPC over stdin and stdout:

```text
MCP client -> stdio -> mssql-mcp -> TCP -> SQL Server or MySQL
```

Nothing listens on a port. This avoids DB Atelier's local HTTP port, bearer token, startup
ordering, and `localhost` IPv4/IPv6 behaviour.

## Install

```bash
git clone <repository-url> mssql-mcp
cd mssql-mcp
npm ci
```

## Configure

Copy the example files, then edit them:

```powershell
Copy-Item config.example.json config.json
Copy-Item .env.example .env
```

`config.json` lists the connections. Each entry needs a host, a database, and credentials:

```json
{
  "connections": [
    {
      "name": "sqlserver",
      "db_type": "mssql",
      "host": "127.0.0.1",
      "port": 1433,
      "database": "YourDatabase",
      "username_env": "MSSQL_MCP_USERNAME",
      "password_env": "MSSQL_MCP_PASSWORD",
      "read_only": true,
      "max_row_limit": 500,
      "query_timeout_ms": 60000,
      "connection_timeout_ms": 10000,
      "options": {
        "encrypt": false,
        "trustServerCertificate": true,
        "enableArithAbort": true
      }
    }
  ]
}
```

Set the credentials in `.env` beside `config.json`. The variable names must match `username_env` and
`password_env`:

```dotenv
MSSQL_MCP_USERNAME=your-sql-login
MSSQL_MCP_PASSWORD=your-real-password
```

| Field | Default | Purpose |
| --- | --- | --- |
| `name` | required | Name the tools use to select this connection. |
| `db_type` | `mssql` | `mssql` or `mysql`. Anything else is rejected at startup. |
| `host`, `port` | required, `1433` for mssql, `3306` for mysql | Server address. |
| `database` | required | Default database for this connection. |
| `username_env`, `password_env` | required | Environment variable names that hold the credentials. |
| `read_only` | `true` | Reject write statements before they reach the server. Must be a literal `true` or `false`; a connection opts into writes with `false`. |
| `max_row_limit` | `500` | Upper bound on rows a tool may return. |
| `max_result_bytes` | `262144` | Upper bound on the size of one tool result, in bytes. |
| `query_timeout_ms` | `60000` | Per-request timeout. |
| `connection_timeout_ms` | `10000` | Connect timeout. |
| `options` | per dialect | Driver options, filtered by dialect. |

Keep the password out of `config.json`. Name it through `password_env` so the server reads it from
the environment or from `.env`, never from a file you might commit.

### MySQL

The same shape, with `db_type: "mysql"`:

```json
{
  "name": "mysql",
  "db_type": "mysql",
  "host": "127.0.0.1",
  "port": 3306,
  "database": "eosys",
  "username": "eosys",
  "password": "",
  "read_only": true,
  "options": { "charset": "utf8mb4" }
}
```

Three things differ from SQL Server:

- **A schema is a database.** MySQL has no second namespace level, so `schema` and `database` name
  the same thing on every tool. A call that names both uses the database, and a call that names
  only a schema reads that schema as the database.
- **An empty password is accepted.** Laragon ships accounts without one, so `password: ""` and
  `MYSQL_PASSWORD=` both load. A password variable that is not set at all is still
  `CONFIG_SECRET_MISSING`, so a typo in the variable name cannot silently become "no password".
- **`options` belong to a dialect.** `charset`, `timezone`, and `ssl` are MySQL's. `encrypt`,
  `trustServerCertificate`, and `enableArithAbort` are SQL Server's. A key from the other dialect
  is rejected at startup instead of being passed to a driver that would ignore it.

`multipleStatements` is always `false` and is not configurable: a second statement is what the
read-only guard exists to stop, so it is also refused by the driver.

`query_timeout_ms` maps to mysql2's `timeout`, which is an inactivity timeout rather than SQL
Server's per-request deadline. A query that keeps the connection busy past the limit is still
bounded, but it is measured differently on the two dialects.

### Dialect support

| | SQL Server (`mssql`) | MySQL (`mysql`) |
| --- | --- | --- |
| Catalog source | `sys.objects`, `sys.columns` | `information_schema` |
| Identifier quoting | `[name]` | `` `name` `` |
| Preview | `SELECT TOP (n) *` | `SELECT * ... LIMIT n` |
| Read-only enforcement | guard, plus the login's permissions | guard, plus `multipleStatements: false` |
| Big integers | driver's `bigint` mapping | exact strings above 2^53 (`supportBigNumbers`) |

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MSSQL_MCP_CONFIG` | `./config.json` | Path to the configuration file. |
| `MSSQL_MCP_DATA_DIR` | `./data` | Where saved queries, folders, and tabs persist. |
| `MSSQL_MCP_DOTENV` | `.env` beside `config.json` | Path to the dotenv file. |

Defaults resolve against the process working directory, so set `MSSQL_MCP_CONFIG` to an absolute
path when the client does not launch the server from the repository root.

Explicit process environment variables win over `.env`. The server loads `.env` from beside
`config.json` unless you set `MSSQL_MCP_DOTENV`.

### Use a least-privilege login

Give the MCP a dedicated SQL login that holds only what the tools need. A login with `SELECT` and
no write permission is the safest configuration, because it makes a write attempt fail at the
server even if the read-only guard has a bug. Do not use `sa`.

`config.json` and `.env` are ignored by Git. Do not commit them.

## Connect your client

The server writes only JSON-RPC to stdout. Diagnostics go to stderr. Point every client at the same
`src/index.js`, and set `MSSQL_MCP_CONFIG` to an absolute path.

### Claude Desktop and Claude Code

Claude Desktop reads `claude_desktop_config.json`. On Windows that is
`%APPDATA%\Claude\claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "mssql": {
      "command": "node",
      "args": ["C:/path/to/mssql-mcp/src/index.js"],
      "env": {
        "MSSQL_MCP_CONFIG": "C:/path/to/mssql-mcp/config.json",
        "MSSQL_MCP_DATA_DIR": "C:/path/to/mssql-mcp/data"
      }
    }
  }
}
```

Claude Code reads a project `.mcp.json` with the same `mcpServers` shape. Add `"type": "stdio"` to
the entry, or use the CLI:

```bash
claude mcp add mssql --env MSSQL_MCP_CONFIG=/path/to/config.json -- node /path/to/src/index.js
```

### VS Code

VS Code reads `.vscode/mcp.json` with a `servers` key, and requires `"type": "stdio"`:

```json
{
  "servers": {
    "mssql": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/mssql-mcp/src/index.js"],
      "env": {
        "MSSQL_MCP_CONFIG": "C:/path/to/mssql-mcp/config.json",
        "MSSQL_MCP_DATA_DIR": "C:/path/to/mssql-mcp/data"
      }
    }
  }
}
```

VS Code also reads a portable `.mcp.json` at the workspace root, which uses `mcpServers` and needs
no `type`.

### Cursor

Cursor reads `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project, using the
`mcpServers` shape shown for Claude Desktop.

### Zed

Zed reads `context_servers` in its settings file. Add the entry under that existing key:

```json
{
  "context_servers": {
    "mssql": {
      "command": "node",
      "args": ["C:/path/to/mssql-mcp/src/index.js"],
      "env": {
        "MSSQL_MCP_CONFIG": "C:/path/to/mssql-mcp/config.json",
        "MSSQL_MCP_DATA_DIR": "C:/path/to/mssql-mcp/data"
      }
    }
  }
}
```

### Codex

Codex reads `~/.codex/config.toml`, or `.codex/config.toml` in a trusted project:

```toml
[mcp_servers.mssql]
command = "node"
args = ["C:/path/to/mssql-mcp/src/index.js"]
env = { MSSQL_MCP_CONFIG = "C:/path/to/mssql-mcp/config.json", MSSQL_MCP_DATA_DIR = "C:/path/to/mssql-mcp/data" }
```

Or add it from the shell:

```bash
codex mcp add mssql --env MSSQL_MCP_CONFIG=/path/to/config.json -- node /path/to/src/index.js
```

### After you change the configuration

Restart the MCP server in your client. The server starts lazily and does not connect to SQL Server
until the first database tool runs, so a server that starts cleanly has not yet proven the
credentials work. Call `list_connections` to check.

You do not need to copy `.env` into the client's `env` block. The server process reads it itself.

## Tools

The server provides 12 tools:

| Tool | Purpose |
| --- | --- |
| `list_connections` | List configured connections with their databases. |
| `list_databases` | List every database on a connection. |
| `list_tables` | List tables and views in a schema. |
| `describe_table` | Column names, types, nullability, keys, and defaults. |
| `execute_sql` | Run a SQL query and return bounded rows. |
| `search_columns` | Find columns by name substring across a schema. |
| `get_schema_summary` | Every table in a schema with its column count. |
| `get_erd` | Tables, columns, and foreign-key relationships. |
| `open_table` | Bounded preview of a table or view. |
| `manage_saved_queries` | Create, list, get, update, or delete saved queries. |
| `manage_query_folders` | Create, rename, delete, or list folders. |
| `manage_query_tab` | Create, open, update, or close editor tabs. |

`open_table` returns a bounded preview of up to 100 rows. A stdio server cannot open a DB Atelier
GUI window, so the tool returns the data instead.

The three `manage_*` tools write local workspace state under `MSSQL_MCP_DATA_DIR`. They never write
to the database, except that `manage_query_tab` with `execute: true` runs the tab's SQL through the
same guard as `execute_sql`.

### Read-only connections

`read_only` defaults to `true`. A connection that omits the key, or copies an example without it,
cannot write. A connection opts into writes by setting `read_only: false` explicitly. The value must
be a real boolean, so a string like `"false"` fails at startup with `CONFIG_INVALID` instead of
silently picking a mode.

When a connection is read-only, the server rejects a statement before it reaches the server unless
it is a single read statement. Writes, DDL, `EXEC`, and multi-statement payloads fail with a
read-only error, and the rejection happens before a connection is opened.

The guard is a small lexer, not a regex, and each dialect supplies its own lexical rules. That
matters where a read can still write or lock. On MySQL the server refuses `INTO OUTFILE` and
`INTO DUMPFILE` (a file write), `INTO @var`, `FOR UPDATE` and `LOCK IN SHARE MODE` (row locks), a
write hidden inside an executable comment such as `/*!50000 ... */` (MySQL runs those), and
`EXPLAIN ANALYZE UPDATE` (which executes the update it describes). On SQL Server it refuses `INTO`
and `OPENROWSET`. Both refuse a statement whose only comment-free reading is a write, and both
refuse more than one statement per call.

A guard is a safety net, not the only one. The stronger configuration is a login that cannot write
at all, which is what the SQL Server connection in this repository uses.

`execute_sql` also clamps `row_limit` to the connection's `max_row_limit`. A query that returns more
rows than the limit reports `truncated: true`.

### Result size

Every tool result is bounded by `max_result_bytes`, default 262144 bytes. The cap measures the JSON
text the client receives, indentation included, because that is what crosses the wire.

A result that would exceed the cap keeps the longest prefix of its record list that fits, and adds
`truncated: true` and `total_count` so a caller can tell a partial answer from a complete one.
`get_erd` drops any relationship whose source table was cut, so the graph never refers to a table the
caller did not receive. A result that fits is returned unchanged, with no extra fields.

Set `max_result_bytes` higher if you routinely read wide text columns and the truncation gets in the
way. The cap exists because a multi-megabyte result stalls an agent's context, not because the
database cannot return it. With the default, `get_erd` on a 178-table schema returns 133 tables and
reports itself truncated rather than sending 539646 bytes.

## Develop

```bash
npm ci
npm test
npm run lint
```

`npm test` runs the Node test runner over `test/`. It needs no database: every database call is a
fake or an in-memory driver. One test spawns the real server as a subprocess and checks the stdio
handshake, so it needs permission to start child processes.

`npm run lint` syntax-checks every file under `src/`. It exits non-zero on the first file that fails
to parse.

Two scripts prove the result cap and the catalog query cost without needing a database:

```bash
node scripts/check-result-caps.mjs   # every tool stays within max_result_bytes
node scripts/bench-list-tables.mjs   # list_tables cost, needs a reachable SQL Server
```

The suite needs permission to start child processes, because one test spawns the real server and
another runs `node --test` per file. A sandbox that blocks `spawn` fails the suite with `EPERM`
before any assertion runs.

### Verify against a real database

The test suite proves behaviour without a database. To prove the server works against a real
instance, drive it with an MCP client. This repository ships a verification skill for that:

```powershell
node .agents/skills/verify-mssql-mcp/scripts/doctor.mjs
node .agents/skills/verify-mssql-mcp/scripts/drive.mjs --run <run dir from doctor>
node .agents/skills/verify-mssql-mcp/scripts/cleanup.mjs --run <run dir>
```

Doctor proves the login is read-only before anything is driven, and the drive records every JSON-RPC
frame, a read result checked against a second independent session, and a write attempt refused by
both the guard and the server. See `.agents/skills/verify-mssql-mcp/SKILL.md`.

MySQL has its own pair, because the safety argument is different: a local MySQL login usually holds
write permission, so the guard is what refuses a write and the doctor proves the guard statement by
statement instead of proving the login is powerless.

```powershell
node .agents/skills/verify-mssql-mcp/scripts/mysql-doctor.mjs
node .agents/skills/verify-mssql-mcp/scripts/mysql-drive.mjs --run <run dir from doctor>
```

The skill targets one specific production instance. Change the expected login and database in its
`scripts/lib.mjs` before pointing it at a different server. The skill also assumes a read-only
login, so `doctor.mjs` reports blocked and refuses to drive against a login that holds write
permissions. That refusal is the point, not a bug.

### Live checks are read-only

If you drive the server against a real database by hand, use read-only SQL such as `SELECT 1` and
never run a destructive statement. Do not wrap a write in `BEGIN TRAN ... ROLLBACK` as a safety
net. A write transaction on a production table blocks other users. Rely on permissions instead.

## Design record

The tool-parity design and its rationale are in
`docs/designs/2026-09-14-mssql-mcp-tool-parity.md`.
