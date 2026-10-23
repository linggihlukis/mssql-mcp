function serialize(value) {
  return JSON.stringify(value, null, 2);
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

function textContent(text) {
  return { content: [{ type: 'text', text }] };
}

function tooLargeNotice(maxBytes) {
  return {
    truncated: true,
    reason: 'result exceeds max_result_bytes',
    max_bytes: maxBytes,
    hint: 'Raise max_result_bytes on this connection, or narrow the request with a table filter or a smaller schema.',
  };
}

/**
 * Wraps a value as MCP text content, bounded by `maxBytes`.
 *
 * This does not shrink the value. A result with no named record list that overflows is replaced by a
 * notice, so a tool that forgets to declare its list fails closed instead of shipping megabytes. Use
 * `listResult` for any result whose size grows with the database.
 */
export function toolResult(value, { maxBytes } = {}) {
  const text = serialize(value);
  const capped = Number.isFinite(maxBytes) && maxBytes > 0;
  if (!capped || byteLength(text) <= maxBytes) return textContent(text);
  return textContent(serialize(tooLargeNotice(maxBytes)));
}

/**
 * Wraps a result whose size grows with `list`, keeping the longest prefix that fits `maxBytes`.
 *
 * `build` receives the kept elements and a marker, and returns the exact value to serialize. The
 * caller therefore decides which array is the record list, which matters where a payload also holds
 * a parallel array such as column descriptors: truncating that one instead would leave rows
 * misaligned with their columns.
 */
export function listResult({ list, build, maxBytes }) {
  // The marker is empty unless something was actually dropped, so a complete result keeps exactly
  // the shape callers already depend on and only a partial one grows the extra fields.
  const marker = (keptCount) =>
    (keptCount < list.length ? { total_count: list.length, truncated: true } : {});

  const candidate = (keptCount) => build(list.slice(0, keptCount), marker(keptCount));
  const capped = Number.isFinite(maxBytes) && maxBytes > 0;
  if (!capped) return textContent(serialize(candidate(list.length)));

  const full = serialize(candidate(list.length));
  if (byteLength(full) <= maxBytes) return textContent(full);

  if (byteLength(serialize(candidate(0))) > maxBytes) {
    return textContent(serialize(tooLargeNotice(maxBytes)));
  }

  // Serialized size only grows as elements are added, so the largest fitting prefix is found by
  // binary search rather than by reserializing once per dropped element.
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(serialize(candidate(middle))) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return textContent(serialize(candidate(low)));
}

/**
 * The cap to apply to a result. A tool that reports on every connection takes the strictest cap,
 * because the result covers all of them.
 */
export function maxBytesFor(database, connectionName) {
  if (connectionName) return database.getConnection(connectionName).max_result_bytes;
  const caps = database.listConnections().map((connection) =>
    database.getConnection(connection.name).max_result_bytes,
  );
  return Math.min(...caps);
}
