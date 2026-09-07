# Map technology

Required by Phase 7B §13, rewritten in Phase 7G when the map gained real country
boundaries, and revised again in the Phase 7G closure pass when it gained real
Bangladesh division and district boundaries. What draws the alumni map, what it
depends on, and what DIC has to arrange before production.

**Short version: one 149 KB file of openly licensed geometry, and nothing else.**

---

## 1. Library and provider

| | |
|---|---|
| **Map library** | **None.** No Leaflet, Mapbox GL, MapLibre, OpenLayers, Google Maps, d3-geo or TopoJSON runtime. Asserted by `tests/phase7g_modals.js`. |
| **Tile provider** | **None.** No raster or vector tiles are requested. No tile server, no usage quota. |
| **Geocoding provider** | **None.** Nothing converts an address into coordinates at runtime. |
| **API key** | **None**, in any environment. Nothing to obtain, rotate, escrow, scope or leak. |
| **What draws it** | `js/dashboard.js` — an equirectangular projection (`projectLatLng`), polygons from a bundled file, a graticule, and alumni badges. |
| **Where boundaries come from** | `assets/geo/boundaries.json`, built once from Natural Earth (world) and geoBoundaries (Bangladesh divisions and districts). |
| **Where alumni positions come from** | The `location_places` table — 99 rows, each a real city with a latitude and longitude. |
| **Attribution obligation** | **Yes**, and it is rendered under the map. See §2. |

The three external scripts the portals load — Chart.js, Lucide and qrcodejs —
are for charts, icons and QR codes. None is involved in the map.

---

## 2. Geometry: sources, licences, and what was kept

Two sources, both openly licensed, both converted once at build time by
`tools/build_geo.js`. Neither ships as a runtime dependency.

### 2a. World countries — Natural Earth

**Natural Earth**, 1:110m and 1:10m Admin 0 – Countries, obtained through the
npm package **`world-atlas@2.0.2`** (ISC, Mike Bostock), a redistribution of
Natural Earth.

**Natural Earth is in the public domain.**

> "All versions of Natural Earth raster and vector map data found on this
> website are in the public domain."
> — <https://www.naturalearthdata.com/about/terms-of-use/>

No attribution requirement, no share-alike, no redistribution restriction.

### 2b. Bangladesh divisions and districts — geoBoundaries

**geoBoundaries gbOpen**, pinned at commit `9469f09`.

| Layer | Features | Licence | Authority | Year |
|---|---|---|---|---|
| **ADM1** — divisions | 8 | **CC0 1.0 Universal** (public domain dedication) | geoBoundaries / Wikimedia Commons | 2015 |
| **ADM2** — districts | 64 | **CC BY 3.0 IGO** | Bangladesh Bureau of Statistics (BBS) / OCHA ROAP, via HDX | 2020 |

Both permit commercial use, modification and redistribution. Crucially
**neither carries share-alike** — which is exactly why these are usable where
the datasets Phase 7G examined were not.

**Attribution IS required**, by CC BY 3.0 IGO and by geoBoundaries' own request
that products name it visibly. It is rendered under the map in `index.html`
(`.map-attribution`) and asserted by `tests/phase7g_modals.js`.

#### How the licence was established

The licence was read from the **geoBoundaries API itself**
(`geoboundaries.org/api/current/gbOpen/BGD/ADM1/` and `.../ADM2/`), not from a
repackager.

That distinction mattered. The npm package `bd-geojson` redistributes this same
Bangladesh data and gives **three inconsistent answers** about its licence: a
blanket `LICENSE-DATA` of ODbL, provenance metadata claiming CC BY 4.0, while
the authoritative API says the district layer is CC BY 3.0 IGO. A licence claim
made by a repackager is only as good as its upstream, so the package was not
used and the sources are fetched from the pinned upstream commit instead.

#### Why Phase 7G concluded otherwise

Phase 7G recorded that no licensable division or district geometry existed and
shipped divisions as labelled points. **That conclusion was wrong.** It was
reached after rejecting GADM (forbids commercial redistribution) and
OSM-derived boundaries (ODbL: attribution *and* share-alike), and geoBoundaries
was not examined. The closure pass found it, verified the terms at source, and
the boundaries are now real.

### What was kept, and why so little

| | Source | Kept |
|---|---|---|
| World countries | 286 rings, 10,587 points | 248 rings, **4,211 points** |
| Bangladesh outline (1:10m) | 22 rings, 2,257 points | 15 rings, **737 points** |
| BD divisions (ADM1) | 23 rings, 2,060 points | 20 rings, **1,027 points** |
| BD districts (ADM2) | 377 rings, 38,112 points | 107 rings, **3,400 points** |

Coordinates are rounded to 2 decimals for the world (~1 km) and 3 for
Bangladesh (~100 m); rings too small to be a pixel at the drawn scale are
dropped; the rest is simplified with Douglas–Peucker. District tolerance is
0.015°, which at the deepest zoom step (16×, ~40px per degree) is 0.6px — below
a pixel, so the shapes are not visibly degraded.

