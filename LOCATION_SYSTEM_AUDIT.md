# Location System — complete audit

**Type:** read-only discovery. No application code, schema, migration or
business data was changed to produce this document.

**One disclosed side effect.** Establishing the role-visibility matrix in §5 and
§12 required signing in as each of the five roles. Signing in writes no audit
entry, but it does stamp session bookkeeping on the account
(`UPDATE users SET last_login_at = NOW(), failed_login_count = 0,
locked_until = NULL`, `server.js:616`) for those five seeded accounts. No
location column, no profile, no event, job, chapter or audit row was written,
read-modified or deleted. Every other probe was a `SELECT` or a `GET`. Recorded
here rather than claiming an absolute that would not be true.
**Date:** 2026-09-02
**Baseline:** commit `b9c881a`, immediately after Phase 5A.
**Method:** repository search, live schema inspection, direct SQL against
`dic_alumni_db`, authenticated API probes as all five roles, and observation of
the running application in a browser.

Every claim below is followed by the evidence for it. Where something could not
be established, it says so rather than guessing.

---

## Executive summary

The system presents an "Alumni Global Map" with the subtitle *"Privacy-preserving
regional clustering · Opt-in location"* and a *"Share My Location"* toggle.

Behind that:

- **No coordinates exist anywhere.** Not in the schema, not in the code, not in
  any payload.
- **No map library exists.** No Leaflet, Mapbox, Google Maps, OpenStreetMap or
  tiles. The world map is an **empty `<svg>`** over a gradient rectangle.
- **The user cannot enter their own city or country.** There is no such input in
  the profile editor.
- **Both account-creation paths hardcode `'Dhaka','Bangladesh'`** into every new
  alumni profile — self-registration and bulk import alike.
- **The "Share My Location" toggle does nothing.** It is
  `onclick="this.classList.toggle('active')"` with no handler behind it.
- **Two of the three location filter chips return zero results**, and country is
  not searchable at all.

The location data the map displays is therefore not observed, not entered, and
not correctable by the person it describes. It is a constant.

Nothing here leaks a home address: the endpoints genuinely do not return one.
The defect is not exposure — it is **fabrication**.

---

## 1. Current location architecture

There is no single location system. There are **five unrelated ones**, sharing
no model, no vocabulary and no code.

| # | System | Storage | Structured? | Coordinates | Used by |
|---|---|---|---|---|---|
| 1 | Alumni location | `alumni_profiles` — 8 columns | Partly (city/country/district/division separate) | No | Directory, map, profile |
| 2 | Event venue | `events.venue` | No — one free-text line | No | Events |
| 3 | Event logistics/meetings | `event_logistics.location`, `event_meetings.location`, `event_proposals.venue` | No | No | Event planner |
| 4 | Job location | `jobs.location` | No — one free-text line | No | Job board |
| 5 | Chapter location | **none** — implied by `chapters.name` text and `type='regional'` | No | No | Chapters |

They should not be merged reflexively; §14 of the brief is right to keep them
apart. A person's residence, a venue's address, an employer's office and a
regional group's catchment are different things with different privacy weights.

**Evidence** — every location-ish column in the database:

```
alumni_profiles | present_address   | text
alumni_profiles | permanent_address | text
alumni_profiles | hometown          | varchar(100)
alumni_profiles | city              | varchar(100)
alumni_profiles | district          | varchar(100)
alumni_profiles | division          | varchar(100)
alumni_profiles | country           | varchar(100)  DEFAULT 'Bangladesh'
alumni_profiles | postal_code       | varchar(20)
event_logistics | location          | varchar(255)
event_meetings  | location          | varchar(255)
event_proposals | venue             | varchar(255)  DEFAULT 'DIC Main Campus Auditorium'
events          | venue             | varchar(255)  NOT NULL
jobs            | location          | varchar(150)
```

Repository keyword sweep (excluding `node_modules`):

```
latitude 0   longitude 0   lat 0   lng 0
geocode 0    current_location 0    location_url 0
marker 5     cluster 21   coordinates 1
```

---

## 2. Current location database model

### Alumni (`alumni_profiles`)

| Column | Type | Required | Default | Who can edit | Who can see | Normalized | Filled (of 14) |
|---|---|---|---|---|---|---|---|
| `city` | varchar(100) | Optional | *(none — but hardcoded on insert)* | **Nobody via UI**; API accepts it | Every signed-in user | No | **14 (100%)** |
| `country` | varchar(100) | Optional | `'Bangladesh'` | **Nobody via UI**; API accepts it | Every signed-in user | No | **14 (100%)** |
| `district` | varchar(100) | Optional | — | **No writer at all** | Self only | No | 1 (7%) |
| `division` | varchar(100) | Optional | — | **No writer at all** | Self only | No | 1 (7%) |
| `hometown` | varchar(100) | Optional | — | **No writer at all** | Self only | No | 1 (7%) |
| `postal_code` | varchar(20) | Optional | — | **No writer at all** | Self only | No | 1 (7%) |
| `present_address` | text | Optional | — | Self, via profile editor | Self only | No | 1 (7%) |
| `permanent_address` | text | Optional | — | API accepts it; **no UI** | Self only | No | 1 (7%) |

**Example values actually present:** `city`: `Dhaka`, `London`, `New York`.
`country`: `Bangladesh`, `United Kingdom`, `United States`. `district`:
`Comilla`. `division`: `Chittagong`. `postal_code`: `1209`.
`present_address`: `House 42, Road 11, Dhanmondi, Dhaka-1209`.

