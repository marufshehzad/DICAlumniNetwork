# Map technology

Required by Phase 7B §13. What draws the alumni map, what it depends on, and
what DIC has to arrange before production. Short version: **nothing, and
nothing.**

---

## 1. Library and provider

| | |
|---|---|
| **Map library** | **None.** No Leaflet, Mapbox GL, MapLibre, OpenLayers, Google Maps, D3-geo or TopoJSON. Verified by searching every `.js`, `.html` and `.json` in the repository. |
| **Tile provider** | **None.** No raster or vector tiles are requested, so there is no tile server, no usage quota and no attribution requirement. |
| **Geocoding provider** | **None.** Nothing in this system converts an address into coordinates at runtime. |
| **What actually draws it** | `js/dashboard.js` — an equirectangular projection (`projectLatLng`), a graticule rendered into an inline `<svg>` (`drawMapGraticule`), and cluster badges positioned as ordinary DOM elements (`clusterMapPoints`, `paintMap`). |
| **Where the coordinates come from** | The `location_places` table. 99 rows, each a city with a latitude and longitude, seeded by `migrate_v13.js`. They are properties of *cities*, not of people. |

The three external scripts the portals load — Chart.js, Lucide and qrcodejs —
are for charts, icons and QR codes. None of them is involved in the map.

### Why there are no country outlines

The map draws meridians and parallels, not borders. This project holds no
boundary dataset, and a coastline drawn from memory would be inventing
geography — the same defect class the location work exists to remove. The
graticule is the coordinate system the projection is actually defined against,
so it is honest about what it is showing.

---

## 2. API keys

**None required, in any environment.**

There is no key to obtain, rotate, escrow, scope or leak, and no environment
variable to set. This is worth stating plainly because a map is normally the
one feature that drags a third-party account into a deployment.

---

## 3. Production requirements

**None beyond the application itself.**

| Concern | Status |
|---|---|
| Account with a map provider | not needed |
| Billing / usage quota | none — nothing is metered |
| Outbound network access for tiles | none — nothing is fetched |
| Content-Security-Policy changes | none — no new origin is contacted |
| Offline / air-gapped operation | works; the map is local arithmetic over local rows |
| Attribution block on the page | not required; see §4 |

---

## 4. Licence and terms

Because no tiles, basemap or geocoding service is used, **no map provider's
terms apply to this deployment** and no attribution notice is owed.

The one thing worth recording is the coordinate data itself. The 99 city
coordinates in `location_places` are the published positions of well-known
cities — the kind of fact that appears identically in every atlas and carries
no licensable originality. They are stored as plain numbers in a seed file
(`schema_v13.sql`) rather than pulled from a provider's API, so there is no
API terms-of-service attached to them and no obligation to display a credit.

If a future phase adds a real basemap, that changes: tile providers almost
always require visible attribution, and most require an account. That decision
should be made deliberately, and this section updated with it.

---

## 5. The one external map link, added in Phase 7B

Event venues now offer a **Directions** link (`evDirectionsUrl` in
`js/events.js`). It is the only place the platform points at a map service.

- **Destination:** `openstreetmap.org` — a search URL when only an address or
  venue name is known, or an `?mlat=/?mlon=` pin when the organiser supplied
  coordinates.
- **Why OpenStreetMap:** no API key, no account, no per-request terms, and an
  open data licence. A Google Maps link would work equally well as a URL but
  attaches Google's terms to a page DIC controls.
- **How it behaves:** it is a plain `<a target="_blank" rel="noopener noreferrer">`.
  Nothing is embedded, no script is loaded from the map service, and no request
  is made until a person clicks it. The application's CSP is unaffected because
  no resource is fetched.
- **What is sent:** only the venue name, address or coordinates the organiser
  typed — all of which are already public event information. No alumnus's
  location is ever placed in such a link, and no personal data leaves the page.
- **Derived, never stored:** the URL is built at render time from the event's
  own fields. The database holds no URL column, so there is nothing to
  validate, nothing that can be poisoned into pointing somewhere else, and no
  stored link to go stale.

If DIC would rather not link out at all, deleting `evDirectionsUrl` and its two
call sites removes the feature completely; nothing else depends on it.

---

## 6. Performance characteristics

The map is server-aggregated. `GET /api/stats/map` returns one row per city and
one per country — never a row per alumnus — so the payload is bounded by the
number of *places* people live in, not by the size of the alumni body. A
hundred thousand alumni in fifty cities is fifty rows.

Clustering, zooming and the §7 search all operate on that already-aggregated
payload in the browser, and none of them re-queries the server or recomputes a
count. The numbers on screen are always the ones SQL produced.
