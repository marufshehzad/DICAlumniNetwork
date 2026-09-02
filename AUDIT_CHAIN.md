# Audit Trail — design, guarantees, and limits

This document exists because the previous audit trail *described* itself as an
immutable hash chain while being impossible to verify. Anyone can now check the
claims below against the database with `node verify_audit.js`.

---

## 1. What the chain was before Phase 5A

Recorded here as the starting point, because the historical rows still carry it.

```js
// routes_v2.js, writeAudit — the implementation up to Phase 4
const prev = await db.query('SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1');
const prevHash = prev.rows[0]?.hash || 'GENESIS';
const hash = crypto.createHash('sha256')
  .update(prevHash + action + meta + new Date().toISOString())
  .digest('hex').slice(0, 16);
await db.query(
  `INSERT INTO audit_logs (icon, action, meta, hash, actor_id, target_type, target_id, ip)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [...]);
```

| Property | Value |
|---|---|
| Digest | SHA-256, **truncated to 16 hex characters** (64 bits) |
| Inputs | `prevHash + action + meta + new Date().toISOString()` |
| Stored as | `0x` + uppercase hex, in `audit_logs.hash` |
| Previous entry | The row with the highest `id` |
| Predecessor recorded? | **No** — nothing stores which hash was consumed |
| Timestamp recorded? | **No** — `created_at` is a *separate* Postgres `CURRENT_TIMESTAMP`, not the string that was hashed |

### Why those rows cannot be verified

The digest consumed `new Date().toISOString()` from the application's memory.
The row stores `created_at`, generated independently by Postgres at a slightly
different instant and at microsecond precision. The two never matched, and the
hashed value was discarded the moment the insert completed.

So for every pre-boundary row, one of the four digest inputs is **gone**. No
verifier — not this one, not a future one, not the original author — can
recompute those hashes. This is a property of the data, not a limitation of the
tool, and no amount of later engineering recovers it.

Two further weaknesses in the old scheme, recorded for completeness:

- **64-bit truncation.** A 16-hex-character digest is far short of what a
  tamper-evidence claim needs.
- **A read-then-write race.** `SELECT … ORDER BY id DESC` followed by a separate
  `INSERT` is not atomic, so two concurrent audit writes could both read the
  same predecessor and produce a fork.

---

## 2. Chain version 1, and why it was superseded

The first attempt at a verifiable chain (migration v11) put `actor_id` in the
digest. That column is a foreign key declared `ON DELETE SET NULL`, so deleting
an account silently rewrote every audit row that referenced it, and those
entries stopped recomputing although nobody had tampered with anything.

The Phase 5A test suite caught it: six entries failed to recompute, and all six
were exactly the rows whose actor had since been deleted. A digest input must
not be a value the database is entitled to change.

Migration v12 added `actor_ref` — the same value in a plain integer column with
no foreign key — and chain version became 2. Version 1 entries are preserved
unchanged and reported by the verifier as a superseded segment with that reason
stated. They were not rewritten to fit the new scheme: fabricating hashes to
make a verifier pass is the failure this phase exists to prevent.

---

## 3. What the chain is from the boundary forward

### Columns

| Column | Meaning |
|---|---|
| `chain_version` | `0` and `1` = historical, not verifiable (sections 1 and 2). `2` = the scheme below. |
| `prev_hash` | The `entry_hash` of the preceding entry, **persisted**. |
| `entry_hash` | Full SHA-256, 64 lowercase hex characters. |
| `created_at` | Written by the application at **millisecond** precision, and is the exact value fed to the digest. |

`hash` is retained unchanged. It holds the legacy value on legacy rows and is
left NULL-equivalent on new ones; it is never rewritten.

### Canonical payload

The digest input is a JSON array — an array, not an object, so there is no key
ordering to get wrong, and `JSON.stringify` escapes deterministically:

```js
JSON.stringify([
  2,               // chain version — a change of scheme changes every hash
  prevHash,        // string
  createdAtIso,    // 'YYYY-MM-DDTHH:mm:ss.sssZ', always UTC, always 3 decimals
  action,          // string
  meta,            // string
  actorRef,        // number | null — NOT actor_id; see section 2
  targetType,      // string | null
  targetId,        // number | null
  ip,              // string | null
  icon             // string
])

