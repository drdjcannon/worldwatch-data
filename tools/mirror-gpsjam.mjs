#!/usr/bin/env node
'use strict';

// GPS interference mirror. Fetches gpsjam.org's daily H3 grid and writes a JSON file the
// WorldWatch iOS app can read with no credentials and no H3 library of its own.
//
// WHY THIS EXISTS, AND IT IS NOT THE CREDENTIAL
//
// gpsjam.org has no key and no quota, so unlike UCDP the app could fetch it directly. The reason
// it does not is the geometry: gpsjam publishes **H3 resolution-4 cell ids**, and turning a cell
// id into a polygon needs the H3 library - an icosahedral gnomonic projection, thousands of lines
// of C, for one map layer. Upstream (worldmonitor) does the same conversion in the browser with
// h3-js. Doing it here instead means the phone reads plain coordinates.
//
// So this mirror trades a daily Action run for a dependency the app never carries. That is the
// whole argument; there is no rate limit being dodged and no token being hidden.
//
// SOURCE
//
//   https://gpsjam.org/data/manifest.csv     date,suspect,num_bad_hexes - last row is the newest
//   https://gpsjam.org/data/{date}-h3_4.csv  hex,count_good_aircraft,count_bad_aircraft
//
// The metric is gpsjam.org's own: pct = bad / (good + bad), the share of aircraft over that cell
// reporting bad GPS accuracy. Bands are upstream's too - low under 2%, medium 2 to 10%, high above
// 10% - transcribed rather than re-derived so the two apps agree about what "high" means.
//
// WHAT IS DROPPED, AND WHY IT IS COUNTED
//
// - **Cells with fewer than `--min-aircraft` (3) aircraft.** One aircraft reporting badly is a
//   100% cell, and a map of those is a map of small samples.
// - **Low-interference cells.** Every populated cell has some bad reports, so keeping them makes a
//   quarter of a million polygons that say "aviation is normal". Medium and high are the signal.
// - **Everything past the cap**, ordered by the *lower bound* of the interference rate rather than
//   by the rate itself. The first real run showed why: ranked by percentage, the file led with
//   three-of-four-aircraft cells at 75% and dropped better-evidenced ones. See `wilsonLowerBound`.
// Both counts are published rather than silently applied: a day when the mirror thins 90% of its
// input looks identical to a quiet day unless the numbers travel with the file. That is this
// project's own "an empty feed must say why" rule applied to a mirror.
//
// ATTRIBUTION
//
// gpsjam.org is one person's site publishing an aggregate derived from ADS-B Exchange, and unlike
// UCDP - which states CC BY 4.0 and grants redistribution outright - it states no licence for reuse
// of its files. The daily schedule runs on the operator's decision, on the precedent that World
// Monitor has consumed the same files daily since July 2026. The payload carries an `attribution`
// string and the app shows it: **gpsjam.org and ADS-B Exchange are both named in the layer's own
// explanation**, which is more than upstream does, where the name appears only in code comments.
//
// Usage:
//   node tools/mirror-gpsjam.mjs --out gpsjam/gps-interference.json
//   node tools/mirror-gpsjam.mjs --out /tmp/x.json --from-file fixture.csv --date 2026-08-23
//   node tools/mirror-gpsjam.mjs --out /tmp/x.json --dry-run

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = 'https://gpsjam.org/data';
// A realistic browser string. This repo's UCDP script learned the same lesson the app did: a
// custom User-Agent gets some hosts to 403.
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const SCHEMA = 1;
// Transcribed from worldmonitor's `_gpsjam-parse.mjs`, not re-derived. Both apps must agree about
// what "high" means or the same cell reads differently in each.
const MEDIUM_THRESHOLD = 2;
const HIGH_THRESHOLD = 10;
const DEFAULT_MIN_AIRCRAFT = 3;
// The app draws these as polygons over a MapKit basemap and thins by viewport, so the file is a
// budget rather than a dump. Worst-first ordering means the cap keeps the cells that matter.
const DEFAULT_MAX_HEXES = 1500;
// gpsjam res-4 cells are about 22 km across, so 0.01 degrees (about 1.1 km) is finer than the data
// and halves the file against 4 decimal places.
const COORDINATE_DECIMALS = 2;

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const minAircraftRaw = Number.parseInt(get('min-aircraft', String(DEFAULT_MIN_AIRCRAFT)), 10);
  return {
    out: get('out', null),
    date: get('date', null),
    fromFile: get('from-file', null),
    dryRun: args.includes('--dry-run'),
    // A typo'd --min-aircraft must not silently disable the low-sample filter, which is the guard
    // that stops a single aircraft becoming a 100% cell.
    minAircraft: Number.isFinite(minAircraftRaw) && minAircraftRaw > 0
      ? minAircraftRaw
      : DEFAULT_MIN_AIRCRAFT,
    maxHexes: Number.parseInt(get('max-hexes', String(DEFAULT_MAX_HEXES)), 10)
      || DEFAULT_MAX_HEXES,
  };
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip, deflate' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    // The body of a 4xx is where the reason lives. Four questions about four providers were
    // settled in one run of the app by reading them.
    const body = (await response.text().catch(() => '')).slice(0, 400);
    throw new Error(`HTTP ${response.status} for ${url}${body ? `: ${body}` : ''}`);
  }
  return response.text();
}

