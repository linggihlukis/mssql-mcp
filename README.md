# mssql-mcp

A local stdio MCP server that provides DB Atelier-compatible tools for Microsoft SQL Server. It is intended for Zed and does not provide a GUI.

## Why stdio

Zed launches the server directly and communicates over stdin/stdout:

```text
Zed -> stdio -> mssql-mcp -> TCP -> SQL Server
```

This avoids DB Atelier's local HTTP port, bearer token, startup ordering, and `localhost` IPv4/IPv6 behavior.

## Status

The MCP tool-parity implementation is complete for the 12 DB Atelier tool names. It uses stdio, reaches SQL Server over TCP, persists query workspace state locally, and intentionally implements `open_table` as a bounded preview rather than opening a GUI window. See `docs/designs/2026-09-14-mssql-mcp-tool-parity.md` for the design record.

## Tool contract

The target surface has these 12 tool names:

- `list_connections`
- `list_databases`
- `list_tables`
- `describe_table`
- `execute_sql`
- `search_columns`
- `manage_query_tab`
- `manage_saved_queries`
- `manage_query_folders`
- `open_table`
- `get_schema_summary`
- `get_erd`

`open_table` returns a bounded table preview. A stdio server cannot open a DB Atelier GUI window.

## Configuration

Copy the example files locally:

```powershell
Copy-Item config.example.json config.json
Copy-Item .env.example .env
```

Then edit `.env`:

```dotenv
MSSQL_MCP_SQLSERVER_5_USERNAME=mssql_mcp_readonly
MSSQL_MCP_SQLSERVER_5_PASSWORD=your-real-password
```

The server automatically loads `.env` from the same directory as `config.json`. Explicit process environment variables take precedence over `.env`. You can override the dotenv path with `MSSQL_MCP_DOTENV`.

Use a dedicated least-privilege SQL login. Do not use `sa` for normal MCP operation. Both `config.json` and `.env` are ignored by Git; do not commit them.

Set `MSSQL_MCP_CONFIG` to use another configuration file. Set `MSSQL_MCP_DATA_DIR` to choose where saved queries, tabs, and folders are persisted.

## Zed configuration

Add this to Zed's `context_servers` settings. Use an absolute path on Windows. The server writes only JSON-RPC/MCP messages to stdout; diagnostics go to stderr:

```json
"mssql-mcp": {
  "command": "node",
  "args": ["C:/Users/you/path/mssql-mcp/src/index.js"],
  "env": {
    "MSSQL_MCP_CONFIG": "C:/Users/you/path/mssql-mcp/config.json",
    "MSSQL_MCP_DATA_DIR": "C:/Users/you/path/mssql-mcp/data"
  }
}
```

After changing the configuration, restart the MCP context server or restart Zed. The server starts lazily and does not connect to SQL Server until a database tool is called. The `.env` file is read by the child process, so it does not need to be duplicated in Zed's `env` block.

## Development

```bash
npm ci
npm test
npm run lint
```

Live integration checks must use read-only SQL such as `SELECT 1` and must never run destructive statements against a real database. The automated suite does not require database credentials; the live server check reads them from `.env` or from explicit process environment variables.
