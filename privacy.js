/* ============================================================
   DIC ALUMNI PLATFORM — field privacy, defined once

   Before this file, `PRIVACY_FIELDS` was a bare array in server.js listing
   'email' and 'mobile', while the database default for privacy_settings still
   carried keys for address, cgpa, github and linkedin that nothing read and
   nothing could write, and the profile page rendered a badge from
   `priv.address` — an undefined value that always printed "Alumni Only".
   Three descriptions of the same thing, none of them agreeing.

   This module is now the only description. The server validates against it,
   the read side gates against it, and the browser renders its controls from
   it over GET /api/profile/privacy-schema. A field cannot appear in the
   interface without the server enforcing it, because the interface is built
   from the same object the server enforces.

   The rule that shapes everything here: the read side fails OPEN. A gate that
   asks "is this value 'private'?" reveals the field for any value it does not
   recognise, so the write side must be a whitelist and an unknown key or level
   must be refused outright rather than stored and quietly ignored.
   ============================================================ */

/* Levels, and what each one actually does. There is no anonymous access to any
   profile in this product — every viewer is signed in — so 'public' and
   'alumni' would be indistinguishable for a field that is only ever read on a
   profile page. They are offered only for `location`, where they genuinely
   differ: 'public' is counted in the map aggregate and 'alumni' is not. A
   level that changes nothing is the false assurance this design exists to
   avoid, so no other field offers both. */
const LEVELS = { PUBLIC: 'public', ALUMNI: 'alumni', PRIVATE: 'private' };

const PRIVACY_FIELDS = {
  email: {
    label: 'Email address',
    levels: [LEVELS.PUBLIC, LEVELS.PRIVATE],
    default: LEVELS.PUBLIC,
    optionLabels: {
      [LEVELS.PUBLIC]: 'Signed-in DIC members',
      [LEVELS.PRIVATE]: 'Only me and administrators'
    },
    staffBypass: true
  },
  mobile: {
    label: 'Mobile number',
    levels: [LEVELS.PUBLIC, LEVELS.PRIVATE],
    default: LEVELS.PRIVATE,
    optionLabels: {
      [LEVELS.PUBLIC]: 'Signed-in DIC members',
      [LEVELS.PRIVATE]: 'Only me and administrators'
    },
    staffBypass: true
  },
  location: {
    label: 'City and country',
    levels: [LEVELS.PUBLIC, LEVELS.ALUMNI, LEVELS.PRIVATE],
    default: LEVELS.ALUMNI,
    optionLabels: {
      [LEVELS.PUBLIC]: 'Members, and counted on the alumni map',
      [LEVELS.ALUMNI]: 'Members only — not counted on the map',
      [LEVELS.PRIVATE]: 'Only me'
    },
    /* No staff bypass, deliberately. An administrator who needs a regional
       view should get an explicit, role-scoped, audited report rather than an
       implicit exemption that nobody set out to grant. If a member marks their
       city private, it is private — the same answer for every role. */
    staffBypass: false,
    help: 'Your city is what places you on the alumni map. Your street address is never shown.'
  }
};

/* Street address, postal code, permanent address and hometown are NOT
   user-settable privacy fields, and this is a deliberate refusal rather than
   an omission.

   The only levels that could be offered are "self only" and "share my home
   address with every member". The second has no legitimate use in a college
   alumni directory and a real cost for the people least able to absorb it, so
   the control is not built. The fields are self-only, unconditionally, and the
   interface states that as a fact instead of rendering a switch that should
   never be moved.

   Nothing here has a staff bypass either: no administrator role reads a home
   address through the API. */
const SELF_ONLY_FIELDS = ['present_address', 'permanent_address', 'postal_code', 'hometown'];

const FIELD_NAMES = Object.keys(PRIVACY_FIELDS);
const STAFF_ROLES = ['super_admin', 'univ_admin', 'dept_admin'];

/** The settings an account starts with, and the fallback for any missing key. */
function defaults() {
  const out = {};
  for (const [name, spec] of Object.entries(PRIVACY_FIELDS)) out[name] = spec.default;
  return out;
}

/** Merge stored settings over the defaults, discarding anything unrecognised. */
function effective(stored) {
  const out = defaults();
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [k, v] of Object.entries(stored)) {
      if (PRIVACY_FIELDS[k] && PRIVACY_FIELDS[k].levels.includes(v)) out[k] = v;
    }
  }
  return out;
}

/**
 * Validate a caller-supplied privacySettings object.
 * @returns {{ok: true, clean: object} | {ok: false, error: string}}
 */
function validateSettings(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'privacySettings must be an object' };
  }
  const clean = {};
  for (const key of Object.keys(input)) {
    const spec = PRIVACY_FIELDS[key];
    if (!spec) return { ok: false, error: `Unknown privacy field: ${key}` };
    const value = input[key];
    if (typeof value !== 'string' || !spec.levels.includes(value)) {
      return {
        ok: false,
        error: `Invalid privacy level for ${key}. Allowed: ${spec.levels.join(', ')}`
      };
    }
    clean[key] = value;
  }
  return { ok: true, clean };
}

/**
 * Can this viewer see this field on this profile?
 * @param {string} field   a key of PRIVACY_FIELDS
 * @param {object} ctx     { settings, isSelf, viewerRole }
 */
function canSee(field, { settings, isSelf, viewerRole } = {}) {
  const spec = PRIVACY_FIELDS[field];
  if (!spec) return false;                 // unknown field: closed, not open
  if (isSelf) return true;
  const level = effective(settings)[field];
  if (level === LEVELS.PRIVATE) {
    return spec.staffBypass === true && STAFF_ROLES.includes(viewerRole);
  }
  return true;                             // public and alumni are both visible to a member
}

/** Only 'public' locations are counted in map aggregates. */
function countsOnMap(settings) {
  return effective(settings).location === LEVELS.PUBLIC;
}

/* SQL fragments for the two location questions the queries ask. Both read the
   stored setting and fall back to the same default this module defines, so a
   profile that has never saved a preference is treated identically in SQL and
   in JavaScript. Both expect the alumni_profiles alias to be `ap`. */

/** "This profile opted into the map aggregate" — 'public' only. */
const MAP_VISIBLE_SQL =
  `COALESCE(ap.privacy_settings ->> 'location', '${PRIVACY_FIELDS.location.default}') = '${LEVELS.PUBLIC}'`;

/** "Other members may see this profile's city" — anything but 'private'. */
const DIRECTORY_VISIBLE_SQL =
  `COALESCE(ap.privacy_settings ->> 'location', '${PRIVACY_FIELDS.location.default}') <> '${LEVELS.PRIVATE}'`;

/** What the browser needs to render the controls. No secrets, no user data. */
function schemaForClient() {
  return {
    levels: LEVELS,
    fields: Object.entries(PRIVACY_FIELDS).map(([name, spec]) => ({
      name,
      label: spec.label,
      levels: spec.levels,
      default: spec.default,
      optionLabels: spec.optionLabels,
      help: spec.help || null
    })),
    selfOnlyFields: SELF_ONLY_FIELDS,
    selfOnlyNote: 'Street address, permanent address, postal code and hometown are ' +
                  'visible only to you. They are never returned by the directory, the ' +
                  'map, or another member’s view of your profile, and there is no ' +
                  'setting that can change that.'
  };
}

module.exports = {
  LEVELS, PRIVACY_FIELDS, SELF_ONLY_FIELDS, FIELD_NAMES, STAFF_ROLES,
  defaults, effective, validateSettings, canSee, countsOnMap,
  MAP_VISIBLE_SQL, DIRECTORY_VISIBLE_SQL, schemaForClient
};
