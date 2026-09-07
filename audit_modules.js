/* ============================================================
   DIC ALUMNI PLATFORM — AUDIT MODULE CLASSIFICATION
   Phase 7C-3.

   audit_logs stores a human-readable action ("Event Approved", "Signed In")
   and nothing that says which part of the platform it belongs to. Both the
   Administrator Activity report and the audit log's own Module filter need
   that grouping, so it is defined once, here, and compiled into SQL from the
   same array the JavaScript uses. Two copies of this list would drift the
   first time somebody added an action to one of them.

   Classification is by prefix, because the actions are written verb-last
   ("Event Created", "Chapter Location Set"). An action that matches nothing
   is 'Other' rather than being dropped: an unclassified entry must still be
   findable, and a filter that silently hides rows from an audit log is a
   defect with a security shape.
   ============================================================ */

const MODULES = [
  ['Authentication', 'Signed In|Signed Out|Sign-In Failed|Password|Session'],
  ['Alumni',         'Alumni|Verification|Profile|Account Purged|Account Deletion'],
  ['Events',         'Event|Attendee|Ticket|Task|Standard Checklist|External Contact|Committee|Volunteer|Sponsor|Vendor|Budget|Procurement|Risk|Meeting|Timeline|Logistics|Marketing'],
  ['Jobs',           'Job|Application Status|Referral'],
  ['Donations',      'Donation|Campaign'],
  ['Chapters',       'Chapter'],
  ['Mentorship',     'Mentorship'],
  ['Compliance',     'Consent|DSAR|Vault|Identity'],
  ['Administration', 'Administrator'],
  ['Import',         'Bulk Import|Import'],
  ['Polls',          'Poll'],
  ['Broadcasts',     'Broadcast'],
  ['Moderation',     'Story|Moderation'],
  ['Reports',        'Report'],
  ['Operations',     'Database|Scheduler|Ops|Sync']
];

const MODULE_NAMES = MODULES.map(m => m[0]).concat('Other');

/** Which module an action belongs to, in JavaScript. */
function moduleOf(action) {
  const s = String(action || '');
  for (const [name, alt] of MODULES) {
    if (new RegExp(`^(${alt})`, 'i').test(s)) return name;
  }
  return 'Other';
}

/** The same decision as SQL, so it can be filtered and grouped in the database. */
function moduleCaseSql(col = 'action') {
  const branches = MODULES.map(([name, alt]) =>
    `WHEN ${col} ~* '^(${alt})' THEN '${name}'`);
  return `CASE ${branches.join(' ')} ELSE 'Other' END`;
}

module.exports = { MODULES, MODULE_NAMES, moduleOf, moduleCaseSql };
