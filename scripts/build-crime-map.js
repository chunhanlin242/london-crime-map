/* Build data/crime-map-data.js for index.html
 *
 *   node scripts/build-crime-map.js
 *
 * Sources (all downloaded fresh on each run):
 *   - Crime:      MPS Ward / Borough Level Crime (most recent 24 months), London Datastore
 *   - Population: Census 2021 TS001 usual residents by 2022 ward (Nomis NM_2021_1)
 *   - Boundaries: ONS Wards / LADs December 2022 UK BGC (Open Geography Portal)
 *
 * Period = every month of the latest year present in the crime file (year to date).
 */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "data", "crime-map-data.js");
const DATASET_API = "https://data.london.gov.uk/api/dataset/recorded_crime_summary";
const ONS = "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/";
const WHERE_LONDON = encodeURIComponent("LAD22CD LIKE 'E09%'");
const POP_URL = "https://www.nomisweb.co.uk/api/v01/dataset/NM_2021_1.data.csv?date=latest&geography=TYPE153&c2021_restype_3=0&measures=20100&select=geography_code,obs_value";

// London Plan (2016) sub-regions
const REGIONS = {
  central: ["Camden", "City of London", "Islington", "Kensington and Chelsea", "Lambeth", "Southwark", "Westminster"],
  north:   ["Barnet", "Enfield", "Haringey"],
  east:    ["Barking and Dagenham", "Bexley", "Greenwich", "Hackney", "Havering", "Lewisham", "Newham", "Redbridge", "Tower Hamlets", "Waltham Forest"],
  south:   ["Bromley", "Croydon", "Kingston upon Thames", "Merton", "Richmond upon Thames", "Sutton", "Wandsworth"],
  west:    ["Brent", "Ealing", "Hammersmith and Fulham", "Harrow", "Hillingdon", "Hounslow"]
};


// MPS SubGroup → filter category
const CAT_OF_SUB = {
  "RES BURGLARY OF A HOME": "burglary",
  "RES BURGLARY OF UNCONNECTED BUILDING": "burglary",
  "BURGLARY - RESIDENTIAL": "burglary",
  "ROBBERY OF PERSONAL PROPERTY": "robbery",
  "ROBBERY OF BUSINESS PROPERTY": "robbery",
  "THEFT FROM THE PERSON": "robbery"
};
const CAT_OF_GROUP = { "VIOLENCE AGAINST THE PERSON": "violence", "SEXUAL OFFENCES": "violence" };
const CATS = ["all", "burglary", "violence", "robbery"];

async function get(url, as) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status + " " + url);
  return as === "json" ? r.json() : r.text();
}

function parseCsv(text) {
  return text.trim().split(/\r?\n/).map(line => {
    const out = []; let cur = "", q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  });
}

// Equirectangular projection scaled to a fixed-width viewBox
function makeProjector(features, width) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const k = Math.cos(51.5 * Math.PI / 180);
  eachCoord(features, ([lng, lat]) => {
    const x = lng * k, y = -lat;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  });
  const s = width / (maxX - minX);
  return {
    height: Math.round((maxY - minY) * s),
    params: { k: +k.toFixed(8), minX: +minX.toFixed(8), minY: +minY.toFixed(8), s: +s.toFixed(4) },
    p: ([lng, lat]) => [(lng * k - minX) * s, (-lat - minY) * s]
  };
}
function eachCoord(features, fn) {
  features.forEach(f => rings(f.geometry).forEach(r => r.forEach(fn)));
}
function rings(g) {
  if (g.type === "Polygon") return g.coordinates;
  if (g.type === "MultiPolygon") return g.coordinates.flat();
  return [];
}
function toPath(geom, proj) {
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  const d = rings(geom).map(r => {
    let last = "";
    const pts = [];
    r.forEach(c => {
      const [x, y] = proj.p(c);
      bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y);
      bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y);
      const s = x.toFixed(1) + "," + y.toFixed(1);
      if (s !== last) pts.push(s);
      last = s;
    });
    return pts.length > 2 ? "M" + pts.join("L") + "Z" : "";
  }).join("");
  return { d, bbox: bb.map(v => +v.toFixed(1)) };
}