/**
 * The newest date in the manifest.
 *
 * Taken from the **last row** rather than by sorting, because that is the shape gpsjam publishes
 * and upstream reads. A malformed tail is therefore loud: an unparseable date stops the run rather
 * than quietly fetching yesterday's grid and publishing it as today's.
 */
function latestDate(manifestCsv) {
  const rows = manifestCsv.trim().split('\n').filter(Boolean);
  if (rows.length < 2) throw new Error('manifest.csv has no data rows');
  const last = rows[rows.length - 1];
  const date = last.split(',')[0].trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`manifest.csv last row does not start with a date: ${last.slice(0, 80)}`);
  }
  return date;
}

/**
 * The lower bound of the 95% Wilson score interval for bad/total.
 *
 * **This is what the cap is ranked on, and ranking on the raw percentage was wrong.** The first real
 * run published 1,500 of 1,713 candidate cells ordered by percentage, and the top of that list was
 * three-bad-of-four-aircraft cells at 75% while better-evidenced cells - a large share of a hundred
 * aircraft - fell off the end. That is the same defect as scoring recovered text by
 * characters-times-confidence: a metric that rewards a tiny sample buries the finding it was built
 * to surface.
 *
 * Wilson is the standard answer for ranking a rate over small samples: it asks "what is the lowest
 * rate consistent with this evidence", so 3 of 4 (a wide interval) scores about 30% while 45 of 100
 * scores about 36% and outranks it. The **published** figure stays the raw percentage, because that
 * is gpsjam.org's own metric and both apps must agree on it - only the selection changes.
 */
function wilsonLowerBound(bad, total) {
  if (total <= 0) return 0;
  const z = 1.96;
  const p = bad / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return Math.max(0, (centre - margin) / denominator);
}

