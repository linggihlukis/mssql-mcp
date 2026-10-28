import { createMssqlDialect } from './mssql.js';
import { createMysqlDialect } from './mysql.js';

/**
 * Every supported `db_type`. Adding a dialect means adding one entry here; nothing in `src/tools/`
 * names a dialect.
 */
export const DIALECTS = Object.freeze({
  mssql: createMssqlDialect(),
  mysql: createMysqlDialect(),
});