(async function main() {
  // 1. Crime file: newest "most recent 24 months" ward resource
  const ds = await get(DATASET_API, "json");
  const res = Object.values(ds.resources)
    .filter(r => /^MPS Ward Level Crime\.csv$/.test(r.title))
    .sort((a, b) => String(b.check_timestamp).localeCompare(String(a.check_timestamp)))[0];
  if (!res) throw new Error("ward crime resource not found");
  console.log("crime:", res.url, res.check_timestamp);
  const rows = parseCsv(await get(res.url));
  const head = rows.shift();
  const monthCols = head.map((h, i) => /^\d{6}$/.test(h) ? i : -1).filter(i => i >= 0);
  const lastMonth = head[monthCols[monthCols.length - 1]];
  const year = lastMonth.slice(0, 4);
  const ytd = monthCols.filter(i => head[i].startsWith(year));
  const prev = monthCols.filter(i => head[i].slice(0, 4) === String(+year - 1) && +head[i].slice(4) <= +lastMonth.slice(4));
  console.log("period:", head[ytd[0]], "→", lastMonth, "(" + ytd.length + " months)");

  // 2. Population + boundaries
  const popText = await get(POP_URL);
  const pop = new Map(parseCsv(popText).slice(1).map(r => [r[0], +r[1]]));
  const wardsGj = await get(ONS + "Wards_December_2022_Boundaries_UK_BGC/FeatureServer/0/query?where=" + WHERE_LONDON +
    "&outFields=WD22CD,WD22NM,LAD22CD,LAD22NM&outSR=4326&geometryPrecision=5&maxAllowableOffset=0.0002&f=geojson", "json");
  const ladsGj = await get(ONS + "Local_Authority_Districts_December_2022_UK_BGC_V2/FeatureServer/0/query?where=" + WHERE_LONDON +
    "&outFields=LAD22CD,LAD22NM&outSR=4326&geometryPrecision=5&maxAllowableOffset=0.0002&f=geojson", "json");
  console.log("wards:", wardsGj.features.length, "boroughs:", ladsGj.features.length);

  const proj = makeProjector(ladsGj.features, 1000);
  const groups = [...new Set(rows.map(r => r[0]))].filter(g => !/FRAUD|NFIB/.test(g));

  function blank() { return { c: Object.fromEntries(CATS.map(k => [k, 0])), prev: 0, g: groups.map(() => 0) }; }

  // 3. Boroughs
  const boroughs = {}, codeOfName = {};
  ladsGj.features.forEach(f => {
    const { LAD22CD: code, LAD22NM: name } = f.properties;
    const region = Object.keys(REGIONS).find(k => REGIONS[k].includes(name));
    if (!region) throw new Error("no region for " + name);
    const pth = toPath(f.geometry, proj);
    boroughs[code] = Object.assign(blank(), { name, region, pop: 0, noData: name === "City of London", d: pth.d, bbox: pth.bbox });
    codeOfName[name] = code;
  });

  // 4. Wards
  const wards = {};
  wardsGj.features.forEach(f => {
    const p = f.properties;
    const pth = toPath(f.geometry, proj);
    wards[p.WD22CD] = Object.assign(blank(), { name: p.WD22NM, b: p.LAD22CD, pop: pop.get(p.WD22CD) || 0, d: pth.d, bbox: pth.bbox });
    boroughs[p.LAD22CD].pop += pop.get(p.WD22CD) || 0;
  });

  // 5. Crime counts
  //    Wards come from the ward file. Boroughs come from the borough file, which also
  //    holds the ~3% of offences that could not be placed in a ward.
  function add(t, group, sub, n, np) {
    const gi = groups.indexOf(group);
    if (gi < 0) return;
    const cat = CAT_OF_SUB[sub] || CAT_OF_GROUP[group];
    t.c.all += n; t.prev += np; t.g[gi] += n;
    if (cat) t.c[cat] += n;
  }
  function sums(r, head, cols) { return cols.reduce((a, i) => a + (+r[i] || 0), 0); }

  let orphan = 0;
  rows.forEach(r => {
    const [group, sub, , wardCode] = r;
    if (wards[wardCode]) add(wards[wardCode], group, sub, sums(r, head, ytd), sums(r, head, prev));
    else orphan += sums(r, head, ytd);
  });

  const bRes = Object.values(ds.resources)
    .filter(r => /^MPS Borough Level Crime\.csv$/.test(r.title))
    .sort((a, b) => String(b.check_timestamp).localeCompare(String(a.check_timestamp)))[0];
  console.log("borough crime:", bRes.url, bRes.check_timestamp);
  const bRows = parseCsv(await get(bRes.url));
  const bHead = bRows.shift();
  const bYtd = bHead.map((h, i) => head.indexOf(h) >= 0 && ytd.includes(head.indexOf(h)) ? i : -1).filter(i => i >= 0);
  const bPrev = bHead.map((h, i) => head.indexOf(h) >= 0 && prev.includes(head.indexOf(h)) ? i : -1).filter(i => i >= 0);
  if (bYtd.length !== ytd.length) throw new Error("borough file months differ from ward file");
  let skipped = 0;
  bRows.forEach(r => {
    const [group, sub, bName] = r;
    const t = boroughs[codeOfName[bName]];
    if (!t) { skipped += sums(r, bHead, bYtd); return; } // Aviation Policing / Unknown
    add(t, group, sub, sums(r, bHead, bYtd), sums(r, bHead, bPrev));
  });

  // 6. Checks
  const wardSum = Object.values(wards).reduce((a, w) => a + w.c.all, 0);
  const boroughSum = Object.values(boroughs).reduce((a, b) => a + b.c.all, 0);
  console.log("borough total:", boroughSum, "ward total:", wardSum, "share placed in a ward:", (wardSum / boroughSum * 100).toFixed(1) + "%",
    "| unmatched ward rows:", orphan, "| non-borough rows:", skipped);
  const hf = boroughs[codeOfName["Hammersmith and Fulham"]];
  console.log("H&F:", hf.c, "pop", hf.pop);
  const missingPop = Object.entries(wards).filter(([, w]) => !w.pop && !boroughs[w.b].noData).map(([k, w]) => k + " " + w.name);
  if (missingPop.length) console.warn("wards without population:", missingPop);

  const out = {
    built: new Date().toISOString().slice(0, 10),
    period: { from: head[ytd[0]].replace(/(\d{4})(\d\d)/, "$1-$2"), to: lastMonth.replace(/(\d{4})(\d\d)/, "$1-$2"), months: ytd.length },
    source: { crimeUpdated: String(bRes.check_timestamp).slice(0, 10) },
    wardShare: +(wardSum / boroughSum).toFixed(3),
    width: 1000, height: proj.height,
    cats: CATS, groups,
    regions: Object.fromEntries(Object.keys(REGIONS).map(k => [k, REGIONS[k].map(n => codeOfName[n])])),
    boroughs, wards
  };
  const js = "/* Generated by scripts/build-crime-map.js — do not edit by hand */\nwindow.CRIME_MAP = " + JSON.stringify(out) + ";\n";
  fs.writeFileSync(OUT, js);
  console.log("wrote", OUT, (js.length / 1024).toFixed(0) + " KB");
})().catch(e => { console.error(e); process.exit(1); });
