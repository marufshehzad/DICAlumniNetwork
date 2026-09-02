/* ============================================================
   DIC ALUMNI PLATFORM — location resolution

   Turns the free text a person or a spreadsheet supplies into a row of
   location_places, or refuses and says why. Shared by the profile editor, the
   CSV import and the tests, so all three agree on what "Chittagong" means.

   Two rules shape this file:

   1. Coordinates belong to places. Nothing here reads or writes a coordinate
      for a person; a place_id is a reference to a city whose position is
      public knowledge.

   2. An unresolved location stays unresolved. It is never coerced to a
      plausible neighbour, and never defaulted to Dhaka — that default is the
      defect this whole phase exists to remove. An import row with a location
      nobody can identify is reported, and the row is stored without one.
   ============================================================ */

/* Explicit aliases only. Every entry is a documented rename or a spelling the
   institution's own records actually use — not a guess at what somebody meant.
   Ambiguous input is left unresolved on purpose: "Springfield" or "CTG" resolve
   to nothing rather than to something confident and wrong. */
const CITY_ALIASES = {
  // Bangladeshi cities renamed in 2018, still written both ways in records.
  'chittagong': 'Chattogram',
  'comilla': 'Cumilla',
  'jessore': 'Jashore',
  'bogra': 'Bogura',
  'barisal': 'Barishal',
  'dacca': 'Dhaka',
  'coxs bazar': "Cox's Bazar",
  'cox bazar': "Cox's Bazar",
  'moulavibazar': 'Moulvibazar',
  'maulvibazar': 'Moulvibazar',
  // Common written forms of cities alumni actually live in.
  'bangalore': 'Bengaluru',
  'calcutta': 'Kolkata',
  'bombay': 'Mumbai',
  'delhi': 'New Delhi',
  'nyc': 'New York',
  'new york city': 'New York',
  'san fransisco': 'San Francisco',
  'washington dc': 'Washington',
  'washington d.c.': 'Washington',
  'sao paolo': 'Sao Paulo',
  'zürich': 'Zurich',
  'kuala lumper': 'Kuala Lumpur'
};

const COUNTRY_ALIASES = {
  'usa': 'United States',
  'u.s.a.': 'United States',
  'us': 'United States',
  'u.s.': 'United States',
  'united states of america': 'United States',
  'america': 'United States',
  'uk': 'United Kingdom',
  'u.k.': 'United Kingdom',
  'britain': 'United Kingdom',
  'great britain': 'United Kingdom',
  'england': 'United Kingdom',
  'scotland': 'United Kingdom',
  'wales': 'United Kingdom',
  'uae': 'United Arab Emirates',
  'u.a.e.': 'United Arab Emirates',
  'emirates': 'United Arab Emirates',
  'ksa': 'Saudi Arabia',
  'korea': 'South Korea',
  'republic of korea': 'South Korea',
  'bd': 'Bangladesh',
  'bangla desh': 'Bangladesh',
  'holland': 'Netherlands',
  'deutschland': 'Germany'
};

/** Trim, collapse internal whitespace, drop a trailing comma. Nothing else. */
function clean(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\s+/g, ' ').replace(/[,\s]+$/, '').trim();
  return s.length ? s : null;
}

/** Lower-cased, punctuation-light key used only for alias lookup and matching. */
function key(value) {
  const c = clean(value);
  return c === null ? null : c.toLowerCase().replace(/[.']/g, '').replace(/\s+/g, ' ');
}

function canonicalCity(value) {
  const k = key(value);
  if (k === null) return null;
  return CITY_ALIASES[k] || clean(value);
}

function canonicalCountry(value) {
  const k = key(value);
  if (k === null) return null;
  return COUNTRY_ALIASES[k] || clean(value);
}

/**
 * Resolve free text to a location_places row.
 *
 * @param {object} q      a node-pg client or pool (anything with .query)
 * @param {object} input  { country, city }
 * @returns {Promise<{placeId: number|null, place: object|null, status: string, reason: string|null}>}
 *
 * status is one of:
 *   'resolved'        a single place matched
 *   'empty'           nothing was supplied — not an error
 *   'no-city'         a country was given without a city; places are city-level
 *   'unknown-city'    the city is not in the reference table
 *   'ambiguous'       the city name exists in more than one country and no
 *                     country was given to choose between them
 */
async function resolvePlace(q, { country, city } = {}) {
  const cityName = canonicalCity(city);
  const countryName = canonicalCountry(country);

  if (!cityName && !countryName) {
    return { placeId: null, place: null, status: 'empty', reason: null };
  }
  if (!cityName) {
    return {
      placeId: null, place: null, status: 'no-city',
      reason: `"${countryName}" is a country; a city is needed to place it on the map`
    };
  }

  const params = [cityName.toLowerCase()];
  let sql = `SELECT * FROM location_places WHERE LOWER(city) = $1 AND is_active`;
  if (countryName) {
    params.push(countryName.toLowerCase());
    sql += ` AND (LOWER(country) = $2 OR LOWER(country_code) = $2)`;
  }
  sql += ' ORDER BY id';

  const { rows } = await q.query(sql, params);

  if (rows.length === 1) {
    return { placeId: rows[0].id, place: rows[0], status: 'resolved', reason: null };
  }
  if (rows.length > 1) {
    return {
      placeId: null, place: null, status: 'ambiguous',
      reason: `"${cityName}" exists in ${rows.length} countries; supply a country to choose`
    };
  }
  return {
    placeId: null, place: null, status: 'unknown-city',
    reason: countryName
      ? `"${cityName}, ${countryName}" is not in the reference list`
      : `"${cityName}" is not in the reference list`
  };
}

/** Look up one place by id, or null. */
async function placeById(q, id) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) return null;
  const { rows } = await q.query('SELECT * FROM location_places WHERE id = $1 AND is_active', [n]);
  return rows[0] || null;
}

/** "Dhaka, Bangladesh" — the one display form, so every screen agrees. */
function displayName(place) {
  if (!place) return null;
  return [place.city, place.country].filter(Boolean).join(', ');
}

module.exports = {
  CITY_ALIASES, COUNTRY_ALIASES,
  clean, canonicalCity, canonicalCountry,
  resolvePlace, placeById, displayName
};