**Normalization: none.** No `CHECK` constraint, no lookup table, no foreign key,
no index on any location column. Confirmed:

```
Indexes on alumni_profiles: pkey, student_id_key, user_id_key   (that is all)
Constraints:                pkey, user_id_key, student_id_key, user_id_fkey
```

### Latitude / longitude

**They do not exist.** Stated explicitly as §2 requires: there is no `latitude`
column, no `longitude` column, no `geometry`/`geography` type, no PostGIS
extension, and no coordinate value in any payload. `GET /api/stats/map` was
probed for `lat|lng|latitude|longitude` and returned `hasCoordinates: NO`.

---

## 3. Is this actually "real location"?

| | Capability | Status | Evidence |
|---|---|---|---|
| A | User-entered city/country | **MISSING** | No city or country input exists in the profile editor. `handleSaveProfileV2` sends `presentAddress` and no other location field. |
| B | Selection from a controlled list | **MISSING** | No list, table, enum or `CHECK` constraint anywhere. |
| C | Address geocoding | **MISSING** | Zero occurrences of `geocode`. No geocoding service, key or call. |
| D | Latitude / longitude | **MISSING** | Zero occurrences in schema and code. |
| E | Map marker | **PARTIAL / MOCK** | Pins exist, but they are `<div>`s at hardcoded `top`/`left` percentages from a 20-country lookup, not markers at coordinates. |
| F | GPS / browser geolocation | **MOCK** | `navigator.geolocation` appears nowhere. A "Share My Location" toggle exists and is `onclick="this.classList.toggle('active')"` — a CSS class flip with no handler. |
| G | Google Maps / Mapbox / OSM | **MISSING** | No such library, key, tile URL or script tag. Dependencies are `body-parser, cors, express, nodemailer, pg` only. |
| H | Reverse geocoding | **MISSING** | Requires coordinates, which do not exist. |
| I | Location autocomplete | **MISSING** | No autocomplete of any kind. |
| J | Real-time location | **MISSING** | Nothing writes, stores or transmits a live position. |

Nothing in the "implemented" column. The only location capability that genuinely
functions is **a stored free-text city and country string**, and the user cannot
set it.

---

## 4. Alumni Map — complete trace

### Database → API

`GET /api/stats/map` (`server.js:1939`), `requireAuth`. Three aggregate queries:

```sql
SELECT country, COUNT(*) n FROM alumni_profiles
 WHERE country IS NOT NULL AND country <> '' GROUP BY country;

SELECT country, city, COUNT(*) n FROM alumni_profiles
 WHERE city IS NOT NULL AND city <> '' GROUP BY country, city;

SELECT COUNT(*) profiles, ... located, in_bangladesh, international
  FROM alumni_profiles;
```

Response: `{ countries[], cities[], profiles, located, in_bangladesh,
international, chapters }`. **Counts only — no names, no ids, no rows, no
coordinates.** By construction the endpoint cannot identify an individual.

### API → frontend

Two consumers, both in `js/dashboard.js`:

- `renderMapClusters()` (line 487) — reads `res.countries` **only**.
- `generateGeoHeatmap()` (line 583) — reads `res.countries` **only**; renders a
  horizontal bar chart per country. Despite the name, it is not a heat map and
  not on a map.

### Frontend → rendering

```js
const pos = MAP_COUNTRY_POSITIONS[String(c.country).trim().toLowerCase()];
`<div class="map-cluster ..." style="top:${c.pos.top}%;left:${c.pos.left}%">`
```

`MAP_COUNTRY_POSITIONS` (`js/dashboard.js:456`) is a hand-written table of **20
countries** with `top`/`left` percentages — screen positions, not coordinates. A
country outside those 20 cannot be drawn at all; the caption honestly names the
ones it could not place.

### Answers to the specific questions

- **What the API sends:** aggregate counts by country and by city, plus four totals.
- **Country aggregation:** yes, `GROUP BY country`.
- **City aggregation:** yes, `GROUP BY country, city` — computed on every request.
- **Latitude/longitude:** none.
- **How markers are generated:** CSS-positioned `<div>`s from a 20-entry lookup.
- **Are cities rendered?** **No.**
- **Are individual alumni locations rendered?** **No** — only aggregates.
- **Only aggregate locations shown?** **Yes.**

### Re-verification of the previous audit's claim

> *"country-level; cities computed and never rendered"*

**Confirmed, still true at `b9c881a`.** Live evidence from the running map page:

```json
{ "pins": [ {"label":"12","title":"Bangladesh: 12 alumni","top":"42%","left":"68%"},
            {"label":"1","title":"United Kingdom: 1 alumni","top":"26%","left":"45%"},
            {"label":"1","title":"United States: 1 alumni","top":"34%","left":"20%"} ],
  "worldSvgChildCount": 0,
  "worldSvgInnerLength": 0,
  "anyCityTextOnPage": "no" }
```

### One thing the previous audit did not report

`index.html:667` contains:

```html
<svg class="world-svg" viewBox="0 0 900 450" id="world-map-svg"></svg>
```

**It is empty, and nothing anywhere populates it** — `world-map-svg` appears in
exactly one other place in the repository, a CSS rule setting `opacity: 0.2`.
Confirmed live: `worldSvgChildCount: 0`.

So there is **no world map**. `.map-canvas` is
`linear-gradient(135deg,#0a1a2e,#0d2040)` — a dark blue rectangle — with two
radial-gradient blobs over it. The pins are positioned as though over a world
map that was never drawn.