The result is **149 KB**, against a 250 KB budget asserted by the test suite.

Regenerate with `node tools/build_geo.js`. Sources are cached in
`tools/.geocache/` (gitignored); only the built asset is committed.

### Names

geoBoundaries carries the older anglicised spellings. Bangladesh officially
re-romanised several names in 2018 and `location_places` uses the current
forms, so the **geometry is renamed to match the data**, never the reverse:

Chittagong → Chattogram · Barisal → Barishal · Comilla → Cumilla ·
Jessore → Jashore · Bogra → Bogura · Maulvibazar → Moulvibazar

Two further entries are plain misspellings in the source: `Rajshani` → Rajshahi
and `Brahamanbaria` → Brahmanbaria.

`tests/phase7g_modals.js` asserts that **every** division and district present
in `location_places` resolves to a polygon. Without that check a renamed
district would simply never be drawn — a silent blank rather than an error.

---

## 3. Projection

**Equirectangular (plate carrée).** Longitude maps linearly to x, latitude
linearly to y.

The important property is that **boundaries and alumni markers use the same
projection function**. `countryPath()` and every marker both call
`projectLatLng()`, so a coastline and a badge cannot drift apart — they are one
projection, not two that happen to resemble each other.

Two independent checks hold this: five countries' bounding boxes are compared
against known values, and **every Bangladeshi city in `location_places` is
tested to fall geometrically inside its own recorded district**. The second is
the stronger one — the geometry and the alumni data come from unrelated
sources, so agreement between them is real evidence rather than a restatement.

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

Pressing **Bangladesh** frames the country at **16×** on its real geographic
centre, swaps the coarse 1:110m outline for the **1:10m** one, and draws the
real internal boundaries: 64 districts as fine lines, 8 divisions heavier over
them so the larger units read at a glance. Neighbouring countries stay drawn and
labelled, so the country sits in its region rather than floating.

Level: **Divisions**, aggregated by the server from `location_places.division`.

Phase 7G framed this view at 8× on the stated grounds that at 16× the country
would be wider than the canvas. Measured, that is not so: at 16× the projected
bounding box sits fully inside the 900×450 viewBox at 20% of its width and 52%
of its height. At 8× it was 10% by 26% — a thumbnail, which was tolerable when
the outline was the only thing in it and wasteful now that it contains 64 real
district boundaries.

### What the shading means

A district is tinted **only when alumni are actually recorded in it**, and the
count comes from the same server-computed rows that position the badges — so
the shading, the badges and the ranked list cannot disagree. An untinted
district is a real district with nobody in it, which is a true and useful thing
to be able to see.

The division **badge** position remains the alumni-weighted mean of that
division's city coordinates. That is deliberately *not* a centroid and not a
boundary claim: it says "where this division's alumni are". The boundaries are
drawn from the polygons; the badge is drawn from the people.

---

## 5. Where the numbers come from

Every count is a `COUNT(*)` over rows that exist, served by
`GET /api/stats/map`:

- **cities** — grouped by `location_places.id`, carrying division and district
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

Adding district geometry did **not** change what is disclosed. The polygons are
public administrative boundaries that exist independently of this platform; the
only alumni-derived thing drawn on them is the same privacy-gated count that
was already on the map. District shading is computed from rows the server had
already released to the client.

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
- Zoom, Focus, Bangladesh and World are labelled buttons whose labels no longer
  break mid-word on a narrow screen.
- The legend states the size scale in words — "Alumni per city · ● 1" — rather
  than relying on an unexplained gradient.

A reader who cannot interpret the map visually still gets country, city,
division and alumni count from the list.

---

## 8. Interaction

- **Buttons**: zoom in/out, Focus (the busiest place), Bangladesh, World.
- **Mouse wheel** over the map zooms a step, anchored at the pointer. Wheel
  events are accumulated to a 120-unit threshold so a trackpad flick steps once
  rather than racing from world to 16×. The page does not scroll while the
  pointer is over the map, and wheeling anywhere else scrolls normally.
- **Pinch** zooms a step per threshold crossing (1.35 in, 0.74 out), anchored
  between the fingers, with `touch-action: none` on the canvas so the browser
  does not pan the page mid-gesture.

Listeners are attached once per canvas and guarded, because the map is
re-rendered on every visit to the page and two wheel listeners would zoom two
steps per notch.

**Touch zoom is verified in browser emulation only; physical device not yet
verified.**

---

## 9. Limitations

- **No upazila (sub-district) boundaries.** Divisions and districts are drawn;
  the level below them is not. geoBoundaries publishes ADM3, so this is a size
  and usefulness decision rather than a licensing one.
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
- **District boundaries are 2020 vintage** (divisions 2015). Administrative
  boundaries change; these are not live.
