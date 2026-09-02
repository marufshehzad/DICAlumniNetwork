/* ============================================================
   DIC ALUMNI PLATFORM — AUDIT CHAIN

   The canonical definition of what an audit entry hashes to. The application
   writes through it and the standalone verifier reads through it, so there is
   exactly one description of the chain and no possibility of the two drifting
   apart — a verifier that agrees with the writer because both were changed
   together would prove nothing.

   See AUDIT_CHAIN.md for the design, the guarantees, and the limits.
   ============================================================ */

const crypto = require('crypto');

/* Bumping this changes every subsequent hash, which is the point: a change of
   scheme must be visible as a new segment rather than silently reinterpreting
   old rows under new rules.

   1 -> 2: version 1 hashed audit_logs.actor_id, which is a foreign key declared
   ON DELETE SET NULL. Deleting an account therefore rewrote every audit row
   that referenced it, and those entries stopped recomputing even though nobody
   had tampered with anything. Version 2 hashes actor_ref instead — the same
   value in a plain integer column with no foreign key, so the database has no
   reason ever to change it. */
const CHAIN_VERSION = 2;

/* Segments that exist but cannot be verified under the current scheme, with the
   reason stated. The verifier reports these rather than quietly ignoring them,
   and never counts them as verified. */
const HISTORICAL_SEGMENTS = {
  0: 'written before the Phase 5A boundary — the digest consumed an in-memory ' +
     'timestamp that was never persisted, so no verifier can recompute it',
  1: 'written under chain version 1, whose digest included actor_id — a foreign ' +
     'key the database nulls when an account is deleted, so recomputation is ' +
     'unreliable by design rather than by tampering'
};

// What the first verifiable entry points at. The legacy hash is embedded so the
// boundary is recorded in the chain itself rather than only in documentation.
const boundaryMarker = (lastLegacyHash) => 'LEGACY-BOUNDARY:' + (lastLegacyHash || 'NONE');

/* Millisecond precision, always UTC, always three decimals.

   This is the reason the writer supplies created_at instead of letting Postgres
   default it. timestamptz keeps microseconds; JavaScript's toISOString renders
   milliseconds. A database-generated timestamp would therefore lose its last
   three digits on the way into a verifier and no hash would ever match. The
   application generates the value, inserts it explicitly, and hashes the same
   string — so the round trip is lossless. */
function canonicalTimestamp(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) throw new Error('audit: invalid timestamp');
  return d.toISOString();
}

/* Clamps a value to what its column can hold, so an oversized input cannot make
   the INSERT fail.

   This matters more than it looks. writeAudit deliberately swallows its own
   errors — an audit failure must never take a request down — so a value too
   long for its column meant the statement threw, the entry was silently
   dropped, and the action itself still succeeded. audit_logs.ip is VARCHAR(64)
   and clientIp() returns req.ip, which honours X-Forwarded-For because the app
   sits behind a proxy. A caller sending a 65-character X-Forwarded-For could
   therefore perform an audited action and leave no audit entry at all.

   Truncation is marked so a clipped value is never mistaken for a real one. */
