import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src', 'index.js');

function waitForResponse(child, id, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for JSON-RPC response ${id}.`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    }

    function onData(chunk) {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          cleanup();
          reject(new Error(`Non-JSON stdout from stdio server: ${line}`, { cause: error }));
          return;
        }
        if (message.id === id) {
          cleanup();
          resolve(message);
          return;
        }
      }
    }

    function onExit(code, signal) {
      cleanup();
      reject(new Error(`stdio server exited before response ${id}: code=${code}, signal=${signal}`));
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

test('stdio server — real subprocess — returns MCP initialization and all tools without stdout noise', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mssql-mcp-stdio-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    connections: [{
      name: 'test',
      host: '127.0.0.1',
      database: 'master',
      username: 'reader',
      password: 'test-only',
      read_only: true,
    }],
  }));

  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      MSSQL_MCP_CONFIG: configPath,
      MSSQL_MCP_DATA_DIR: path.join(directory, 'data'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    send(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'stdio-test', version: '1.0.0' },
      },
    });
    const initialized = await waitForResponse(child, 1);
    assert.equal(initialized.result.serverInfo.name, 'mssql-mcp');

    send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = await waitForResponse(child, 2);
    const names = tools.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'describe_table',
      'execute_sql',
      'get_erd',
      'get_schema_summary',
      'list_connections',
      'list_databases',
      'list_tables',
      'manage_query_folders',
      'manage_query_tab',
      'manage_saved_queries',
      'open_table',
      'search_columns',
    ]);
  } finally {
    child.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
