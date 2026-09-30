/* Build data/parks-data.js (parks with children's playgrounds, by ward) and
 * data/parks-top10.kml (for Google My Maps) for index.html
 *
 *   node scripts/build-parks.js                 (downloads from Overpass)
 *   node scripts/build-parks.js --osm saved.json  (reuses a saved Overpass response)
 *   add --fresh-times to re-ask TfL for every park instead of reusing the previous build's times
 *
 * Needs data/crime-map-data.js (run build-crime-map.js first).
 * Sources (downloaded fresh on each run):
 *   - Parks, playgrounds, play equipment: OpenStreetMap via Overpass API
 *   - Ward boundaries: ONS Wards December 2022 UK BGC
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT_JS = path.join(ROOT, "data", "parks-data.js");
const OUT_KML = path.join(ROOT, "data", "parks-top10.kml");
const TOP = 10;
const SCHOOL = [-0.17918, 51.49933];   // Imperial College, South Kensington (SW7 2AZ) — [lng, lat]
const RADIUS_KM = 20;                  // only ask TfL about parks this close in a straight line
const LIMITS = [30, 40, 60];               // minutes — one KML per limit
const kmlNear = m => path.join(ROOT, "data", m === 30 ? "parks-near-imperial.kml" : "parks-near-imperial-" + m + ".kml");

// Equipment aimed at school-age children rather than toddlers
const JUNIOR = new Set(["structure", "climbingframe", "zipwire", "climbingwall", "climbing", "basketswing", "trampoline",
  "aerialrotator", "rotator", "spinner_bowl", "basketrotator", "rope_traverse", "climbing_slope", "spinning_circle", "net"]);

const OVERPASS = `[out:json][timeout:180];
area["name"="Greater London"]["boundary"="administrative"]->.a;
(
  way["leisure"="park"](area.a);
  relation["leisure"="park"](area.a);
  way["leisure"="playground"](area.a);
  node["leisure"="playground"](area.a);
  node["playground"](area.a);
  way["playground"](area.a);
);
out tags geom;`;
const WARDS_URL = "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Wards_December_2022_Boundaries_UK_BGC/FeatureServer/0/query?where=" +
  encodeURIComponent("LAD22CD LIKE 'E09%'") + "&outFields=WD22CD&outSR=4326&geometryPrecision=5&maxAllowableOffset=0.0001&f=geojson";

// ── geometry helpers ──────────────────────────────────────────
function ringsOf(e) {
  if (e.type === "way" && e.geometry) return [e.geometry.map(p => [p.lon, p.lat])];
  if (e.type === "relation" && e.members) {
    return stitch(e.members.filter(m => m.role !== "inner" && m.geometry).map(m => m.geometry.map(p => [p.lon, p.lat])));
  }
  return [];
}
// Multipolygon outer rings are often split across several ways — join them end to end
function stitch(lines) {
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const rings = [], open = lines.map(l => l.slice());
  while (open.length) {
    let ring = open.shift();
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      const end = ring[ring.length - 1];
      for (let i = 0; i < open.length; i++) {
        const l = open[i];
        if (same(l[0], end)) { ring = ring.concat(l.slice(1)); }
        else if (same(l[l.length - 1], end)) { ring = ring.concat(l.slice(0, -1).reverse()); }
        else continue;
        open.splice(i, 1); grew = true; break;
      }
    }
    if (ring.length > 3) rings.push(ring);
  }
  return rings;
}
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inAny = (pt, rings) => rings.some(r => inRing(pt, r));
function center(e) {
  if (e.type === "node") return [e.lon, e.lat];
  const pts = ringsOf(e).flat();
  return pts.length ? [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length] : null;
}
function dist(a, b) { const k = Math.cos(51.5 * Math.PI / 180); return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320; }
function bbox(rings) {
  const p = rings.flat();
  return [Math.min(...p.map(q => q[0])), Math.min(...p.map(q => q[1])), Math.max(...p.map(q => q[0])), Math.max(...p.map(q => q[1]))];
}
const inBox = (pt, b) => pt[0] >= b[0] && pt[0] <= b[2] && pt[1] >= b[1] && pt[1] <= b[3];
const xml = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

(async function main() {
  global.window = {};
  require(path.join(ROOT, "data", "crime-map-data.js"));
  const D = window.CRIME_MAP;

  // Overpass servers are often busy (429/504) — try the main server and a mirror a few times
  const SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
  // `--osm file.json` reuses a saved Overpass response instead of downloading
  const cacheArg = process.argv.indexOf("--osm");
  let osm = cacheArg > 0 ? JSON.parse(fs.readFileSync(process.argv[cacheArg + 1], "utf8")).elements : null;
  for (let attempt = 0; attempt < 6 && !osm; attempt++) {
    const url = SERVERS[attempt % SERVERS.length];
    try {
      const r = await fetch(url, {
        method: "POST", body: "data=" + encodeURIComponent(OVERPASS),
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "london-crime-map/1.0" }
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      osm = (await r.json()).elements;
    } catch (e) {
      console.warn("Overpass attempt " + (attempt + 1) + " (" + url + ") failed: " + e.message);
      await new Promise(res => setTimeout(res, 15000));
    }
  }
  if (!osm) throw new Error("Overpass unavailable, try again later");
  const wardsGj = await (await fetch(WARDS_URL)).json();
  console.log("OSM elements:", osm.length, "wards:", wardsGj.features.length);

  const equip = osm.filter(e => e.tags && e.tags.playground && e.tags.leisure !== "playground")
    .map(e => ({ kind: e.tags.playground, pt: center(e) })).filter(e => e.pt);
  const playgrounds = osm.filter(e => e.tags && e.tags.leisure === "playground").map(e => {
    const rings = ringsOf(e), pt = center(e);
    if (!pt) return null;
    const items = equip.filter(q => rings.length ? inAny(q.pt, rings) : dist(q.pt, pt) < 40).map(q => q.kind);
    const minA = parseInt(e.tags.min_age, 10), maxA = parseInt(e.tags.max_age, 10);
    const toddlerOnly = !isNaN(maxA) && maxA < 8;
    const ageOk = !isNaN(maxA) && maxA >= 10 && (isNaN(minA) || minA <= 6);
    const junior = [...new Set(items.filter(k => JUNIOR.has(k)))];
    return { pt, junior, older: !toddlerOnly && (ageOk || junior.length >= 2) };
  }).filter(Boolean);
  const parks = osm.filter(e => e.tags && e.tags.leisure === "park" && e.tags.name).map(e => {
    const rings = ringsOf(e);
    return rings.length ? { id: e.type + "/" + e.id, name: e.tags.name, rings, box: bbox(rings), pt: center(e) } : null;
  }).filter(Boolean);
  const wardPolys = wardsGj.features.map(f => {
    const g = f.geometry, rings = g.type === "Polygon" ? [g.coordinates[0]] : g.coordinates.map(p => p[0]);
    return { code: f.properties.WD22CD, rings, box: bbox(rings) };
  });
  const wardOf = pt => { const w = wardPolys.find(w => inBox(pt, w.box) && inAny(pt, w.rings)); return w && w.code; };

  // Parks that contain at least one playground
  const found = {};
  playgrounds.forEach(pg => {
    const park = parks.find(pk => inBox(pg.pt, pk.box) && inAny(pg.pt, pk.rings));
    if (!park) return;
    const f = found[park.id] || (found[park.id] = { name: park.name, osm: park.id, pt: park.pt, ward: wardOf(park.pt) || wardOf(pg.pt), n: 0, older: false, junior: new Set() });
    f.n++;
    if (pg.older) f.older = true;
    pg.junior.forEach(k => f.junior.add(k));
  });

  const byWard = {};
  const list = Object.values(found).filter(p => p.ward && D.wards[p.ward] && D.wards[p.ward].pop);
  list.forEach(p => {
    (byWard[p.ward] || (byWard[p.ward] = [])).push({
      n: p.name, osm: p.osm, lat: +p.pt[1].toFixed(5), lng: +p.pt[0].toFixed(5), pg: p.n, older: p.older ? 1 : 0, eq: [...p.junior]
    });
  });
  Object.values(byWard).forEach(a => a.sort((x, y) => x.n.localeCompare(y.n)));

  // Public-transport time from Imperial (TfL Journey Planner, next Tuesday 10:00) for parks within RADIUS_KM
  const d = new Date(); d.setDate(d.getDate() + ((9 - d.getDay()) % 7 || 7));
  const date = d.toISOString().slice(0, 10).replace(/-/g, "");
  // Reuse times from the previous build (same park, same school) so re-runs only ask TfL about new parks
  const prevT = {};
  try {
    const old = fs.readFileSync(OUT_JS, "utf8").match(/window\.PARKS = ([\s\S]*);\s*$/);
    if (old) Object.values(JSON.parse(old[1]).wards).flat().forEach(p => { if (p.t) prevT[p.osm] = p.t; });
  } catch (e) { /* first run */ }
  const fresh = process.argv.includes("--fresh-times");
  const near = Object.values(byWard).flat().filter(p => dist([p.lng, p.lat], SCHOOL) / 1000 <= RADIUS_KM);
  near.forEach(p => { if (!fresh && prevT[p.osm]) p.t = prevT[p.osm]; });
  const todo = near.filter(p => !p.t);
  console.log("parks within", RADIUS_KM, "km:", near.length, "| reused times:", near.length - todo.length);
  console.log("TfL journeys to query:", todo.length, "(departing " + date + " 10:00)");
  for (const p of todo) {
    const url = "https://api.tfl.gov.uk/Journey/JourneyResults/" + SCHOOL[1] + "," + SCHOOL[0] + "/to/" + p.lat + "," + p.lng +
      "?date=" + date + "&time=1000&timeIs=Departing";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url);
        if (r.status === 429) { await new Promise(res => setTimeout(res, 20000)); continue; }
        const j = await r.json();
        const mins = (j.journeys || []).map(x => x.duration).filter(Boolean);
        if (mins.length) p.t = Math.min(...mins);
        break;
      } catch (e) { await new Promise(res => setTimeout(res, 3000)); }
    }
    await new Promise(res => setTimeout(res, 700));
  }
  LIMITS.forEach(m => console.log("within", m, "min of Imperial:", near.filter(p => p.t <= m).length));
  console.log("no route found:", near.filter(p => !p.t).length);
  console.log("playgrounds:", playgrounds.length, "| parks with a playground:", list.length, "| wards with one:", Object.keys(byWard).length);

  fs.writeFileSync(OUT_JS, "/* Generated by scripts/build-parks.js — do not edit by hand */\nwindow.PARKS = " +
    JSON.stringify({ built: new Date().toISOString().slice(0, 10), wards: byWard }) + ";\n");

  // KML for Google My Maps: top TOP by ward crime per 1,000 residents (all crime)
  const rate = code => D.wards[code].c.all / D.wards[code].pop * 1000;
  const period = D.period.from + " to " + D.period.to;
  const flat = Object.keys(byWard).flatMap(w => byWard[w].map(p => Object.assign({ ward: w }, p)))
    .sort((a, b) => rate(a.ward) - rate(b.ward) || a.n.localeCompare(b.n));
  function writeKml(file, title, intro, rows) {
    const placemarks = rows.map((p, i) => {
      const w = D.wards[p.ward], b = D.boroughs[w.b];
      const desc = [
        "Ward: " + w.name + " (" + b.name + ")",
        "Ward crime: " + rate(p.ward).toFixed(1) + " per 1,000 residents, " + w.c.all + " crimes, " + period,
        p.t ? "Public transport from Imperial (South Kensington): about " + p.t + " min" : "",
        "Playgrounds in park (OpenStreetMap): " + p.pg + (p.eq.length ? " — equipment: " + p.eq.join(", ") : ""),
        "https://www.openstreetmap.org/" + p.osm
      ].filter(Boolean).join("<br>");
      return `    <Placemark>
      <name>${i + 1}. ${xml(p.n)}</name>
      <description><![CDATA[${desc}]]></description>
      <Point><coordinates>${p.lng},${p.lat},0</coordinates></Point>
    </Placemark>`;
    });
    fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xml(title)}</name>
    <description>${xml(intro)} Park and playground data © OpenStreetMap contributors.</description>
