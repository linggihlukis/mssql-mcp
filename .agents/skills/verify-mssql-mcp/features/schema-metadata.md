# Inspect schema metadata

A user explores what is in the database — which connections exist, which databases are visible,
which tables and views a schema has, what columns a table has, where a column name appears, and how
tables relate. These are the read-only discovery tools an agent uses before writing a query.

## Sub-features

- `meta-connections` — `list_connections` returns each configured connection with its databases.
- `meta-databases` — `list_databases` returns every database on the server and the current one.
- `meta-tables` — `list_tables` returns tables and views in a schema.
- `meta-describe` — `describe_table` returns columns with name, type, nullability, primary key, and
  `default` when one exists. It does **not** emit a foreign-key field.
- `meta-search` — `search_columns` finds columns by name substring across a schema.
- `meta-summary` — `get_schema_summary` returns each table with its column count.
- `meta-erd` — `get_erd` returns tables, columns, and foreign-key relationships.

## How to get to it (user POV)

- Call the corresponding tool from any MCP client.
- Every tool except `list_connections` takes `connection`. `list_databases` takes only
  `connection`; the other six also accept `database` and `schema`, and `schema` defaults to `dbo`.

## Driving it with the MCP client

Preconditions:

- `doctor.mjs` reported `readOnly: true`.
- `dbo._DIM_BranchGroup` exists in `Uranus`; the `dbo` schema has 178 tables and views.

- **List connections.** Call `list_connections` with no arguments. The result is an array with one
  entry per configured connection — today `prod` and `dev` — each with `db_type` `mssql`, its
  configured database, and an `available_databases` list. The tool opens a `master` pool for every
  configured connection, not only the selected one, so it is also the one call that reaches `dev`.
  Record the connection names and run it as its own serialized step.
- **List databases.** Call `list_databases` with `{ connection: "prod" }`. The result has
  `current: "Uranus"` and a `databases` array containing `Uranus`.
- **List tables.** Call `list_tables` with `{ connection, schema: "dbo" }`. The result contains an
  entry named `_DIM_BranchGroup` with `type: "table"`.
- **Describe the table.** Call `describe_table` with
  `{ connection, schema: "dbo", table: "_DIM_BranchGroup" }`. The result has three columns in order:
  `Id` (`int`, not nullable, `primary_key: true`), `Name` (`varchar`, nullable),
  `IsEnable` (`tinyint`, nullable). No `is_foreign_key` field is emitted; `default` appears only when
  the column has one.
- **Search columns.** Call `search_columns` with `{ connection, schema: "dbo", pattern: "SubGolongan" }`.
  The result's `count` equals `matches.length` (1 on the current schema) and every match names a
  column, table, and type. `BranchGroup` matches no *column* name and returns `count: 0`.
- **Summarise the schema.** Call `get_schema_summary` with `{ connection, schema: "dbo" }`. The
  result's `total_tables` equals `tables.length` and each table has a `column_count`. When the byte
  cap drops entries, `total_tables` is the full count, `tables` is the kept prefix, and `truncated`
  is `true`.
- **Read the ERD.** Call `get_erd` with `{ connection, schema: "dbo", tables: ["_DIM_BranchGroup"] }`.
  The result's `tables` has one entry and `total_relationships` equals `relationships.length`, unless
  the result was truncated (same marker rule as above).
- **Proof.** Keep the response frames in `frames-*.jsonl` and the parsed results in `drive.json`.

## Gotchas

- `list_connections` and `list_databases` both open a pool against `master` to read `sys.databases`.
  The pool is cached with a 30 s idle timeout, so a `master` session can remain for about 30 seconds;
  `list_connections` opens one per configured connection (two today). Record it, and do not run these
  concurrently with a scoped read.
- `list_databases` enumerates databases the login cannot open. That is enumeration, not access — do
  not then read from one.
- `search_columns` and `describe_table` take a *substring* and an exact name respectively. Passing a
  wildcard pattern to `describe_table` returns "not found".
- The catalog query joins `sys.objects` where `type IN ('U','V')`, so it returns views as well as
  tables. `list_tables` labels them with `type`, whose values are `table` or `view` (not
  `object_type`).
- Metadata tools accept a `database` argument. Passing another database is a scope violation even
  though the login may succeed; keep to `Uranus`.
- Every metadata tool runs its list through `listResult` and caps the serialized result at
  `max_result_bytes` (default 262144). A capped result carries `total_count` and `truncated` and a
  shortened list, so an equality check between the reported total and the returned array holds only
  when `truncated` is absent. The server truncates; do not re-run to shrink the artifact.
- The `schema` description in the tool input schema still says `public/default`; the handler
  defaults to `dbo`. Trust the handler, and note the inconsistency if a client surfaces the
  description.