function band(pct) {
  if (pct > HIGH_THRESHOLD) return 'high';
  if (pct >= MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

/**
 * Turns the hex CSV into published rows.
 *
 * `h3` is injected rather than imported so every decision here - the header lookup, the sample
 * floor, the banding, the ordering, the cap - is testable with no dependency installed. The one
 * thing that genuinely needs h3-js is the geometry, and a fake proves the wiring around it.
 */
function processHexes(csv, { minAircraft, maxHexes, h3 }) {
  const lines = csv.trim().split('\n').filter(Boolean);
  if (lines.length < 2) throw new Error('hex CSV has no data rows');

  // Read the columns by name. Positional reads are how a provider adding a column silently shifts
  // every value - the trap the app's own aircraft-database port hit twice.
  const header = lines[0].split(',').map((name) => name.trim().toLowerCase());
  const hexIndex = header.indexOf('hex');
  const goodIndex = header.indexOf('count_good_aircraft');
  const badIndex = header.indexOf('count_bad_aircraft');
  if (hexIndex < 0 || goodIndex < 0 || badIndex < 0) {
    throw new Error(`unexpected hex CSV header: ${lines[0].slice(0, 120)}`);
  }

  const hexes = [];
  let droppedLowSample = 0;
  let droppedLowInterference = 0;
  let conversionAttempts = 0;
  let conversionFailures = 0;

  for (let index = 1; index < lines.length; index += 1) {
    const columns = lines[index].split(',');
    const id = (columns[hexIndex] || '').trim();
    const good = Number.parseInt(columns[goodIndex], 10);
    const bad = Number.parseInt(columns[badIndex], 10);
    if (!id || !Number.isFinite(good) || !Number.isFinite(bad)) continue;

    const total = good + bad;
    if (total < minAircraft) { droppedLowSample += 1; continue; }

    const pct = (bad / total) * 100;
    const level = band(pct);
    if (level === 'low') { droppedLowInterference += 1; continue; }

    conversionAttempts += 1;
    // Validate before converting: h3-js returns a plausible centroid for garbage that happens to
    // parse as a cell, so an unvalidated row becomes a real-looking hexagon in the wrong place -
    // and never registers as a failure, which defeats the abort guard below. Upstream records
    // exactly this.
    if (!h3.isValidCell(id)) { conversionFailures += 1; continue; }
    let center;
    let ring;
    try {
      const [lat, lon] = h3.cellToLatLng(id);
      center = [round(lon), round(lat)];
      // `true` gives [lng, lat] pairs, which is the order every other geometry file the app reads
      // uses. Getting this backwards puts Paris in Somalia, which is the geojson trap the app
      // documents.
      ring = h3.cellToBoundary(id, true).map(([lng, lat_]) => [round(lng), round(lat_)]);
    } catch {
      conversionFailures += 1;
      continue;
    }
    if (!ring || ring.length < 3) { conversionFailures += 1; continue; }

    hexes.push({
      id,
      level,
      pct: Math.round(pct * 10) / 10,
      badAircraft: bad,
      totalAircraft: total,
      center,
      ring,
      // Not published: it exists to order the cap, and the app has no use for it. Stripped below.
      _confidence: wilsonLowerBound(bad, total),
    });
  }

  // A real upstream format or precision break rather than a handful of bad rows. Guarded on
  // attempts so a day with nothing above the low band cannot divide by zero into a false abort.
  if (conversionAttempts > 0 && conversionFailures > conversionAttempts * 0.5) {
    throw new Error(`over half the H3 conversions failed (${conversionFailures}/`
      + `${conversionAttempts}) - upstream changed format, aborting rather than publishing`);
  }

  // Best-evidenced first, **not** highest percentage and not band-first. The cap is a budget, so it
  // should keep the cells a reader can rely on: a well-sampled 9% cell says more about real
  // interference than a three-aircraft 75% one, and band-first ordering would have kept every tiny
  // "high" ahead of every solid "medium". See `wilsonLowerBound`.
  hexes.sort((a, b) => b._confidence - a._confidence);
  const capped = hexes.slice(0, maxHexes).map(({ _confidence, ...rest }) => rest);

  return {
    hexes: capped,
    stats: {
      rows: lines.length - 1,
      droppedLowSample,
      droppedLowInterference,
      // Named so the app can say "1,500 of 2,310 shown" rather than implying the file is complete.
      droppedOverCap: hexes.length - capped.length,
      conversionFailures,
      // The worst *published* percentage, which after the Wilson ordering is no longer the first
      // row - so it is computed rather than read off the top of the list, where it silently became
      // "the best-evidenced cell's percentage" instead.
      worstPct: capped.reduce((worst, hex) => Math.max(worst, hex.pct), 0),
      // Named so a reader of the file knows which of the two numbers the cap was applied to.
      orderedBy: 'wilson95Lower',
      highCount: capped.filter((hex) => hex.level === 'high').length,
      mediumCount: capped.filter((hex) => hex.level === 'medium').length,
    },
  };
}

function round(value) {
  const factor = 10 ** COORDINATE_DECIMALS;
  return Math.round(value * factor) / factor;
}

async function loadH3() {
  try {
    // The only dependency, and it is the reason this mirror exists at all.
    return await import('h3-js');
  } catch (error) {
    throw new Error('h3-js is not installed. `npm install h3-js` first; the workflow does this '
      + `in its own step. (${error.message})`);
  }
}

async function main() {
  const options = parseArgs(process.argv);
  if (!options.out) {
    console.error('usage: node tools/mirror-gpsjam.mjs --out <path> [--date YYYY-MM-DD] '
      + '[--from-file csv] [--min-aircraft 3] [--max-hexes 1500] [--dry-run]');
    process.exit(2);
  }

  let date = options.date;
  let csv;
  if (options.fromFile) {
    // For running the shaping over a saved grid with no network, which is how this was developed
    // in a sandbox that cannot reach gpsjam.org at all.
    if (!date) throw new Error('--from-file needs --date: the published file states the data date '
      + 'and guessing it would be a false claim about when the measurement was taken');
    csv = readFileSync(options.fromFile, 'utf-8');
    console.log(`read ${options.fromFile} as the grid for ${date}`);
  } else {
    if (!date) {
      date = latestDate(await fetchText(`${BASE_URL}/manifest.csv`));
      console.log(`manifest says the newest grid is ${date}`);
    }
    csv = await fetchText(`${BASE_URL}/${date}-h3_4.csv`);
    console.log(`fetched ${date}-h3_4.csv, ${csv.length} bytes`);
  }

  const h3 = await loadH3();
  const { hexes, stats } = processHexes(csv, {
    minAircraft: options.minAircraft,
    maxHexes: options.maxHexes,
    h3,
  });

  const payload = {
    schema: SCHEMA,
    source: 'gpsjam.org',
    // Carried into the app's UI. gpsjam.org derives its grid from ADS-B Exchange, and both are
    // named wherever the layer appears.
    attribution: 'GPS interference from gpsjam.org, derived from ADS-B Exchange',
    // The date of the **measurement**, not of this run. A daily grid stamped with the run time
    // would claim to be current when the newest grid can be a day behind.
    date,
    generatedAt: new Date().toISOString(),
    thresholds: { mediumPct: MEDIUM_THRESHOLD, highPct: HIGH_THRESHOLD },
    minAircraft: options.minAircraft,
    hexCount: hexes.length,
    stats,
    hexes,
  };

  console.log(`${hexes.length} cells published (${stats.highCount} high, ${stats.mediumCount} `
    + `medium), worst ${stats.worstPct}%`);
  console.log(`dropped: ${stats.droppedLowSample} under ${options.minAircraft} aircraft, `
    + `${stats.droppedLowInterference} low interference, ${stats.droppedOverCap} over the cap, `
    + `${stats.conversionFailures} unconvertible`);

  if (options.dryRun) {
    console.log('dry run, nothing written');
    return;
  }

  const target = resolve(options.out);
  mkdirSync(dirname(target), { recursive: true });
  const serialised = `${JSON.stringify(payload)}\n`;
  // A byte-identical rewrite would make a commit that says the data changed when it did not. The
  // comparison ignores `generatedAt`, which moves on every run by definition.
  if (existsSync(target)) {
    try {
      const previous = JSON.parse(readFileSync(target, 'utf-8'));
      const { generatedAt: _ignored, ...previousRest } = previous;
      const { generatedAt: _also, ...currentRest } = payload;
      if (JSON.stringify(previousRest) === JSON.stringify(currentRest)) {
        console.log('identical to the published file apart from the timestamp, leaving it alone');
        return;
      }
    } catch {
      // An unreadable published file is not a reason to refuse to publish a good one.
    }
  }
  writeFileSync(target, serialised);
  console.log(`wrote ${target}, ${serialised.length} bytes`);
}

// ESM has no `require.main`, so the entry check compares the invoked path with this file's own.
// Without it, importing this module from the test file would run the whole mirror.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`mirror-gpsjam failed: ${error.message}`);
    process.exit(1);
  });
}

export { processHexes, latestDate, band };