${placemarks.join("\n")}
  </Document>
</kml>
`);
    console.log("\n" + title);
    rows.forEach((p, i) => console.log(i + 1, p.n, "|", D.wards[p.ward].name, "/", D.boroughs[D.wards[p.ward].b].name, "|", rate(p.ward).toFixed(1), "/1000,", D.wards[p.ward].c.all, "crimes |", p.t ? p.t + " min" : "", "|", p.eq.join("+")));
  }
  writeKml(OUT_KML, "Parks with playgrounds in London's safest wards",
    "Top " + TOP + " parks containing a children's playground, ranked by the ward's recorded crime per 1,000 residents (Met Police, " + period + ").",
    flat.slice(0, TOP));
  LIMITS.forEach(m => writeKml(kmlNear(m), "Parks with playgrounds within " + m + " min of Imperial",
    "Parks containing a children's playground within about " + m + " minutes by public transport from Imperial College South Kensington (TfL Journey Planner, weekday 10:00), ranked by the ward's recorded crime per 1,000 residents (Met Police, " + period + ").",
    flat.filter(p => p.t && p.t <= m).slice(0, TOP)));
  console.log("wrote", OUT_JS, OUT_KML, LIMITS.map(kmlNear).join(" "));
})().catch(e => { console.error(e); process.exit(1); });
