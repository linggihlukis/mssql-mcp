import { AppError } from '../errors.js';

/**
 * Builds the read-only statement guard for one SQL dialect.
 *
 * The descriptor is the only place a dialect's lexical rules live; the scanner is shared, so a
 * dialect cannot drift into accepting a write that another rejects.
 */
export function createReadOnlyGuard(syntax) {
  const allowedFirstWords = new Set(syntax.allowedFirstWords);
  const depthZeroBanned = new Set(syntax.depthZeroBanned);
  const withBanned = new Set([...syntax.withBanned, ...syntax.depthZeroBanned]);
  const sequences = syntax.bannedSequences ?? [];
  // A statement that opens a write (`EXPLAIN ANALYZE UPDATE`) must be judged on every word, not
  // only the depth-zero ones, because the write sits inside the plan it describes.
  const firstWordBanned = new Map(Object.entries(syntax.firstWordBanned ?? {}));

  return function assertReadOnly(sqlText) {
    const statements = splitStatements(sqlText, syntax);
    if (statements.length === 0) {
      throw new AppError('SQL query must be a non-empty statement.', { code: 'INVALID_QUERY' });
    }
    if (statements.length > 1) {
      throw new AppError('Read-only connections accept a single read statement per call.', {
        code: 'READ_ONLY_VIOLATION',
      });
    }
    const words = tokenizeWords(statements[0], syntax);
    const first = words.find((entry) => entry.depthZero)?.word;
    if (!first) {
      throw new AppError('SQL query must be a non-empty statement.', { code: 'INVALID_QUERY' });
    }
    if (first === 'WITH') {
      const banned = words.find((entry) => withBanned.has(entry.word));
      if (banned) {
        throw new AppError(`Read-only connections reject statements containing "${banned.word}".`, {
          code: 'READ_ONLY_VIOLATION',
        });
      }
      return;
    }
    if (!allowedFirstWords.has(first)) {
      throw new AppError(`Read-only connections reject "${first}" statements.`, {
        code: 'READ_ONLY_VIOLATION',
      });
    }
    const extraBanned = firstWordBanned.get(first);
    if (extraBanned) {
      const banned = words.find((entry) => extraBanned.includes(entry.word));
      if (banned) {
        throw new AppError(`Read-only connections reject statements containing "${banned.word}".`, {
          code: 'READ_ONLY_VIOLATION',
        });
      }
    }
    const banned = words.find((entry) => depthZeroBanned.has(entry.word));
    if (banned) {
      throw new AppError(`Read-only connections reject statements containing "${banned.word}".`, {
        code: 'READ_ONLY_VIOLATION',
      });
    }
    const sequence = findSequence(words, sequences);
    if (sequence) {
      throw new AppError(`Read-only connections reject statements containing "${sequence}".`, {
        code: 'READ_ONLY_VIOLATION',
      });
    }
  };
}

/** The first banned word sequence that appears in order, joined for the error message. */
function findSequence(words, sequences) {
  for (const sequence of sequences) {
    for (let start = 0; start + sequence.length <= words.length; start += 1) {
      if (sequence.every((word, offset) => words[start + offset].word === word)) {
        return sequence.join(' ');
      }
    }
  }
  return null;
}

function stringQuoteAt(syntax, char) {
  return syntax.stringQuotes.find((entry) => entry.quote === char);
}

function identifierAt(text, index, syntax) {
  for (const entry of syntax.identifierQuotes) {
    if (text.startsWith(entry.open, index)) {
      const close = text.indexOf(entry.close, index + entry.open.length);
      return { end: close === -1 ? text.length : close };
    }
  }
  return null;
}

function blockCommentAt(text, index, syntax) {
  const { open, close } = syntax.blockComment;
  if (!text.startsWith(open, index)) return null;
  // An executable comment runs its body on the server, so treating it as a comment would hide a
  // write from the scanner.
  if (syntax.executableComment && text.startsWith(syntax.executableComment, index)) return null;
  const end = text.indexOf(close, index + open.length);
  return { end: end === -1 ? text.length : end + close.length };
}

function lineCommentAt(text, index, syntax) {
  return syntax.lineComments.some((prefix) => {
    if (!text.startsWith(prefix, index)) return false;
    if (!syntax.lineCommentNeedsSpace?.includes(prefix)) return true;
    const next = text[index + prefix.length];
    return next === undefined || /\s/.test(next);
  });
}

/**
 * Splits raw SQL into statements at depth-zero semicolons, dropping comments on the way.
 *
 * Comments are removed before the split so a semicolon inside one cannot look like a statement
 * boundary; a semicolon inside a string literal cannot either, because the literal is copied whole.
 */
function splitStatements(text, syntax) {
  const statements = [];
  let current = '';
  let quote = null;
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (quote) {
      current += char;
      if (quote.backslash && char === '\\' && i + 1 < text.length) {
        current += text[i + 1];
        i += 2;
        continue;
      }
      if (char === quote.quote) {
        if (quote.doubled && text[i + 1] === quote.quote) {
          current += quote.quote;
          i += 2;
          continue;
        }
        quote = null;
      }
      i += 1;
      continue;
    }
    const stringQuote = stringQuoteAt(syntax, char);
    if (stringQuote) {
      quote = stringQuote;
      current += char;
      i += 1;
      continue;
    }
    if (lineCommentAt(text, i, syntax)) {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    const block = blockCommentAt(text, i, syntax);
    if (block) {
      i = block.end;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ';' && depth === 0) {
      statements.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += char;
    i += 1;
  }
  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

/**
 * Words in one statement, each tagged with whether it appeared outside every parenthesis.
 *
 * Quoted identifiers and string literals are skipped rather than tokenized: a table named `Delete`
 * must not read as the `DELETE` keyword.
 */
function tokenizeWords(statement, syntax) {
  const words = [];
  let current = '';
  let quote = null;
  let depth = 0;
  const flush = () => {
    if (current) {
      words.push({ word: current.toUpperCase(), depthZero: true });
      current = '';
    }
  };
  for (let i = 0; i < statement.length; i += 1) {
    const char = statement[i];
    if (quote) {
      if (quote.backslash && char === '\\') {
        i += 1;
        continue;
      }
      if (char === quote.quote) quote = null;
      continue;
    }
    const stringQuote = stringQuoteAt(syntax, char);
    if (stringQuote) {
      quote = stringQuote;
      continue;
    }
    const identifier = identifierAt(statement, i, syntax);
    if (identifier) {
      i = identifier.end;
      continue;
    }
    if (char === '(') {
      flush();
      depth += 1;
      continue;
    }
    if (char === ')') {
      flush();
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && syntax.wordChars.test(char) && (current || syntax.wordStart.test(char))) {
      current += char;
      continue;
    }
    if (syntax.wordStart.test(char)) {
      flush();
      let nested = '';
      let j = i;
      while (j < statement.length && syntax.wordChars.test(statement[j])) {
        nested += statement[j];
        j += 1;
      }
      words.push({ word: nested.toUpperCase(), depthZero: false });
      i = j - 1;
      continue;
    }
    flush();
  }
  flush();
  return words;
}
