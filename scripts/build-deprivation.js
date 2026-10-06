/* Build data/deprivation-data.js for index.html
 *
 *   node scripts/build-deprivation.js
 *
 * Run after build-parks.js (it reads data/parks-data.js to place each park in a neighbourhood).
 *
 * Sources (all downloaded fresh on each run):
 *   - English Indices of Deprivation 2025, File 7 (MHCLG): IMD score and the Income Deprivation
 *     Affecting Children Index (IDACI) for every 2021 LSOA, with mid-2022 population denominators
 *   - LSOA (2021) → Ward (2022) best-fit lookup (ONS Open Geography Portal)
 *   - Park point → LSOA: nearest postcode via postcodes.io
 *
 * Ward and borough scores are population-weighted means of their LSOAs (IDACI weighted by
 * children aged 0–15), the usual way to roll IMD scores up to bigger areas.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "data", "deprivation-data.js");
const PARKS = path.join(__dirname, "..", "data", "parks-data.js");
const IOD_URL = "https://assets.publishing.service.gov.uk/media/691ded56d140bbbaa59a2a7d/File_7_IoD2025_All_Ranks_Scores_Deciles_Population_Denominators.csv";
const LOOKUP = "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/LSOA21_WD22_LAD22_EW_LU_v3/FeatureServer/0/query";

async function get(url, as, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(r.status + " " + url);
  return as === "json" ? r.json() : r.text();
}

// Quoted fields in this file contain commas and line breaks, so parse character by character
function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.length > 1);
}

function weighted(list, val, wt) {
  let s = 0, w = 0;
  list.forEach(x => { s += val(x) * wt(x); w += wt(x); });
  return w ? s / w : null;
}

(async function main() {
  // 1. IoD 2025, London LSOAs only
  const rows = parseCsv((await get(IOD_URL)).replace(/^﻿/, ""));
  const head = rows[0].map(h => h.replace(/\s+/g, " ").trim());
  const col = name => {
    const i = head.findIndex(h => h.startsWith(name));
    if (i < 0) throw new Error("column not found: " + name);
    return i;
  };
  const C = {
    code: col("LSOA code"), name: col("LSOA name"), la: col("Local Authority District code"),
    imd: col("Index of Multiple Deprivation (IMD) Score"), imdRank: col("Index of Multiple Deprivation (IMD) Rank"),
    idaci: col("Income Deprivation Affecting Children Index (IDACI) Score"),
    pop: col("Total population"), kids: col("Dependent Children aged 0-15")
  };
  const lsoa = {};
  rows.slice(1).forEach(r => {
    if (!r[C.la].startsWith("E09")) return;
    lsoa[r[C.code]] = { name: r[C.name], la: r[C.la], s: +r[C.imd], eng: +r[C.imdRank], ch: +r[C.idaci], pop: +r[C.pop], kids: +r[C.kids] };
  });
  const codes = Object.keys(lsoa);
  // London rank: 1 = most deprived neighbourhood in London
  codes.slice().sort((a, b) => lsoa[b].s - lsoa[a].s).forEach((c, i) => { lsoa[c].lon = i + 1; });
  console.log("London LSOAs:", codes.length, "of", rows.length - 1);

  // 2. LSOA → ward (best fit), paged
  const ward = {};
  for (let off = 0; ; off += 1000) {
    const j = await get(LOOKUP + "?where=" + encodeURIComponent("LAD22CD LIKE 'E09%'") +
      "&outFields=LSOA21CD,WD22CD&orderByFields=LSOA21CD&resultOffset=" + off + "&resultRecordCount=1000&f=json", "json");
    j.features.forEach(f => { ward[f.attributes.LSOA21CD] = f.attributes.WD22CD; });
    if (j.features.length < 1000) break;
  }
  const unmatched = codes.filter(c => !ward[c]);
  console.log("lookup rows:", Object.keys(ward).length, "| LSOAs without a ward:", unmatched.length);

  function roll(key) {
    const groups = {};
    codes.forEach(c => { const k = key(c); if (k) (groups[k] = groups[k] || []).push(lsoa[c]); });
    const out = {};
    Object.keys(groups).forEach(k => {
      const g = groups[k];
      out[k] = {
        s: +weighted(g, x => x.s, x => x.pop).toFixed(2),
        ch: +weighted(g, x => x.ch, x => x.kids).toFixed(3),
        n: g.length
      };
    });
    return out;
  }
  const wards = roll(c => ward[c]);
  const boroughs = roll(c => lsoa[c].la);

  // 3. Parks → LSOA via the nearest postcode (postcodes.io bulk reverse geocode, 100 per request)
  global.window = {};
  require(PARKS);
  const parkList = [];
  Object.values(window.PARKS.wards).forEach(ps => ps.forEach(p => parkList.push(p)));
  const parks = {};
  let miss = 0;
  for (let i = 0; i < parkList.length; i += 100) {
    const batch = parkList.slice(i, i + 100);
    const j = await get("https://api.postcodes.io/postcodes", "json", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geolocations: batch.map(p => ({ latitude: p.lat, longitude: p.lng, radius: 1000, limit: 1 })) })
    });
    j.result.forEach((r, k) => {
      const hit = r.result && r.result[0], code = hit && hit.codes.lsoa21 || hit && hit.codes.lsoa, L = code && lsoa[code];
      if (!L) { miss++; return; }
      parks[batch[k].osm] = { l: L.name, r: L.lon, ch: L.ch };
    });
  }
  console.log("parks:", parkList.length, "| placed in a London LSOA:", Object.keys(parks).length, "| not placed:", miss);

  // Sanity checks against figures checked by hand
  ["Vallance Gardens", "Chicksand Street Park", "Holland Park"].forEach(n => {
    const p = parkList.find(x => x.n === n);
    if (p) console.log(n, parks[p.osm]);
  });

  const data = {
    built: new Date().toISOString().slice(0, 10),
    source: "English Indices of Deprivation 2025 (MHCLG)",
    nLsoa: codes.length,
    wards, boroughs, parks
  };
  fs.writeFileSync(OUT, "/* Generated by scripts/build-deprivation.js — do not edit by hand */\nwindow.DEPRIV = " + JSON.stringify(data) + ";\n");
  console.log("wrote", OUT, (fs.statSync(OUT).size / 1024).toFixed(0) + " KB", "| wards:", Object.keys(wards).length, "| boroughs:", Object.keys(boroughs).length);
})().catch(e => { console.error(e); process.exit(1); });
