import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

function temporaryConfig(config) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mssql-mcp-config-'));
  const filePath = path.join(directory, 'config.json');
  fs.writeFileSync(filePath, JSON.stringify(config));
  return { directory, filePath };
}

test('loadConfig — environment password — loads a normalized MSSQL connection', () => {
  const { directory, filePath } = temporaryConfig({
    connections: [
      {
        name: 'local',
        host: '127.0.0.1',
        database: 'master',
        username_env: 'TEST_MSSQL_USERNAME',
        password_env: 'TEST_MSSQL_PASSWORD',
        read_only: true,
      },
    ],
  });

  const config = loadConfig({
    env: {
      MSSQL_MCP_CONFIG: filePath,
      TEST_MSSQL_USERNAME: 'reader',
      TEST_MSSQL_PASSWORD: 'secret-not-logged',
    },
  });

  assert.equal(config.configPath, path.resolve(filePath));
  assert.equal(config.connections[0].username, 'reader');
  assert.equal(config.connections[0].password, 'secret-not-logged');
  assert.equal(config.connections[0].read_only, true);
  assert.equal(config.connections[0].port, 1433);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('loadConfig — local .env — loads credentials beside config.json', () => {
  const { directory, filePath } = temporaryConfig({
    connections: [{
      name: 'local',
      host: '127.0.0.1',
      database: 'master',
      username_env: 'LOCAL_TEST_USERNAME',
      password_env: 'LOCAL_TEST_PASSWORD',
    }],
  });
  fs.writeFileSync(path.join(directory, '.env'), 'LOCAL_TEST_USERNAME=reader\nLOCAL_TEST_PASSWORD="dotenv-secret"\n');
  const config = loadConfig({ env: { MSSQL_MCP_CONFIG: filePath } });
  assert.equal(config.connections[0].username, 'reader');
  assert.equal(config.connections[0].password, 'dotenv-secret');
  assert.equal(config.dotenvPath, path.join(directory, '.env'));
  fs.rmSync(directory, { recursive: true, force: true });
});

test('loadConfig — explicit environment — overrides local .env credentials', () => {
  const { directory, filePath } = temporaryConfig({
    connections: [{
      name: 'local',
      host: '127.0.0.1',
      database: 'master',
      username_env: 'LOCAL_TEST_USERNAME',
      password_env: 'LOCAL_TEST_PASSWORD',
    }],
  });
  fs.writeFileSync(path.join(directory, '.env'), 'LOCAL_TEST_USERNAME=dotenv-user\nLOCAL_TEST_PASSWORD=dotenv-password\n');
  const config = loadConfig({
    env: {
      MSSQL_MCP_CONFIG: filePath,
      LOCAL_TEST_USERNAME: 'explicit-user',
      LOCAL_TEST_PASSWORD: 'explicit-password',
    },
  });
  assert.equal(config.connections[0].username, 'explicit-user');
  assert.equal(config.connections[0].password, 'explicit-password');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('loadConfig — missing environment password — fails before database access', () => {
  const { directory, filePath } = temporaryConfig({
    connections: [
      {
        name: 'local',
        host: '127.0.0.1',
        database: 'master',
        username: 'reader',
        password_env: 'MISSING_TEST_MSSQL_PASSWORD',
      },
    ],
  });

  assert.throws(
    () => loadConfig({ env: { MSSQL_MCP_CONFIG: filePath } }),
    /needs a password through password_env/,
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test('loadConfig — duplicate connection names — rejects ambiguous configuration', () => {
  const { directory, filePath } = temporaryConfig({
    connections: [
      {
        name: 'duplicate',
        host: '127.0.0.1',
        database: 'master',
        username: 'reader',
        password: 'one',
      },
      {
        name: 'duplicate',
        host: '127.0.0.1',
        database: 'master',
        username: 'reader',
        password: 'two',
      },
    ],
  });

  assert.throws(
    () => loadConfig({ env: { MSSQL_MCP_CONFIG: filePath } }),
    /Duplicate connection name/,
  );
  fs.rmSync(directory, { recursive: true, force: true });
});