entry_hash = sha256(payload)   // full 64 hex, lowercase
```

Every element is a column persisted on the row. A verifier reading only the
database can rebuild the string byte for byte.

### Why the application supplies `created_at`

Postgres stores `timestamptz` at microsecond precision. `new Date(value).toISOString()`
in JavaScript renders milliseconds, so a Postgres-generated timestamp would lose
its last three digits on the way into the verifier and the hash would never
match. The writer therefore generates the timestamp itself, at millisecond
precision, and inserts it explicitly — so the round trip through the database
is lossless and the digest input is exactly what the row holds.

*(Checked against the live data before choosing this: existing rows carry
non-zero sub-millisecond components — 362µs, 922µs, 987µs on three sampled
rows — so relying on the database clock would have silently broken verification.)*

### Appends are serialised

Each write takes a row lock on `audit_chain` before reading the head, so two
concurrent writes cannot both build on the same predecessor. The same lock keeps
`audit_chain.head_hash` and the last row in step.

### The boundary

The first entry of a new chain version records the transition explicitly:

```
prev_hash = 'LEGACY-BOUNDARY:<the last hash of the preceding segment>'
```

The boundary is therefore part of the chain rather than a note in a document.

---

## 4. What is and is not guaranteed

**Verifiable, and checked by `verify_audit.js`:**

- Every `chain_version = 2` entry hashes to its stored `entry_hash`.
- Each entry's `prev_hash` equals the previous entry's `entry_hash`.
- Any edit to `action`, `meta`, `actor_ref`, `target_type`, `target_id`, `ip`,
  `icon`, `created_at`, `prev_hash` or `entry_hash` breaks the chain at that row.
- A deleted entry breaks its successor's `prev_hash`.
- An inserted entry has no valid place in the linkage.
- The chain reaches the head recorded in `audit_chain`.

**Not guaranteed, stated plainly:**

- **Historical rows (chain versions 0 and 1) cannot be verified.** Sections 1
  and 2 explain why, and the reasons differ. The verifier reports each segment
  separately with its own reason, and never counts either as verified.
- **Truncating the newest entries** is only caught because `audit_chain.head_hash`
  still names the entry that should be there. An attacker with write access to
  the whole database can update that pointer too. No in-database scheme survives
  an attacker who controls the database; what defeats that is an off-site copy —
  which is what the nightly backup and the weekly restore drill are for.
- **A row can be *added* to the historical segments undetectably.** This follows
  from the line above and deserves saying outright, because it is easy to read
  "historical rows are preserved" as if they were also protected. They are not:
  versions 0 and 1 have no integrity protection at all, so someone with write
  access can insert a plausible-looking entry among them with a low id and
  nothing will object. The verifier can only report that the segment is
  unverifiable — which it does. Anything relying on the historical segment as
  evidence should be corroborated against an off-site backup taken before the
  period in question.

- **The digest is unkeyed.** `entry_hash` is a plain SHA-256, so anyone who can
  write to the database can also recompute a consistent chain. Detection here
  rests on the attacker having to rewrite every subsequent row *and* the head
  pointer, and on an off-site copy disagreeing. An HMAC keyed outside the
  database would raise that bar and is the obvious next improvement; it is not
  in place today, and the guarantees above are stated on the assumption that it
  is not.

- **The chain proves integrity, not truth.** It shows an entry has not been
  altered since it was written. It cannot show the application wrote something
  accurate in the first place.

---

## 5. Personal data in audit metadata

`meta` is inside the digest, which creates a genuine and unavoidable tension:
rewriting a historical entry to remove a name would invalidate every entry after
it and destroy the evidence the chain exists to protect.

The resolution, and it is a trade rather than a fix:

- **Historical rows (chain versions 0 and 1) are left exactly as they are.** Some pre-Phase-5A entries
  contain names and email addresses. They are preserved, and this limitation is
  documented rather than hidden.
- **New entries reference people by internal id.** Every audit writer was
  reviewed; the ones interpolating a name, an email address or other personal
  data now record `user <id>` instead. An operator can still see what happened
  and to whom; the identity resolves through the database rather than being
  copied into the log.
- **Secrets were never permitted and still are not.** No writer records a
  password, token, reset link, session or encryption key. This is asserted by
  test, not by convention.

The purge worker deliberately does **not** scrub `meta` when erasing an account,
for the reason above. That residual is disclosed in the deletion documentation.
