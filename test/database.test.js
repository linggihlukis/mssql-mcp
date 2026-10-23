import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseManager, assertReadOnlyQuery, normalizeResult, quoteIdentifier, quoteMultipartIdentifier } from '../src/database.js';

function fakeConfig() {
  return {
    connections: [
      {
        name: 'local',
        db_type: 'mssql',
        host: '127.0.0.1',
        port: 1433,
        database: 'master',
        username: 'reader',
        password: 'secret',
        read_only: true,
        max_row_limit: 2,
        query_timeout_ms: 1000,
        connection_timeout_ms: 1000,
        options: { encrypt: false, trustServerCertificate: true },
      },
    ],
  };
}

test('quoteIdentifier — valid SQL Server identifier — brackets the identifier', () => {
  assert.equal(quoteIdentifier('Order'), '[Order]');
  assert.equal(quoteMultipartIdentifier('dbo.Order'), '[dbo].[Order]');
});

test('quoteIdentifier — invalid identifier — rejects SQL injection syntax', () => {
  assert.throws(() => quoteIdentifier('users; DROP TABLE users'), /Invalid identifier/);
  assert.throws(() => quoteMultipartIdentifier('dbo.users.name.more'), /Invalid identifier/);
});

test('normalizeResult — row limit — returns DB Atelier-compatible result shape', () => {
  const result = normalizeResult(
    {
      columns: {
        id: { type: { name: 'int' } },
        name: { type: { name: 'varchar' } },
      },
      recordset: [
        { id: 1, name: 'one' },
        { id: 2, name: 'two' },
        { id: 3, name: 'three' },
      ],
    },
    2,
    3,
  );

  assert.deepEqual(result.columns.map((column) => column.name), ['id', 'name']);
  assert.deepEqual(result.rows, [[1, 'one'], [2, 'two']]);
  assert.equal(result.row_count, 2);
  assert.equal(result.truncated, true);
});

test('normalizeResult — mssql arrayRowMode metadata — reads the per-recordset column array', () => {
  // Captured from mssql 12.7.2 against SQL Server 2022 with request.arrayRowMode = true:
  // result.columns is an array with one entry per recordset, and each entry is that recordset's
  // column descriptors. result.recordset holds value arrays aligned to columns[0].
  const result = normalizeResult({
    columns: [[
      { index: 0, name: 'Id', nullable: false, type: { declaration: 'int' } },
      { index: 1, name: 'Name', nullable: true, type: { declaration: 'varchar' } },
      { index: 2, name: 'IsEnable', nullable: true, type: { declaration: 'tinyint' } },
    ]],
    recordset: [[1, 'BBM1', 1], [2, 'BBM2', 1]],
  }, 500, 2);
  assert.deepEqual(result.columns, [
    { name: 'Id', data_type: 'int', default_value: null, is_nullable: false, is_primary_key: false, is_foreign_key: false },
    { name: 'Name', data_type: 'varchar', default_value: null, is_nullable: true, is_primary_key: false, is_foreign_key: false },
    { name: 'IsEnable', data_type: 'tinyint', default_value: null, is_nullable: true, is_primary_key: false, is_foreign_key: false },
  ]);
  assert.deepEqual(result.rows, [[1, 'BBM1', 1], [2, 'BBM2', 1]]);
});

test('normalizeResult — empty recordset — keeps the column descriptors', () => {
  const result = normalizeResult({
    columns: [[
      { index: 0, name: 'Id', nullable: false, type: { declaration: 'int' } },
      { index: 1, name: 'Name', nullable: true, type: { declaration: 'varchar' } },
    ]],
    recordset: [],
  }, 500, 0);
  assert.deepEqual(result.columns.map((column) => column.name), ['Id', 'Name']);
  assert.deepEqual(result.rows, []);
  assert.equal(result.row_count, 0);
});

test('assertReadOnlyQuery — SELECT — allows a single read statement', () => {
  assert.doesNotThrow(() => assertReadOnlyQuery('SELECT 1 AS value;'));
  assert.doesNotThrow(() => assertReadOnlyQuery('WITH ranked AS (SELECT 1 AS n) SELECT * FROM ranked;'));
  assert.doesNotThrow(() => assertReadOnlyQuery('-- comment\nSELECT 1; /* trailing */'));
});

test('assertReadOnlyQuery — write statement — rejects with a read-only violation', () => {
  for (const sql of [
    'DROP TABLE dbo.Users;',
    'DELETE FROM dbo.Users;',
    'UPDATE dbo.Users SET Name = 1;',
    'INSERT INTO dbo.Users SELECT 1;',
    'SELECT 1; DROP TABLE dbo.Users;',
  ]) {
    assert.throws(() => assertReadOnlyQuery(sql), /Read-only connections/);
  }
  assert.doesNotThrow(() => assertReadOnlyQuery('SELECT * FROM dbo.Users WHERE Name = \'x; DROP TABLE y\';'));
  assert.throws(() => assertReadOnlyQuery('WITH moved AS (DELETE FROM dbo.Users OUTPUT deleted.Id) SELECT * FROM moved;'), /Read-only connections reject/);
});

test('assertReadOnlyQuery — comment-masked write — rejects after stripping comments', () => {
  assert.throws(() => assertReadOnlyQuery('/* SELECT */ DELETE FROM dbo.Users;'), /Read-only connections reject/);
  assert.throws(() => assertReadOnlyQuery('-- SELECT only\nUPDATE dbo.Users SET Name = 2;'), /Read-only connections reject/);
});

test('DatabaseManager — read-only connection — rejects writes before opening a pool', async () => {
  const calls = [];
  class FakePool {
    constructor(config) {
      this.config = config;
      this.connected = false;
    }

    async connect() {
      calls.push(['connect', this.config.database]);
      this.connected = true;
      return this;
    }

    request() {
      return {
        arrayRowMode: false,
        query: async (sql) => {
          calls.push(['query', sql]);
          return {
            columns: [{ name: 'value', type: { declaration: 'int' }, nullable: false }],
            recordset: [[1]],
          };
        },
      };
    }

    async close() {
      calls.push(['close']);
    }
  }

  const manager = new DatabaseManager(fakeConfig(), {
    driver: { ConnectionPool: FakePool },
  });

  assert.deepEqual(manager.listConnections(), [
    { name: 'local', db_type: 'mssql', database: 'master', read_only: true },
  ]);
  await assert.rejects(() => manager.query('local', 'DROP TABLE dbo.Users;'), /Read-only connections reject/);
  assert.deepEqual(calls, []);
  const result = await manager.query('local', 'SELECT 1', { rowLimit: 1 });
  assert.deepEqual(result.rows, [[1]]);
  assert.deepEqual(calls, [['connect', 'master'], ['query', 'SELECT 1']]);
  await manager.close();
  assert.deepEqual(calls.at(-1), ['close']);
});
