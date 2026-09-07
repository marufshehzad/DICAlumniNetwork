#!/usr/bin/env node
/* ============================================================
   DIC ALUMNI PLATFORM — GEOGRAPHY BUILD  (Phase 7G)

   Converts Natural Earth's country boundaries into the smallest static asset
   the alumni map can draw, ONCE, at build time. The browser then loads a plain
   JSON file and needs no mapping library at all — no d3-geo, no topojson, no
   tiles, no API key, no request to anybody's server.

   SOURCE AND LICENCE
     Natural Earth 1:110m and 1:10m Admin 0 – Countries.
     Natural Earth is in the PUBLIC DOMAIN: "you may use the maps in any manner,
     including modifying the content and design, electronic dissemination, and
     offset printing" — https://www.naturalearthdata.com/about/terms-of-use/
     Obtained through the npm package `world-atlas` (ISC, Mike Bostock), which
     describes itself as "a convenient redistribution of Natural Earth's vector
     data". Both are dev-only dependencies; neither ships to the browser.

   WHAT IS KEPT, AND WHY SO LITTLE
     Only what the map draws: ring coordinates in plain longitude/latitude, so
     the client projects them with the SAME projectLatLng() it already uses for
     alumni markers. Boundaries and markers therefore cannot drift apart — they
     are the same projection, not two that happen to look similar.

     Coordinates are rounded: 2 decimals for the world (~1 km, far finer than a
     900px world map can show) and 3 for Bangladesh (~100 m). Rings shorter than
     a few points, and islands too small to be a pixel, are dropped. The result
     is a fraction of the source and visually identical at the sizes drawn.

   Usage:  node tools/build_geo.js
   ============================================================ */

const fs = require('fs');
const path = require('path');
const topojson = require('topojson-client');

const REPO = path.join(__dirname, '..');
const OUT_DIR = path.join(REPO, 'assets', 'geo');

const round = (n, dp) => Number(n.toFixed(dp));

/* A ring worth drawing: enough points to have a shape, and enough extent to be
   more than a speck at the sizes this map renders. */
function keepRing(ring, minPoints, minSpanDeg) {
  if (ring.length < minPoints) return false;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return (maxX - minX) >= minSpanDeg || (maxY - minY) >= minSpanDeg;
}

/* Douglas–Peucker, so a coastline keeps its recognisable shape while shedding
   the points that land inside the same pixel. */
function simplify(ring, tolerance) {
  if (ring.length < 4) return ring;
  const sqTol = tolerance * tolerance;
  const sqSegDist = (p, a, b) => {
    let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; }
      else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p[0] - x; dy = p[1] - y;
    return dx * dx + dy * dy;
  };
  const out = [];
  const step = (first, last) => {
    let maxSq = sqTol, index = -1;
    for (let i = first + 1; i < last; i++) {
      const sq = sqSegDist(ring[i], ring[first], ring[last]);
      if (sq > maxSq) { index = i; maxSq = sq; }
    }
    if (index > 0) { step(first, index); out.push(ring[index]); step(index, last); }
  };
  out.push(ring[0]);
  step(0, ring.length - 1);
  out.push(ring[ring.length - 1]);
  return out.sort((a, b) => ring.indexOf(a) - ring.indexOf(b));
}

function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

function build(sourceFile, { dp, tolerance, minPoints, minSpan, filter, label }) {
  const topo = JSON.parse(fs.readFileSync(path.join(REPO, 'node_modules', 'world-atlas', sourceFile), 'utf8'));
  const geo = topojson.feature(topo, topo.objects.countries);

  const features = [];
  let ringsIn = 0, ringsOut = 0, ptsIn = 0, ptsOut = 0;

  for (const f of geo.features) {
    const name = (f.properties && f.properties.name) || '';
    if (filter && !filter(f, name)) continue;

    const rings = [];
    for (const ring of ringsOf(f.geometry)) {
      ringsIn++; ptsIn += ring.length;
      if (!keepRing(ring, minPoints, minSpan)) continue;
      const thin = simplify(ring, tolerance);
      if (thin.length < minPoints) continue;
      rings.push(thin.map(([x, y]) => [round(x, dp), round(y, dp)]));
      ringsOut++; ptsOut += thin.length;
    }
    if (rings.length) features.push({ id: String(f.id), name, rings });
  }

  console.log(`  ${label}: ${features.length} features, ` +
              `${ringsOut}/${ringsIn} rings, ${ptsOut}/${ptsIn} points ` +
              `(${Math.round(100 - ptsOut / ptsIn * 100)}% fewer)`);
  return features;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

console.log('\nBuilding alumni-map geometry from Natural Earth\n');

/* World: every country, coarse. Drawn at roughly 900px wide, so a degree is
   about 2.5px and 0.35° of simplification is invisible. */
const world = build('countries-110m.json', {
  dp: 2, tolerance: 0.35, minPoints: 5, minSpan: 1.2, label: 'world 110m'
});

/* Bangladesh: the country the institution is in, so it is worth the finer
   source and a tighter tolerance — this outline is what makes the focused view
   recognisable rather than a blob. */
const bd = build('countries-10m.json', {
  dp: 3, tolerance: 0.01, minPoints: 6, minSpan: 0.05, label: 'Bangladesh 10m',
  filter: (f, name) => name === 'Bangladesh'
});

const payload = {
  /* Recorded in the file itself, so the provenance travels with the data and
     not only in a document somebody has to go and find. */
  source: 'Natural Earth 1:110m and 1:10m Admin 0 – Countries',
  licence: 'Public domain — https://www.naturalearthdata.com/about/terms-of-use/',
  via: 'npm world-atlas@2.0.2 (ISC), a redistribution of Natural Earth',
  generated: new Date().toISOString().slice(0, 10),
  note: 'Longitude/latitude rings. Projected in the browser by the same ' +
        'projectLatLng() that positions alumni markers, so boundaries and ' +
        'markers share one coordinate system.',
  world,
  bangladesh: bd
};

const out = path.join(OUT_DIR, 'boundaries.json');
fs.writeFileSync(out, JSON.stringify(payload));
const kb = Math.round(fs.statSync(out).size / 1024);
console.log(`\n  wrote assets/geo/boundaries.json — ${kb} KB\n`);