---

## 5. Privacy and location exposure

Probed live as all five roles against user 6, a plain alumnus.

### What each role can see

| Field | Unauth | alumni | moderator | dept_admin | univ_admin | super_admin |
|---|---|---|---|---|---|---|
| Any location endpoint | **401** | — | — | — | — | — |
| `country` | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| `city` | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| `district` | — | absent | absent | absent | absent | absent |
| `division` | — | absent | absent | absent | absent | absent |
| `postal_code` | — | absent | absent | absent | absent | absent |
| `present_address` | — | absent | absent | absent | absent | absent |
| `permanent_address` | — | absent | absent | absent | absent | absent |
| `hometown` | — | absent | absent | absent | absent | absent |
| Exact coordinates | — | **do not exist** | | | | |

"absent" means the key is not in the response at all.

### Findings

1. **No anonymous access.** All four location-bearing endpoints returned **401**
   unauthenticated. There is no public location endpoint to enumerate.
2. **Admins see no more location than an alumnus.** `GET /api/alumni/:id` never
   selects the address columns for anybody. (The staff bypass in `canSee()` is
   real but applies only to `email` and `mobile` — confirmed: `dept_admin` and
   above saw the mobile number, `alumni` and `moderator` saw `null`.)
3. **Exact address is visible to its owner only,** through
   `GET /api/profile/me`, which returns the caller's own row.
4. **City and country are visible to every signed-in user and cannot be hidden.**
   In `server.js:1039` and `server.js:1043`:

   ```js
   location: [row.city, row.country].filter(Boolean).join(', ') || null,
   city: row.city,
   ```

   Neither passes through `canSee()`. Every other privacy-bearing field does.
5. **Can a user disable location visibility?** **No.** There is no control, and
   the server would reject one: `PRIVACY_FIELDS = ['email','mobile']` rejects any
   other key outright.

### A misleading privacy badge

`js/profile.js:375` renders, over the Address & Geographical Location section:

```js
<span class="privacy-badge ${priv.address}">${priv.address === 'private' ? 'Private' : 'Alumni Only'}</span>
```

`priv` is `PROFILE_PRIVACY_SETTINGS`, which since Phase 5A holds **only
`mobile` and `email`**. So `priv.address` is `undefined`, the class renders as
the literal string `privacy-badge undefined`, and the badge **always** reads
**"Alumni Only"**.

The address is in fact visible to nobody but its owner. The badge therefore
tells the user their home address is shared with all alumni when it is not —
wrong in the safe direction, but wrong, and it implies a control that does not
exist.

The database default still carries the vestige:

```json
{"cgpa":"private","email":"alumni","github":"public","mobile":"private",
 "address":"private","linkedin":"public"}
```

`address`, `cgpa`, `github` and `linkedin` in that default are **inert** — no
writer can set them and no reader consults them.

### Verdict on §5's instruction

> *"DO NOT expose exact home location publicly unless there is a clear, approved privacy model."*

**Currently satisfied, by omission rather than by design.** No endpoint returns a
street address to anyone but its owner. That protection comes from the SELECT
list, not from a privacy model — so it would be lost the moment someone adds
`ap.*` to that query, exactly as the Phase 5A IDOR defect showed.

> *"recommend aggregate city/country display rather than exact residential coordinates."*

**Agreed, and that is already the shape of the map.** The recommendation for
Phase 5B is to keep it and make it deliberate — see §14.

---

## 6. Location privacy level

| Level | Supported for location? |
|---|---|
| Public | **MISSING** |
| Alumni-only | **MISSING** |
| Private | **MISSING** |

There is no location privacy level of any kind. `PRIVACY_FIELDS` admits only
`email` and `mobile`; anything else is rejected with
`Unknown privacy field: <key>`.

City and country are unconditionally visible to every signed-in user.

### Safest practical behaviour for a college alumni network

Recommended, **not implemented**:

- **Country** — visible to signed-in members by default. Low sensitivity, and it
  is what makes the map worth having.
- **City** — visible to signed-in members, with a per-user switch to reduce it to
  country only. City is where the risk starts for a private individual.
- **District / division** — same control as city; useful for regional chapters.
- **Street address, postal code** — **self and authorised administrators only,
  never in the directory.** Already effectively true; make it explicit.
- **Coordinates** — do not introduce them for people. See §16.
- **Default for existing rows** — the *more* private option. A user who has never
  seen the control has not consented to the looser one.

The two levels the platform already enforces (`public` = signed-in members,
`private` = self and administrators) are sufficient. Adding a third level for
location alone would repeat the mistake Phase 5A corrected: offering a level the
server does not gate.

---

## 7. Location input UX

### How the user enters location today

**They do not.** The live profile editor (`js/profile.js`, `showEditProfileV2`)
contains exactly one location input:

```js
${txt('pf-presentAddress', 'Present Address', p.present_address)}
```

and the save payload sends `presentAddress` and nothing else location-related.

| Input method | Present? |
|---|---|
| Free text | Yes — `Present Address` only |
| Dropdown | No |
| Autocomplete | No |
| Map picker | No |
| Browser geolocation | No |
| City selector | **No** |
| Country selector | **No** |

### Where city and country actually come from

**Hardcoded literals, in both account-creation paths.**

Self-registration — `server.js:673-676`:

```sql
INSERT INTO alumni_profiles (user_id, student_id, batch, passing_year, department,
                             primary_email, mobile_number, blood_group, hsc_group,
                             city, country)
VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,'Dhaka','Bangladesh')
```

