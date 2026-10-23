import assert from 'node:assert/strict';
import test from 'node:test';
import { listResult, toolResult } from '../src/tools/tool-result.js';

function bytesOf(result) {
  return Buffer.byteLength(result.content[0].text, 'utf8');
}

test('toolResult — result within the cap — returns the value unchanged', () => {
  const value = [{ name: 'Users', type: 'table' }];
  const result = toolResult(value, { maxBytes: 64 * 1024 });
  assert.deepEqual(JSON.parse(result.content[0].text), value);
  assert.equal(result.content[0].type, 'text');
});

test('toolResult — result over the cap with no record list — fails closed instead of shipping it', () => {
  const value = { rows: Array.from({ length: 2000 }, (_, index) => ({ index, padding: 'x'.repeat(200) })) };
  const result = toolResult(value, { maxBytes: 8 * 1024 });
  assert.ok(bytesOf(result) <= 8 * 1024, `shipped ${bytesOf(result)} bytes`);
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.max_bytes, 8 * 1024);
});

test('listResult — oversized list — keeps the longest prefix that fits and marks it', () => {
  const list = Array.from({ length: 500 }, (_, index) => ({ id: index, name: `table_${index}` }));
  const result = listResult({
    list,
    maxBytes: 4 * 1024,
    build: (kept, marker) => ({ schema: 'dbo', tables: kept, total_tables: list.length, ...marker }),
  });
  const parsed = JSON.parse(result.content[0].text);
  assert.ok(bytesOf(result) <= 4 * 1024, `shipped ${bytesOf(result)} bytes`);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.total_count, 500);
  assert.ok(parsed.tables.length > 0, 'a capped result must still carry data');
  assert.ok(parsed.tables.length < 500);
  assert.deepEqual(parsed.tables[0], { id: 0, name: 'table_0' });
});

test('listResult — complete list — adds no marker, so the shape callers rely on does not change', () => {
  const list = [{ id: 1 }];
  const result = listResult({
    list,
    maxBytes: 64 * 1024,
    build: (kept, marker) => ({ tables: kept, ...marker }),
  });
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(parsed, { tables: [{ id: 1 }] });
  assert.equal('truncated' in parsed, false);
  assert.equal('total_count' in parsed, false);
});

test('listResult — a cap too small for any element — keeps the shape and says how many exist', () => {
  const list = Array.from({ length: 100 }, () => ({ padding: 'x'.repeat(500) }));
  const result = listResult({
    list,
    maxBytes: 200,
    build: (kept, marker) => ({ tables: kept, ...marker }),
  });
  const parsed = JSON.parse(result.content[0].text);
  assert.ok(bytesOf(result) <= 200, `shipped ${bytesOf(result)} bytes`);
  // An empty list plus the real count is more useful than a notice: the caller learns the schema has
  // 100 tables and that none of them fit, and the payload keeps the shape it always had.
  assert.deepEqual(parsed.tables, []);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.total_count, 100);
});

test('listResult — a cap too small even for the envelope — reports the reason instead of an unparseable result', () => {
  const list = Array.from({ length: 10 }, () => ({ padding: 'x'.repeat(500) }));
  const result = listResult({
    list,
    maxBytes: 10,
    build: (kept, marker) => ({ tables: kept, ...marker }),
  });
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.truncated, true);
  assert.match(parsed.reason, /max_result_bytes/);
  assert.equal(parsed.max_bytes, 10);
});
