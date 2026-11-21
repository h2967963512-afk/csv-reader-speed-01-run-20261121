// A fast drop-in for csv-reader 1.0.0: run(input) answers {columns, rows, errors}
// for {text, header} exactly as the reference does, but reads with jumps
// (indexOf / regex scans and whole-field slices) instead of one character
// at a time. The field readers return the field's value alone and leave how
// it ended in `ended`, so no result object is built per field.
//
// The reading policy, as the reference defines it:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it one quote, and each CRLF or lone CR inside it
//     read as LF; what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field ends);
//     a quote that never closes is a literal character, and the text after
//     it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row) or cut
//     (long_row) to the first record's width;
//   - each error is {code, line, row}, in the order met, line the 1-based
//     line its record starts on, row its record's index in rows (null for
//     the header).

// How a field ended.
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// The next comma, CR or LF at or after a position, one scan.
const DELIM = /[,\r\n]/g;
// The next CR or LF at or after a position, one scan.
const NEWLINE = /[\r\n]/g;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). The field readers below close over these.
  let recordLine = 1;
  let recordRow = null;

  // How the last field read ended, and how many characters readUnquoted
  // kept after its `first` argument. The readers set these; the record
  // loop reads them.
  let ended = END;
  let added = 0;

  // The value of text[a..b), with its line count applied: every CR or LF
  // inside it is one LF in the value and one more line. A segment with no
  // line break in it is a plain slice.
  function segmentValue(a, b) {
    NEWLINE.lastIndex = a;
    let m = NEWLINE.exec(text);
    if (m === null || m.index >= b) return text.slice(a, b);
    let lines = 0;
    let hasCR = false;
    do {
      lines += 1;
      if (m[0] === '\r') {
        hasCR = true;
        // A CRLF inside quotes is one line break, not two.
        if (text.charCodeAt(m.index + 1) === 10) NEWLINE.lastIndex = m.index + 2;
      }
    } while ((m = NEWLINE.exec(text)) !== null && m.index < b);
    line += lines;
    const s = text.slice(a, b);
    return hasCR ? s.replace(/\r\n?/g, '\n') : s;
  }

  // Reads unquoted characters onto `first` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field
  // and sets `ended` and `added` (the characters kept after `first`).
  function readUnquoted(first) {
    let parts = first === undefined ? null : [first];
    added = 0;
    let start = pos;
    for (;;) {
      DELIM.lastIndex = pos;
      const dm = DELIM.exec(text);
      if (dm === null) {
        const seg = text.slice(start);
        pos = len;
        ended = END;
        if (parts) {
          parts.push(seg);
          added += seg.length;
          return parts.join('');
        }
        added = seg.length;
        return seg;
      }
      const m = dm.index;
      const ch = dm[0];
      if (ch === ',') {
        const seg = text.slice(start, m);
        pos = m + 1;
        ended = COMMA;
        if (parts) {
          parts.push(seg);
          added += seg.length;
          return parts.join('');
        }
        added = seg.length;
        return seg;
      }
      if (ch === '\n') {
        const seg = text.slice(start, m);
        pos = m + 1;
        line += 1;
        ended = LINE_BREAK;
        if (parts) {
          parts.push(seg);
          added += seg.length;
          return parts.join('');
        }
        added = seg.length;
        return seg;
      }
      // A CR: a line break when LF follows, else a stray one to drop.
      if (text.charCodeAt(m + 1) === 10) {
        const seg = text.slice(start, m);
        pos = m + 2;
        line += 1;
        ended = LINE_BREAK;
        if (parts) {
          parts.push(seg);
          added += seg.length;
          return parts.join('');
        }
        added = seg.length;
        return seg;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (!parts) parts = [];
      parts.push(text.slice(start, m));
      added += m - start;
      pos = m + 1;
      start = pos;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Returns the field
  // and sets `ended`.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let q = pos + 1;
    let parts = null;
    for (;;) {
      const nq = text.indexOf('"', q);
      if (nq === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      if (text.charCodeAt(nq + 1) === 34) {
        // A doubled quote is one quote inside the field.
        const piece = segmentValue(q, nq);
        if (parts) parts.push(piece, '"');
        else parts = piece === '' ? ['"'] : [piece, '"'];
        q = nq + 2;
        continue;
      }
      const piece = segmentValue(q, nq);
      const value = parts ? (parts.push(piece), parts.join('')) : piece;
      pos = nq + 1;
      if (pos >= len) {
        ended = END;
        return value;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        ended = COMMA;
        return value;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        ended = LINE_BREAK;
        return value;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        ended = LINE_BREAK;
        return value;
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      const junk = readUnquoted(value);
      if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return junk;
    }
  }

  // Finishes a record read whole: width, header, short/long rows.
  function finishRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      if (text.charCodeAt(pos) === 10) {
        pos += 1;
        line += 1;
      } else if (text.charCodeAt(pos) === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // The fast path: a whole plain line, no quote and no stray CR in it.
    // Its fields are one split, and the record ends at its line break.
    const le = text.indexOf('\n', pos);
    const lineEnd = le === -1 ? len : le;
    const q = text.indexOf('"', pos);
    const r = text.indexOf('\r', pos);
    // A CR counts as the line's own CRLF ending only when a LF follows it;
    // a trailing CR with no LF after it is a stray CR, not a terminator.
    const crOk = le === -1 ? r === -1 : r === -1 || r === lineEnd - 1;
    if ((q === -1 || q >= lineEnd) && crOk) {
      const end = r === lineEnd - 1 ? lineEnd - 1 : lineEnd;
      const fields = text.slice(pos, end).split(',');
      pos = le === -1 ? len : le + 1;
      if (le !== -1) line += 1;
      finishRecord(fields, false);
      continue;
    }

    // The slow path: a record with a quoted field, a stray CR, or a quoted
    // line break in it. Read it a field at a time.
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      fields.push(quoted ? readQuoted() : readUnquoted(undefined));
    } while (ended === COMMA);
    finishRecord(fields, quoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