Bulk import — `server.js:1700-1704`:

```sql
INSERT INTO alumni_profiles
  (user_id, student_id, batch, passing_year, department, primary_email,
   blood_group, present_address, occupation, current_company, job_title,
   hsc_group, hsc_version, photo_url, facebook, mobile_number, city, country)
VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'Dhaka','Bangladesh')
```

**Every alumnus who signs up, and every alumnus imported from a spreadsheet, is
recorded as living in Dhaka, Bangladesh** — and has no way to correct it,
because no input exists.

The current 14 rows came from seed data (`migrate_alumni.js`, which assigns
Dhaka to ten of them by hand), not from this path — the one import on record
processed 0 records. But this is the live code path by which DIC would onboard
its actual alumni.

### The import template compounds it

`js/admin.js:480` generates a CSV template offering these location columns:

```
PresentAddress, PermanentAddress, Hometown, District, Country
```

The client-side column mapping (`js/admin.js:1235`) recognises **only**
`presentAddress`. `PermanentAddress`, `Hometown`, `District` and `Country` are
parsed from the file and **silently discarded**; `country` is then overwritten
with `'Bangladesh'` and `city` — which the template does not even offer — is set
to `'Dhaka'`.

An administrator can fill in a district and a country for ten thousand alumni and
none of it will be stored.

### Consistency risks (structural, not yet observed)

Current data is too small and too uniform to show variants — 3 cities, 3
countries, no case or spelling collisions. But nothing prevents them:

- **Spelling and case** — `varchar` free text, no constraint, no normalization on
  write. `Dhaka` / `dhaka` / `DHAKA` / `Dhaka City` would all be distinct rows in
  `GROUP BY country, city`, and the map would treat them as separate places.
- **Bangla / English** — the directory detects Bangla input
  (`BANGLA_RANGE = /[ঀ-৿]/`) and shows a badge reading *"Bangla
  detected — searching for this text as typed"*. That is honest: it does **not**
  transliterate. A city stored as `ঢাকা` would never match a search for `Dhaka`,
  and would appear as a separate city in aggregation.
- **District vs division** — both free text, both unused in practice (1 row
  each), with nothing enforcing that `Comilla` is a district and `Chittagong` a
  division. Note also that several Bangladeshi districts and divisions have been
  officially renamed (Comilla/Cumilla, Chittagong/Chattogram); with free text,
  both spellings will accumulate.
- **Country naming** — `United States` vs `USA` vs `US` would be three countries
  on the map, and only one of them is in `MAP_COUNTRY_POSITIONS`.

No live data was modified.

---

## 8. Location data quality

Queried, not altered.

### Distinct countries

| country | n |
|---|---|
| Bangladesh | 12 |
| United Kingdom | 1 |
| United States | 1 |

### Distinct cities

| city | country | n |
|---|---|---|
| Dhaka | Bangladesh | 12 |
| London | United Kingdom | 1 |
| New York | United States | 1 |

### Completeness (14 profiles)

| Column | Filled | % |
|---|---|---|
| `city` | 14 | 100% |
| `country` | 14 | 100% |
| `district` | 1 | 7% |
| `division` | 1 | 7% |
| `hometown` | 1 | 7% |
| `postal_code` | 1 | 7% |
| `present_address` | 1 | 7% |
| `permanent_address` | 1 | 7% |

**Nulls/empties:** zero for city and country; 13 of 14 for everything else.

**Suspicious variants:** none present today. That is a property of a 14-row
seeded dataset, not of any safeguard — see §7.

**The 100% figures are misleading and should not be read as good coverage.**
They are 100% because the value is a constant written by the server, not because
14 people told the system where they live.

### Non-alumni location data quality

`events.venue` contains test residue: `71` (×4) and `V` (×2) alongside real
values like `DIC Main Auditorium`. `venue` is `NOT NULL` with no format
validation, so a single character is accepted as a venue.

`jobs.location`: all 3 rows are `Dhaka`. The job-posting form hardcodes
`value="Dhaka"` into the location input (`js/jobs.js:68`).

---

## 9. Location search and filter

### Alumni — what exists

| Capability | Alumni | Admin | Where |
|---|---|---|---|
| Search by city | **Partial** | Same | Free-text `search` only |
| Filter by country | **No** | **No** | Not a parameter; not in the search predicate |
| Filter by district | **No** | **No** | Not stored usefully, not queried |
| Filter by department + location | **No** | **No** | `dept` exists; location does not |
| Filter by batch + location | **No** | **No** | `batch` exists; location does not |

**API** — `GET /api/alumni` accepts `search, dept, batch, domain, mentor, sort,
limit, offset`. **There is no location parameter.**

**SQL** — city is reachable only inside the general search predicate:

```sql
(LOWER(u.full_name) LIKE $1 OR LOWER(ap.current_company) LIKE $1
 OR LOWER(ap.skills) LIKE $1 OR LOWER(ap.department) LIKE $1
 OR LOWER(ap.job_title) LIKE $1 OR LOWER(ap.city) LIKE $1
 OR CAST(ap.batch AS TEXT) LIKE $1)
```

`ap.country` is **not** in it.

**Indexes** — none on any location column. The predicate uses a leading-wildcard
`LIKE`, which could not use a B-tree index even if one existed.

### UI — and two chips that do not work