function clamp(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/* An array, not an object: there is no key ordering to get wrong, and
   JSON.stringify escapes strings deterministically. Every element is a column
   persisted on the row, so a verifier with only the database can rebuild this
   string byte for byte. */
function canonicalPayload(entry) {
  return JSON.stringify([
    CHAIN_VERSION,
    entry.prevHash,
    canonicalTimestamp(entry.createdAt),
    entry.action,
    entry.meta,
    // actorRef, never actorId: the latter is a foreign key the database nulls
    // on account deletion, and a digest input must not be something the
    // database is entitled to rewrite.
    entry.actorRef ?? null,
    entry.targetType ?? null,
    entry.targetId ?? null,
    entry.ip ?? null,
    entry.icon ?? null
  ]);
}

// Full SHA-256. The legacy scheme truncated to 16 hex characters — 64 bits,
// which is not a tamper-evidence claim.
function computeHash(entry) {
  return crypto.createHash('sha256').update(canonicalPayload(entry), 'utf8').digest('hex');
}

/* Rebuilds the digest for a row exactly as it came out of the database. Used by
   the verifier and by nothing else — the writer builds its entry from values it
   already holds. */
function hashOfRow(row) {
  return computeHash({
    prevHash: row.prev_hash,
    createdAt: row.created_at,
    action: row.action,
    meta: row.meta,
    actorRef: row.actor_ref,
    targetType: row.target_type,
    targetId: row.target_id,
    ip: row.ip,
    icon: row.icon
  });
}

/* Appends one entry.

   The row lock on audit_chain serialises appends. Without it, two concurrent
   writes both read the same predecessor and the chain forks — which is exactly
   what the previous SELECT-then-INSERT could do. The lock also keeps the head
   pointer and the last row in step.

   Runs inside the caller's transaction when one is supplied, so an audit entry
   about a change lands with the change or not at all. */
async function appendEntry(db, entry, existingClient) {
  const client = existingClient || await db.pool.connect();
  const ownTransaction = !existingClient;
  try {
    if (ownTransaction) await client.query('BEGIN');

    const head = await client.query(
      'SELECT head_hash FROM audit_chain WHERE id = 1 FOR UPDATE');

    let prevHash = head.rows[0]?.head_hash;
    if (!prevHash) {
      // First verifiable entry: anchor it to the end of the legacy segment.
      const prior = await client.query(
        `SELECT COALESCE(entry_hash, hash) AS h FROM audit_logs
           WHERE chain_version < $1 ORDER BY id DESC LIMIT 1`, [CHAIN_VERSION]);
      prevHash = boundaryMarker(prior.rows[0]?.h);
    }

    // Millisecond precision so the value survives the round trip intact.
    const createdAt = new Date();
    createdAt.setMilliseconds(createdAt.getMilliseconds());
    const createdAtIso = canonicalTimestamp(createdAt);

    const full = {
      prevHash,
      createdAt: createdAtIso,
      /* Clamped to the column widths declared in schema.sql and schema_v7.sql.
         An oversized value used to abort the insert, and because writeAudit
         swallows its errors that meant the entry vanished while the action it
         described went through. */
      action: clamp(entry.action, 100),
      meta: entry.meta === null || entry.meta === undefined ? '' : String(entry.meta).slice(0, 4000),
      actorId: entry.actorId ?? null,
      // The same value, twice on purpose. actor_id keeps its foreign key and
      // stays joinable; actor_ref is immutable and is what the digest consumes.
      actorRef: entry.actorId ?? null,
      targetType: clamp(entry.targetType, 50),
      targetId: entry.targetId ?? null,
      ip: clamp(entry.ip, 64),
      icon: clamp(entry.icon, 20)
    };
    const entryHash = computeHash(full);

    const inserted = await client.query(
      `INSERT INTO audit_logs
         (icon, action, meta, hash, actor_id, actor_ref, target_type, target_id, ip,
          created_at, chain_version, prev_hash, entry_hash)
       VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, created_at`,
      [full.icon, full.action, full.meta, full.actorId, full.actorRef, full.targetType,
       full.targetId, full.ip, createdAtIso, CHAIN_VERSION, prevHash, entryHash]);

    await client.query(
      `UPDATE audit_chain
          SET head_hash = $1, entry_count = entry_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1`, [entryHash]);

    if (ownTransaction) await client.query('COMMIT');
    return { id: inserted.rows[0].id, entryHash, prevHash, createdAt: createdAtIso };
  } catch (e) {
    if (ownTransaction) { try { await client.query('ROLLBACK'); } catch { /* gone */ } }
    throw e;
  } finally {
    if (ownTransaction) client.release();
  }
}

/* Walks the chain and reports what it finds. Pure: it reads, recomputes and
   compares, and never writes.

   Returns { ok, legacyCount, verifiedCount, problems[], head }. Problems carry
   the row id and the reason, and the caller decides how loudly to say so. */
async function verifyChain(db, { limit = null } = {}) {
  const problems = [];

  /* Every segment written under a superseded scheme, each with the reason it
     cannot be checked. Reported, never counted as verified. */
  const segRows = (await db.query(
    `SELECT chain_version AS v, COUNT(*)::int n, MAX(id)::int last
       FROM audit_logs WHERE chain_version < $1
      GROUP BY chain_version ORDER BY chain_version`, [CHAIN_VERSION])).rows;
  const historical = segRows.map(r => ({
    version: r.v, count: r.n, lastId: r.last,
    reason: HISTORICAL_SEGMENTS[r.v] || 'written under a superseded chain version'
  }));
  const legacyCount = historical.reduce((a, s) => a + s.count, 0);
  const lastLegacyId = historical.length ? historical[historical.length - 1].lastId : null;

  const rows = (await db.query(
    /* actor_ref must be selected: it is what the digest consumes. Omitting it
       made every row hash as though the actor were null, so the verifier
       disagreed with the writer on exactly the rows that had an actor. */
    `SELECT id, icon, action, meta, actor_id, actor_ref, target_type, target_id, ip,
            created_at, chain_version, prev_hash, entry_hash
       FROM audit_logs WHERE chain_version = $1 ORDER BY id ASC` +
    (limit ? ` LIMIT ${parseInt(limit, 10)}` : ''), [CHAIN_VERSION])).rows;

  // Anything ordered after the legacy segment must be part of the new chain.
  const strays = await db.query(
    `SELECT COUNT(*)::int n FROM audit_logs
      WHERE chain_version < $2 AND id > COALESCE($1::int, 0)`,
    [rows.length ? rows[0].id : null, CHAIN_VERSION]);
  if (rows.length && strays.rows[0].n > 0) {
    problems.push({ id: null, reason: 'legacy-row-after-boundary',
      detail: `${strays.rows[0].n} superseded-version row(s) appear after the first verifiable entry — ` +
              'an older-scheme entry cannot be written once the current chain has started' });
  }

  let expectedPrev = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (i === 0) {
      if (!String(row.prev_hash || '').startsWith('LEGACY-BOUNDARY:')) {
        problems.push({ id: row.id, reason: 'bad-boundary',
          detail: 'the first verifiable entry does not anchor to the legacy boundary' });
      }
    } else if (row.prev_hash !== expectedPrev) {
      problems.push({ id: row.id, reason: 'prev-hash-mismatch',
        detail: `prev_hash does not match the preceding entry's entry_hash — ` +
                'an entry was altered, removed, or inserted here' });
    }

    /* actor_id is not in the digest — it is a foreign key the database nulls on
       account deletion, which is why actor_ref exists. But actor_id is what the
       admin UI displays, so leaving it unchecked would let someone re-attribute
       a visible action without breaking a hash. It must therefore either match
       the hashed reference or be NULL, which is the one change the database
       itself is allowed to make. */
    if (row.actor_id !== null && row.actor_id !== row.actor_ref) {
      problems.push({ id: row.id, reason: 'actor-mismatch',
        detail: 'actor_id does not match the hashed actor_ref — the displayed ' +
                'attribution was changed without touching the digest' });
    }

    let recomputed;
    try {
      recomputed = hashOfRow(row);
    } catch (e) {
      problems.push({ id: row.id, reason: 'unhashable', detail: e.message });
      expectedPrev = row.entry_hash;
      continue;
    }
    if (recomputed !== row.entry_hash) {
      problems.push({ id: row.id, reason: 'entry-hash-mismatch',
        detail: 'the stored entry_hash does not match the row contents — ' +
                'one of action, meta, actor, target, ip, icon, created_at or prev_hash was changed' });
    }

    expectedPrev = row.entry_hash;
  }

  /* Every row must belong to a segment this verifier knows about. Without this,
     an entry carrying an unrecognised chain_version — say 99 — is matched by
     neither "the current chain" nor "a superseded segment", so it is displayed
     in the admin audit log while being invisible to verification. That is a
     forged entry with a free pass. */
  const unknown = await db.query(
    `SELECT chain_version AS v, COUNT(*)::int n, MIN(id)::int first
       FROM audit_logs WHERE chain_version > $1 OR chain_version < 0
      GROUP BY chain_version`, [CHAIN_VERSION]);
  for (const u of unknown.rows) {
    problems.push({ id: u.first, reason: 'unknown-chain-version',
      detail: `${u.n} entr${u.n === 1 ? 'y' : 'ies'} carry chain_version ${u.v}, which no ` +
              'scheme in this codebase produces — they are neither verifiable nor a known ' +
              'historical segment' });
  }

  /* Every row in the table must be accounted for by exactly one segment. This
     is the backstop for the check above: rather than enumerating the versions
     that are wrong, it insists the parts sum to the whole, so a row that slips
     past every other rule still shows up as an arithmetic discrepancy. */
  const total = (await db.query('SELECT COUNT(*)::int n FROM audit_logs')).rows[0].n;
  const accounted = legacyCount + rows.length;
  if (total !== accounted) {
    problems.push({ id: null, reason: 'count-reconciliation',
      detail: `the table holds ${total} entries but only ${accounted} are accounted for ` +
              `(${legacyCount} historical + ${rows.length} verified) — ${total - accounted} ` +
              'entr(y/ies) belong to no known segment' });
  }

  // A truncated tail leaves no successor to notice it, so the head is held
  // separately. See AUDIT_CHAIN.md section 3 for what this does and does not buy.
  const headRow = await db.query('SELECT head_hash, entry_count FROM audit_chain WHERE id = 1');
  const head = headRow.rows[0] || {};
  if (rows.length) {
    if (head.head_hash !== rows[rows.length - 1].entry_hash) {
      problems.push({ id: rows[rows.length - 1].id, reason: 'head-mismatch',
        detail: 'the recorded chain head is not the last entry — entries may have been removed from the end' });
    }
    if (typeof head.entry_count === 'number' && head.entry_count !== rows.length) {
      problems.push({ id: null, reason: 'count-mismatch',
        detail: `the chain head counts ${head.entry_count} entries but ${rows.length} are present` });
    }
  } else if (head.head_hash) {
    problems.push({ id: null, reason: 'head-without-entries',
      detail: 'the chain head names an entry but no verifiable entries exist — the chain was emptied' });
  }

  return {
    ok: problems.length === 0,
    legacyCount, lastLegacyId, historical,
    verifiedCount: rows.length,
    firstInvalid: problems.length ? problems[0] : null,
    problems,
    head
  };
}

module.exports = {
  CHAIN_VERSION, HISTORICAL_SEGMENTS, canonicalPayload, canonicalTimestamp,
  computeHash, hashOfRow, appendEntry, verifyChain, boundaryMarker
};
