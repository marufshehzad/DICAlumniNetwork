# Map technology

Required by Phase 7B §13 and rewritten in Phase 7G, when the map gained real
country boundaries. What draws the alumni map, what it depends on, and what DIC
has to arrange before production.

**Short version: one 78 KB public-domain file, and nothing else.**

---

## 1. Library and provider

| | |
|---|---|
| **Map library** | **None.** No Leaflet, Mapbox GL, MapLibre, OpenLayers, Google Maps, d3-geo or TopoJSON runtime. Asserted by `tests/phase7g_modals.js`. |
| **Tile provider** | **None.** No raster or vector tiles are requested. No tile server, no usage quota, no attribution obligation. |
| **Geocoding provider** | **None.** Nothing converts an address into coordinates at runtime. |
| **API key** | **None**, in any environment. Nothing to obtain, rotate, escrow, scope or leak. |
| **What draws it** | `js/dashboard.js` — an equirectangular projection (`projectLatLng`), country polygons from a bundled file, a graticule, and alumni badges. |
| **Where boundaries come from** | `assets/geo/boundaries.json`, built once from Natural Earth. |
| **Where alumni positions come from** | The `location_places` table — 99 rows, each a real city with a latitude and longitude. |

The three external scripts the portals load — Chart.js, Lucide and qrcodejs —
are for charts, icons and QR codes. None is involved in the map.

---

## 2. Geometry: source, licence, and what was kept

### Source

**Natural Earth**, 1:110m and 1:10m Admin 0 – Countries.

Obtained through the npm package **`world-atlas@2.0.2`** (ISC, Mike Bostock),
which describes itself as *"a convenient redistribution of Natural Earth's
vector data"*.

### Licence

**Natural Earth is in the public domain.**

> "All versions of Natural Earth raster and vector map data found on this
> website are in the public domain. You may use the maps in any manner,
> including modifying the content and design, electronic dissemination, and
> offset printing."
> — <https://www.naturalearthdata.com/about/terms-of-use/>

There is no attribution requirement, no share-alike obligation and no
redistribution restriction. The packaging library is ISC.

**Both `world-atlas` and `topojson-client` are `devDependencies`.** They are
used once, by `tools/build_geo.js`, and never ship to a browser or a production
install.

GADM was **not** used: its licence forbids commercial redistribution.
OpenStreetMap-derived district boundaries were **not** used: ODbL would add
attribution and share-alike obligations this project does not otherwise carry.

### What was kept, and why so little

`tools/build_geo.js` converts the source once, at build time:

| | Source | Kept |
|---|---|---|
| World countries | 286 rings, 10,587 points | 248 rings, **4,211 points** |
| Bangladesh (1:10m) | 22 rings, 2,257 points | 15 rings, **737 points** |

Coordinates are rounded to 2 decimals for the world (~1 km) and 3 for
Bangladesh (~100 m); rings shorter than a few points or smaller than a pixel at
the drawn scale are dropped; the rest is simplified with Douglas–Peucker. The
result is **78 KB** and visually identical at the sizes rendered.

Regenerate with `node tools/build_geo.js`.

---

## 3. Projection

**Equirectangular (plate carrée).** Longitude maps linearly to x, latitude
linearly to y.

The important property is that **boundaries and alumni markers use the same
projection function**. `countryPath()` and every marker both call
`projectLatLng()`, so a coastline and a badge cannot drift apart — they are one
projection, not two that happen to resemble each other. `tests/phase7g_modals.js`
checks five countries' bounding boxes against independently known values.

Equirectangular distorts area toward the poles. That is acceptable here: this
map answers "which country, and roughly where", not "how large".

---

## 4. The two views

### World

Every country outlined, filled pale, with the alumni badges on top. Country
names appear from 2× zoom, and only where the label fits inside the country —
a label wider than the country it names is a smear across three neighbours, so
it is not drawn.

Levels: **Cities** and **Countries**.

### Bangladesh

Pressing **Bangladesh** frames the country at 8× on its real geographic centre
and swaps the coarse 1:110m outline for the **1:10m** one — 737 points instead
of 18, which is what makes it recognisable rather than a five-sided blob.
Neighbouring countries stay drawn and labelled, so the country is placed in its
region rather than floating.

Level: **Divisions**, aggregated by the server from `location_places.division`.

### Division boundaries are NOT drawn, and that is deliberate

Natural Earth's Admin 0 package contains countries only. No division or
district polygon dataset was available under a licence this project can carry,
and **drawing administrative boundaries from memory would be inventing
geography** — the defect class the whole location effort exists to remove.

So a division is shown as a **labelled badge at the alumni-weighted mean of the
real city coordinates** the database holds for it. That is a statement about
where a division's alumni are, not a claim about where the division's border
runs, and the code says so at the point it is computed.

---

## 5. Where the numbers come from

Every count is a `COUNT(*)` over rows that exist, served by
`GET /api/stats/map`:

- **cities** — grouped by `location_places.id`
- **countries** — grouped by country, with a distinct-city count
- **divisions** — grouped by division, Bangladesh only

The browser never groups personal rows itself; it draws what the server
counted. `tests/phase7g_modals.js` compares every city and division count
against its own SQL.

**Nothing is invented.** No alumni count, coordinate, city, district or country
is fabricated, and an empty map says so in words rather than drawing nothing.

---

## 6. Privacy

Unchanged from Phase 7B, and asserted again in Phase 7G.

| Setting | On the map |
|---|---|
| `public` | Counted in the city, country and division layers |
| `alumni` (the default) | **Not** on the map |
| `private` | **Not** on the map |

`privacy.MAP_VISIBLE_SQL` is `location = 'public'` and gates every one of the
three rollups. Location carries **no staff bypass** — a private location is
withheld from a super administrator exactly as it is from anyone else.

**No exact home coordinates exist anywhere in this system.** A member chooses a
city from a reference list; the map plots the city's coordinates, not theirs.
Street address is a self-only field that the directory, the map and another
member's view of a profile never return.

The map endpoint requires a session. There is no anonymous access.

---

## 7. Accessibility

The map is not the only way to read the data.

- A **ranked list** sits beside it with the same rows and exact counts, and each
  row is a button that selects the same marker.
- The SVG carries `role="img"` and an `aria-label` naming what it shows and
  pointing at the list.
- The level control is a labelled group; each button reports `aria-pressed`.
- Zoom, Focus, Bangladesh and World are labelled buttons.
- The legend states the size scale in words — "Alumni per city · ● 1" — rather
  than relying on an unexplained gradient.

A reader who cannot interpret the map visually still gets country, city,
division and alumni count from the list.

---

## 8. Limitations

- **No division or district boundaries.** See §4. Divisions are labelled points.
- **No streets, satellite imagery, routing or live GPS.** None was asked for and
  none is present; `navigator.geolocation` appears nowhere in the codebase.
- **Equirectangular distorts area** toward the poles.
- **Only public locations appear.** With the platform's default of `alumni`,
  most members are absent from the map until they choose otherwise. The note
  under the map states how many are hidden and why.
- **The world outline is 1:110m.** Small islands are absent by design; they
  would be sub-pixel at the sizes drawn.
- **Country labels appear from 2× zoom** and only where they fit, so a small
  country may be unlabelled until zoomed.