`index.html:305` offers filter chips including **Dhaka**, **UK** and **USA**.
`toggleChip` maps them to the free-text `search` parameter
(`js/directory.js:93`). Probed live against the running API:

| Chip / search | Results |
|---|---|
| `dhaka` | **12** ✅ |
| `uk` | **0** ❌ |
| `usa` | **0** ❌ |
| `london` | 1 |
| `new york` | 1 |
| `united kingdom` | **0** |
| `bangladesh` | **0** |

The **UK** and **USA** chips return nothing, because the alumni are stored with
city `London`/`New York` and country `United Kingdom`/`United States`, and
`country` is not searched at all. A user cannot find alumni by country by any
means.

### Jobs — better than alumni

`GET /api/jobs` **does** accept a `location` parameter
(`routes_v2.js:94`, `LOWER(j.location) LIKE %…%`), exposed as a dropdown. But the
dropdown is a hardcoded four-option list — *All / Dhaka / Remote / UK / USA* —
not derived from the data, so a job in Chittagong is unfilterable.

### Admin segmentation — no location at all

`GET /api/segment/count` accepts `batchFrom, batchTo, department, industry,
donor, mentor`. There is **no location criterion**, so staff cannot count or
target alumni by city, district or country — arguably the most natural
institutional use of location data.

---

## 10. Map technology

| Question | Answer |
|---|---|
| Library | **None** |
| Version | n/a |
| Source | n/a |
| API key required | **No** |
| Tile provider | **None** |
| Production licensing | **No implications** — nothing is licensed |
| Internet dependency (map) | **None** |

Runtime dependencies are `body-parser, cors, express, nodemailer, pg`. The only
external browser assets in either portal are **chart.js 4.4.0**, **qrcodejs
1.0.0** and **lucide 0.474.0** from jsDelivr, plus Google Fonts — none of them
map-related. A repository-wide search for `leaflet|mapbox|google.maps|
openstreetmap|maplibre|tile.|arcgis` matched **nothing** outside Google Fonts
URLs.

**What the "map" actually is:** a fixed-height `<div>` with a dark blue linear
gradient, two radial-gradient blobs, an **empty** `<svg>` at 20% opacity, and
absolutely-positioned circular `<div>`s carrying a count, placed by hardcoded
percentages.

This is worth stating plainly because it cuts both ways. It is not a real map —
but it is also **cheap, offline, dependency-free, licence-free and incapable of
leaking a coordinate**, which for a college alumni directory is a defensible
place to be. The problem is that it is *presented* as a map, and that the data
behind it is fabricated.

---

## 11. Performance

| Behaviour | Finding |
|---|---|
| Loads all alumni rows? | **No.** The map loads only aggregates. |
| Loads aggregated locations? | **Yes** — 3 `GROUP BY` queries. |
| Uses clustering? | **No.** "Cluster" here means one circle per country; no clustering algorithm exists. |
| Repeated API calls? | **Yes.** `renderMapClusters()` and `generateGeoHeatmap()` each call `GET /api/stats/map` independently, and both are warmed at boot — the endpoint was observed **2–3 times per page load**, returning identical data. |
| Expensive map tiles? | **No.** No tiles at all. |

At college scale the aggregate queries are trivial — a sequential scan over
`alumni_profiles` grouping by two `varchar` columns. Even at 50,000 alumni this
is milliseconds.

### Practical recommendation

1. **Fetch `/api/stats/map` once per page view** and share the result between the
   two renderers. This is the only performance defect worth fixing, and it is
   small.
2. **Do not add clustering, tiles or a map library** for a dataset of this size.
   Aggregating server-side and drawing a few dozen shapes is the right
   architecture; the missing piece is the map itself, not the scale strategy.
3. If a real map is introduced later, keep the API contract as it is —
   aggregates by place, never rows — so the payload stays constant in size and
   privacy-preserving by construction.

---

## 12. Location security

Probed live, GET only, nothing modified.

| Endpoint | Unauth | alumni | moderator | dept_admin | univ_admin | super_admin |
|---|---|---|---|---|---|---|
| `GET /api/alumni/:id` | **401** | city+country | city+country | city+country | city+country | city+country |
| `GET /api/alumni` (list) | **401** | `location` string | same | same | same | same |
| `GET /api/stats/map` | **401** | aggregates | same | same | same | same |
| `GET /api/profile/me` | **401** | **own row, full** | own row | own row | own row | own row |

### Can these be abused to enumerate addresses or coordinates?

**No, on present evidence.**

- There are no coordinates to enumerate.
- No endpoint returns `present_address`, `permanent_address`, `postal_code`,
  `district`, `division` or `hometown` for anyone other than the caller.
- The map endpoint returns counts, never rows, so it cannot be walked back to a
  person even with unlimited requests.
- There is no public/unauthenticated location surface.

### Residual risks worth recording

1. **City+country can be enumerated for the whole membership** by a signed-in
   alumnus paging `GET /api/alumni` (`limit` capped at 100). For a directory this
   is arguably the point, but it is unbounded by rate limit or privacy setting,
   and the member cannot opt out.
2. **The protection is structural, not declared.** Address columns are safe
   because they are absent from one SELECT list. Phase 5A's IDOR defect was
   precisely a SELECT list behaving differently from what its author assumed. A
   future `SELECT ap.*` in the profile endpoint would expose every address
   column silently, and no test currently asserts against that.
3. **`GET /api/profile/me` returns `ap.*`** — correct today, since it is
   self-only, but it means any column added to `alumni_profiles` is exposed to
   its owner automatically. Fine for the owner; worth knowing.

