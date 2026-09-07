/* ============================================================
   DIC ALUMNI PLATFORM — CSV EXPORT
   One mechanism for every export in the platform.

   Before this, the only CSV in the system was the event attendee list, which
   built its own header row and its own escape function inline. Ten more
   exports written the same way would have been ten more chances to get
   quoting, encoding or column order subtly wrong — and one chance in ten to
   put a password hash in a column because nobody looked.

   What this guarantees, for every caller:

   • RFC 4180 quoting. Every cell is quoted; embedded quotes are doubled.
     A comma, a newline or a quote in a name cannot shift a column.
   • UTF-8 with a BOM. Bengali names are common in this data and Excel on
     Windows renders them as mojibake without the BOM. The BOM costs three
     bytes and makes the file open correctly by double-click.
   • CRLF line endings, per RFC 4180.
   • Stable column order, defined by the caller's column list on the server.
     The client never chooses columns, so it can never widen an export.
   • Formula-injection defence. A cell beginning = + - @ or a control
     character is prefixed with an apostrophe. Without this, a name field
     containing =HYPERLINK(...) becomes a live formula when the exported file
     is opened in Excel, and the export turns into a delivery mechanism.
   • A credential guard. buildCsv REFUSES to run if any column key or header
     looks like a secret. This is deliberately a throw and not a filter: an
     export that silently drops a column is worse than one that fails loudly,
     because nobody notices the silence. It has already caught one export in
     this phase — the audit log's chain digests, whose column names read as
     credentials even though a digest is not one. The answer was to rename the
     columns, not to add an exception; a guard with an escape hatch is a guard
     that will one day be escaped.
   ============================================================ */

/* The same vocabulary Phase 7C-1 used to scrub the DSAR export. Kept identical
   on purpose — one definition of "this is a secret" across the platform. */
const SECRET_KEY = /password|passwd|hash|token|secret|salt|cipher|ciphertext|auth_tag|\biv\b|private_key|api_key|\bnid\b|national_id/i;

/* Characters that make a spreadsheet treat a cell as an expression. TAB and CR
   are here because Excel strips them and re-reads what follows. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function csvCell(value) {
  if (value === null || value === undefined) return '""';

  let s;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'boolean') s = value ? 'yes' : 'no';
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);

  if (FORMULA_LEAD.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/* columns: [{ key, header }] — key indexes the row, header is what a human
   reads. Both are the server's, never the caller's. */
function buildCsv(columns, rows) {
  if (!Array.isArray(columns) || !columns.length) {
    throw new Error('buildCsv: a column list is required');
  }

  for (const c of columns) {
    if (SECRET_KEY.test(c.key) || SECRET_KEY.test(c.header || '')) {
      throw new Error(`buildCsv refuses to export the column "${c.key}": it reads as a credential`);
    }
  }

  const lines = [columns.map(c => csvCell(c.header ?? c.key)).join(',')];
  for (const r of rows) {
    lines.push(columns.map(c => csvCell(r ? r[c.key] : null)).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/* A filename an operating system will accept, dated so two exports of the same
   report do not overwrite each other in a downloads folder. */
function exportFilename(slug, ext = 'csv') {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = String(slug).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'export';
  return `dic_${safe}_${stamp}.${ext}`;
}

function sendCsv(res, slug, columns, rows) {
  const body = buildCsv(columns, rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(slug)}"`);
  /* An export is a snapshot of personal data. It must not sit in a shared
     cache, and the browser must not sniff it into something executable. */
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(body);
}

module.exports = { csvCell, buildCsv, sendCsv, exportFilename, SECRET_KEY };