---

## 13. Event venue location

Audited separately, as instructed.

| Capability | Status | Evidence |
|---|---|---|
| Venue name | **IMPLEMENTED** | `events.venue varchar(255) NOT NULL` |
| Structured address | **MISSING** | One free-text line; no street/city/country split |
| Map link | **MISSING** | No `maps.google`, `geo:`, `openstreetmap` or link markup anywhere |
| Coordinates | **MISSING** | No columns |
| Directions | **MISSING** | Repository search for `directions` matched nothing |

The venue is rendered as escaped text beside a `map-pin` icon
(`js/events.js:563, 600, 681`) — an icon that implies a map and links to nothing.

Three further, separate venue/location fields exist in the planner:
`event_logistics.location`, `event_meetings.location`, and
`event_proposals.venue` (default `'DIC Main Campus Auditorium'`). They are
independent free-text columns with no relationship to `events.venue` or to each
other.

**Recommendation:** do **not** couple event venues to the alumni location model.
A venue is institutional, public by nature, and benefits from exactly the thing
alumni locations should not have — a precise address and a directions link.
Adding `venue_address` plus an outbound map link is low-risk and high-value, and
is the one place a real map would earn its keep.

---

## 14. Job location

| Capability | Status |
|---|---|
| Storage | `jobs.location varchar(150)`, free text, nullable |
| Structured location | **MISSING** |
| Remote / hybrid / on-site | **MISSING** as a field. `jobs.type` is *employment* type (`fulltime`, `internship`, `contract`) — the data holds only `fulltime` and `internship`. "Remote" exists only as a hardcoded option in the location dropdown, i.e. as a *place*. |
| Search / filter | **IMPLEMENTED (API)** — `?location=` with `LIKE`. **PARTIAL (UI)** — hardcoded 4-option dropdown, not data-driven. |
| Consistency with alumni location | **None.** Different column, different table, different width, no shared vocabulary. |

The job-posting form hardcodes `value="Dhaka"` into the location field, so an
unedited posting is recorded as Dhaka — the same failure mode as the profile
path, though here the poster can at least see and change it.

**Recommendation:** keep separate from alumni location. If work-mode matters,
add an explicit `work_mode` (`onsite`/`hybrid`/`remote`) rather than overloading
a place string with the word "Remote".

---

## 15. Chapter location

| Capability | Status |
|---|---|
| City column | **MISSING** |
| Country column | **MISSING** |
| Base location | **MISSING** — implied only by free-text `name` |
| Map | **MISSING** |
| Search by location | **MISSING** |
| Duplicate location data | **None** — there is no location data to duplicate |

`chapters` has: `id, name, type, icon, description, members_count, events_count,
parent_id, status, created_by_id, created_at`. `type` is constrained to
`regional | batch | interest`.

So a chapter can be declared **regional** while the system stores nothing about
which region. Location lives only in prose:

```
DIC Main Campus Chapter       regional
DIC Dhanmondi Branch Alumni   regional
DIC UK & Europe Alumni        regional
```

The map page shows an "Approved Chapters" count (5) beside location statistics,
which implies chapters are part of the location picture. They are not — the
count is `COUNT(chapters WHERE status='approved')` with no geographic component.

**Recommendation:** if regional chapters are to mean anything operationally
(inviting alumni in a region, routing events), a `country` + optional
`city`/`division` on `chapters` is the smallest useful addition — and it should
reuse the same vocabulary as alumni location so the two can be joined.

---

## 16. Real-world college requirement

### What DIC should not have

**No live GPS tracking of alumni. No exact residential coordinates. No
reverse-geocoded home addresses on a shared map.** There is no institutional use
case for a college knowing continuously where its graduates are, and the
liability of holding that data — for a population that includes young women in a
country where address privacy carries real physical risk — is not proportionate
to any benefit an alumni directory gains.

The existing "Share My Location" toggle should be **removed, not wired up**.

### What DIC actually needs location for

Judging by what the platform already tries to do:

1. Show where the alumni community has spread — the map.
2. Let alumni find people near them — directory filtering.
3. Let staff target a region — segmentation, broadcasts, regional chapters.
4. Tell people where an event is — venue, and this one *does* want precision.

All four are served by **place names at a chosen granularity**. None requires a
coordinate for a person.

### Recommended alumni location model

| Level | Field | Granularity | Default visibility |
|---|---|---|---|
| 1 | `country` | Controlled list | Signed-in members |
| 2 | `division` (state/province) | Controlled list, dependent on country | Signed-in members |
| 3 | `district` | Controlled list, dependent on division | Signed-in members |
| 4 | `city` | Controlled list + "other" free text | Signed-in members, user-reducible to district |
| 5 | `present_address`, `postal_code` | Free text | **Self and administrators only** |

- **Controlled lists** for country, division and district. Bangladesh has 8
  divisions and 64 districts — a fixed, small, well-known set that removes the
  entire spelling-variant problem at the source, in both English and Bangla.
- **Approximate location only** for display: the map and directory should read
  levels 1–4 and never levels 5.
- **One privacy control**, reusing the two levels the server already enforces.
- **No coordinates for people.** If the map ever needs to place a city, geocode
  the *city* once into a lookup table — a city's coordinates are public
  knowledge and reveal nothing about a person.

That last point is the key architectural insight: **the platform needs
coordinates for places, not for people.** A table of ~100 cities with
coordinates would let a real map render city-level pins with no personal data
involved at all.

---

## 17. Missing location features

| Feature | Current | Missing | Priority | Recommendation |
|---|---|---|---|---|
| **City/country input for the user** | Nothing — hardcoded `'Dhaka','Bangladesh'` | The entire input path | **P0** | Add country + city to the profile editor. Without this every other item is decoration. |
| **Stop hardcoding location on insert** | Both create paths write a literal | Honest NULLs | **P0** | Leave location NULL until the alumnus supplies it; show "Not set". |
| **Bulk-import location columns** | Template offers 5, backend accepts 1, 4 discarded | Column mapping | **P0** | Either map `Country/District/Hometown/PermanentAddress` through, or remove them from the template. Silently dropping admin-entered data is worse than not offering it. |
| **Location privacy level** | None | Public / private for location | **P1** | Add `location` to `PRIVACY_FIELDS` and gate `city` in `canSee()`. |
| **Fix the privacy badge** | Always reads "Alumni Only" from an undefined value | Correct state | **P1** | Drive it from a real setting, or remove it. |
| **Remove the "Share My Location" toggle** | Fake control, no handler | — | **P1** | Delete it. It promises geolocation that does not exist. |
| **Fix / remove broken filter chips** | UK and USA return 0 results | Working country filter | **P1** | Add a real `country` parameter; make chips data-driven. |
| **Country in the search predicate** | Absent | `ap.country` in the `LIKE` | **P1** | One line; makes country searchable at all. |
| **Structured city/country (controlled list)** | Free text, no constraint | Lookup tables | **P1** | 8 divisions + 64 districts for Bangladesh; ISO country list. |
| **Location filter on the directory** | Free-text search only | `?country=`, `?city=` | **P1** | With an index once the lists are controlled. |
| **Admin location segmentation** | No location criterion | Location in `/api/segment` | **P2** | Natural institutional need; trivial once fields are structured. |
| **City markers on the map** | Cities computed, never rendered | Rendering + city coordinates | **P2** | Needs a city→coordinate lookup; only worthwhile with a real map. |
| **A real map** | Empty `<svg>` over a gradient | Any map at all | **P2** | If added, a self-hosted static SVG world map avoids all tile-licensing and internet dependency. |
| **Event venue address + directions** | Venue name only | Address, map link | **P2** | The one place precision genuinely helps attendees. |
| **Chapter base location** | None | `country`/`city` on chapters | **P2** | Makes `type='regional'` mean something. |
| **De-duplicate the map API call** | Called 2–3× per load | Shared fetch | **P3** | Small, safe. |
| **Location autocomplete** | None | — | **P3** | Unnecessary if controlled lists are used. |
| **Geocoding / reverse geocoding** | None | — | **Not recommended** | For places only, if ever. Never for alumni addresses. |
| **GPS / real-time location** | Fake toggle only | — | **Do not build** | No legitimate institutional use case. |

---

## 18. Backend without UI / UI without backend

### A. Location backend exists, UI does not

| Backend capability | UI |
|---|---|
| `EDITABLE_PROFILE_FIELDS.city` — `PUT /api/profile/me` accepts `city` | **No input anywhere** |
| `EDITABLE_PROFILE_FIELDS.country` — accepts `country` | **No input anywhere** |
| `EDITABLE_PROFILE_FIELDS.permanentAddress` | **No input anywhere** |
| `GET /api/stats/map` returns `cities[]` | **Never read by any renderer** |
| `GET /api/jobs?location=` | Partial — hardcoded 4-option dropdown only |

### B. Location UI exists, backend does not

| UI element | Backend |
|---|---|
| **"Share My Location"** toggle (`index.html:657`) | **None.** `onclick="this.classList.toggle('active')"`. No handler, no endpoint, no `navigator.geolocation` in the repository. |
| Page subtitle **"Opt-in location"** | **None.** Location is neither opt-in nor opt-out; it is written by the server and unchangeable. |
| **UK** and **USA** filter chips | Map to free-text search; return **0 results**. |
| Privacy badge on the Address section | Reads an undefined key; always renders "Alumni Only". |
| CSV template columns `PermanentAddress, Hometown, District, Country` | Not mapped client-side, not accepted server-side; **silently discarded**. |
| `<svg id="world-map-svg">` | **Empty.** Nothing populates it. |
| `map-pin` icon beside event venues | No map, no link, no directions. |

### C. Location data exists, no feature uses it

| Data | Used by |
|---|---|
| `alumni_profiles.district` | Nothing — no writer, no reader, no filter. 1 row filled. |
| `alumni_profiles.division` | Nothing. 1 row filled. |
| `alumni_profiles.hometown` | Displayed on the owner's own profile only. No writer. 1 row filled. |
| `alumni_profiles.postal_code` | Displayed on the owner's own profile only. No writer. 1 row filled. |
| `alumni_profiles.permanent_address` | API-writable, no UI; owner-visible only. 1 row filled. |
| `privacy_settings.address` (in the DB default) | **Inert** — no writer, no reader. |
| `cities[]` in the map payload | **Computed on every request, never rendered.** |
| `event_logistics.location`, `event_meetings.location` | Planner only; unrelated to any other location feature. |

---

## 19. Final verdict

> **Does the current DIC Alumni System actually have a complete real-location system?**

# NO

Not "partial". **No.** A location system that cannot accept a location is not an
incomplete location system; it is an absent one with a façade.

The evidence:

1. **The user cannot state where they are.** There is no city or country input in
   the profile editor. This alone is decisive.
2. **The system invents the answer.** Both account-creation paths write the
   literal `'Dhaka','Bangladesh'` into every new profile. Location is not
   collected, not observed, and not correctable — it is manufactured at INSERT
   time and then displayed as fact.
3. **The map has no map.** `<svg id="world-map-svg">` is empty and nothing fills
   it; pins sit at hardcoded percentages over a gradient. No library, no tiles,
   no coordinates.
4. **The controls that imply a location system are fake.** "Share My Location"
   flips a CSS class. "Opt-in location" describes an opt-in that does not exist.
   Two of three location chips return zero results.
5. **Location cannot be searched by country, or filtered at all** in the
   directory, and cannot be segmented by staff.
6. **Four location columns have no writer**, and the map API computes a city
   aggregation that nothing renders.
7. **There is no location privacy control**, and the badge that suggests one
   reads from an undefined value.

What *does* work — and it is worth keeping — is the **shape** of the thing: an
aggregate-only endpoint that returns counts by place and never rows, so no
individual can be located through it. The architecture is privacy-preserving.
The data flowing through it is fiction.

A useful way to hold this: the platform is one honest input form away from
having a real, modest, defensible location system. Everything downstream of that
form already exists in outline.

---

## 20. Recommended final location architecture

Recommendation only. **Nothing below has been implemented.**

```
alumni_profiles
  country_code   CHAR(2)      → ref_countries(code)      -- ISO 3166-1
  division_id    INTEGER      → ref_divisions(id)        -- NULL outside BD
  district_id    INTEGER      → ref_districts(id)        -- NULL outside BD
  city           VARCHAR(100)                            -- list + "other"
  present_address  TEXT       -- self + admin only, never in directory
  postal_code    VARCHAR(20)  -- self + admin only

ref_countries  (code, name_en, name_bn)
ref_divisions  (id, country_code, name_en, name_bn)
ref_districts  (id, division_id, name_en, name_bn)
ref_cities     (id, district_id, name_en, name_bn, lat, lng)   -- place coords ONLY

privacy_settings.location  ∈ {public, private}
```

Principles:

1. **Coordinates belong to places, not people.** `ref_cities.lat/lng` is public
   knowledge and reveals nothing personal. No coordinate is ever stored on a
   person.
2. **Controlled lists eliminate the variant problem at the source**, in both
   English and Bangla, rather than cleaning it up afterwards.
3. **The directory and map read levels 1–4 only.** Street address and postal code
   never leave the owner and administrators.
4. **One privacy control**, reusing the two levels the server already enforces —
   no third level the backend does not gate.
5. **Existing rows default to the more private setting**, since nobody has
   consented to anything yet.
6. **Event, job and chapter location stay separate models.** Only the *reference
   tables* are shared, so vocabularies agree without the models being fused.

---

## 21. Implementation roadmap

Sequenced so that each step is safe on its own. **Not started.**

### Step 0 — Stop writing fiction *(P0, small)*
Remove `'Dhaka','Bangladesh'` from the registration and bulk-import INSERTs.
Leave location NULL. Display "Location not set" — which the directory already
does. **This should precede everything else**, so no further fabricated rows
accumulate.

### Step 1 — Let people say where they are *(P0)*
Add country and city inputs to the profile editor. The API already accepts both
fields; only the form is missing. Ship with the free-text columns as they are.

### Step 2 — Honest UI *(P0/P1, small)*
Remove the "Share My Location" toggle and the "Opt-in location" subtitle. Fix or
remove the address privacy badge. Either map the import template's location
columns through, or remove them from the template.

### Step 3 — Existing data *(P1)*
With Steps 0–2 in place, decide what to do with rows written by the old path.
They cannot be distinguished from genuine Dhaka residents by inspection.
Recommended: prompt each alumnus to confirm their location on next sign-in
rather than mass-editing the database. **This is a decision for DIC, not a
migration to run unilaterally.**

### Step 4 — Structure *(P1)*
Introduce `ref_countries`/`ref_divisions`/`ref_districts`, migrate free text onto
them, add indexes, and convert the inputs to dependent dropdowns.

### Step 5 — Privacy *(P1)*
Add `location` to `PRIVACY_FIELDS`, gate `city` through `canSee()`, and offer the
control in the editor. Default existing rows to the more private option.

### Step 6 — Search and segmentation *(P1/P2)*
Add `country` and `city` parameters to `GET /api/alumni`, put `ap.country` in the
search predicate, make the chips data-driven, and add location to
`/api/segment`.

### Step 7 — A real map, if wanted *(P2)*
Populate `ref_cities.lat/lng`, render city-level aggregates, and replace the
empty `<svg>` with a self-hosted static world map — no tile provider, no API key,
no internet dependency, no licence.

### Step 8 — Venue precision *(P2)*
Event venue address plus an outbound map link and directions. Separate model,
different privacy posture, genuinely wants precision.

---

## Appendix — one observation outside location scope

While tracing role permissions, `server.js:1982` was found to label a capability
*"Read the immutable audit log"* in the RBAC matrix returned by
`GET /api/stats/rbac`. Phase 5A corrected the same overstatement in four other
places; this occurrence was not in that sweep because it lives in `server.js`,
which the Phase 5A regression test does not scan for the word.

The audit trail is hash-chained and append-only, not immutable (`AUDIT_CHAIN.md`
§4). **Not changed** — this audit is read-only — but it should be corrected, and
the Phase 5A test's file list widened to include `server.js`.
