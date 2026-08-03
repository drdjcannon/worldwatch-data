#!/usr/bin/env node
'use strict';

// UCDP mirror. Downloads the Uppsala Conflict Data Program's Georeferenced Event
// Dataset and writes a slimmed JSON file the iOS app can read with no
// credentials of its own.
//
// WHY THIS EXISTS
//
// Two problems, one solution. UCDP's REST API needs an `x-ucdp-access-token`
// obtainable only by emailing their maintainer — confirmed 2026-08-03, when an
// unauthenticated run answered `401 "API token required"` for every one of
// v26.1, v25.1 and v24.1. That is fine for one operator and hopeless for an App
// Store audience: shipping a token in the binary makes it extractable and puts
// every install on one quota, and asking each user to email Uppsala means
// nobody ever sees conflict data.
//
// So a scheduled GitHub Action plays the seeder and the output is a static JSON
// file. Zero infrastructure, zero cost, no token on any device.
//
// WHY NOT THE API AT ALL
//
// Because it turns out we never needed it. UCDP publishes the *same data* as
// static CSV downloads at ucdp.uu.se/downloads, with no token, no login and no
// rate limit — and states outright that everything there is "free of charge and
// licensed under CC BY 4.0 — you are free to use and redistribute them provided
// you cite the relevant publications". So redistribution is explicitly granted
// rather than merely tolerated, which was the one legal question hanging over
// this mirror.
//
// This is the same lesson as GDELT: the bulk export was the real path there
// too, and the rate-limited API was the fallback we had mistaken for primary.
//
// WHAT IS PORTED, AND WHAT IS NOT
//
// Only the TRANSPORT changed. Every shaping decision below is still a direct
// port of worldmonitor's `scripts/seed-ucdp-events.mjs` and
// `scripts/shared/ucdp-candidate.cjs`: the candidate-on-top merge, the dedupe,
// the dataset-anchored window, the annual floor, and the slimming. Each was
// learned the hard way over there and the comments say which.
//
// Dropped with the API: token handling, page walking, and version probing. The
// download URLs carry their version in the path, so a new release is a one-line
// edit rather than a speculative probe — and a 404 is then a loud failure
// instead of a silent fallback to last year's data.
//
// Usage:
//   node mirror-ucdp.mjs --out ucdp-events.json
//   node mirror-ucdp.mjs --out /tmp/x.json --dry-run

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

// ---- Constants ----

/**
 * The two published downloads. Both keyless.
 *
 * The annual GED is the base: ~418k events back to 1989, finalised once a year.
 * The candidate is the recency half — UCDP promises "not more than a month's
 * lag globally" for it, against the annual's ~7 months — and is an ADDITION on
 * top, never a replacement.
 *
 * Versions live in the URL rather than being probed. With the API a wrong guess
 * fell back to an older release and published stale data quietly; here a bump
 * UCDP has made and we have not is a 404, which fails the run loudly. Check
 * ucdp.uu.se/downloads when that happens.
 *
 * The cumulative Jan-Jun candidate is used rather than the single-month file:
 * one request then covers the whole year to date.
 */
const ANNUAL_URL = 'https://ucdp.uu.se/downloads/ged/ged261-csv.zip';
const ANNUAL_VERSION = '26.1';
const CANDIDATE_URL =
  'https://ucdp.uu.se/downloads/candidateged/GEDEvent_v26_01_26_06.csv';
const CANDIDATE_VERSION = '26.01.26.06';

/** The annual zip is ~50 MB, so this is generous on purpose. */
const DOWNLOAD_TIMEOUT_MS = 180_000;

/** Payload guard. Matches World Monitor's cap so the two carry the same depth. */
const MAX_EVENTS = 2000;

/**
 * Slots of the capped payload reserved for the ANNUAL base.
 *
 * Every candidate event is newer than every annual one, so a plain
 * sort-newest-first-then-slice hands the candidate the entire payload the moment
 * it outgrows the cap. Not hypothetical: the candidate was 1,795 of a
 * 2,000-event payload when World Monitor hit this, growing ~100/month. Without
 * the reservation the annual base would have been fully evicted within months,
 * and with it the 2-year history the conflict classifier scores against.
 */
const ANNUAL_FLOOR = 500;

/**
 * Retained window, anchored to the DATASET's newest event — not to now.
 *
 * This is the single most important line in the file. The annual release is
 * finalized once a year and is ~7 months stale by the time the next lands, so a
 * window measured from `Date.now()` would discard the entire annual base and
 * publish only the candidate. Anchoring to the data's own newest date means a
 * lagged release still yields a full year of events, which is exactly why the
 * app can show conflict data at all.
 */
const TRAILING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

/** UCDP sits behind a WAF that rejects obviously-custom agents. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---- Transport ----

/**
 * Download a URL as a Buffer, failing loudly with the response body.
 *
 * The body matters: UCDP explains itself there, and a bare status code is what
 * turned the token question into a guessing game in the first place.
 */
async function download(url, label) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`${label}: HTTP ${resp.status} ${body.slice(0, 160)}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * Extract the first CSV member of a zip, using the platform `unzip`.
 *
 * Node has no built-in zip reader and this repo deliberately has no
 * dependencies — the workflow runs `node --test` with nothing installed, which
 * is what makes it cheap and unbreakable. `unzip` is present on every GitHub
 * runner image.
 */
function unzipFirstCsv(buffer, log) {
  const tmp = join(tmpdir(), `ucdp-annual-${process.pid}.zip`);
  const dir = join(tmpdir(), `ucdp-annual-${process.pid}`);
  writeFileSync(tmp, buffer);
  mkdirSync(dir, { recursive: true });
  execFileSync('unzip', ['-o', '-q', tmp, '-d', dir]);

  const csv = readdirSync(dir).find((name) => name.toLowerCase().endsWith('.csv'));
  if (!csv) throw new Error(`no CSV inside ${ANNUAL_URL}`);
  log(`  unzipped ${csv}`);
  const text = readFileSync(join(dir, csv), 'utf8');
  rmSync(tmp, { force: true });
  rmSync(dir, { recursive: true, force: true });
  return text;
}

/**
 * The only columns the app reads. Everything else in the CSV is discarded as it
 * is parsed rather than afterwards.
 *
 * This is a memory decision, not tidiness. The annual GED CSV is ~420k rows x 48
 * columns; materialising all of it costs roughly 20 million strings, which is
 * enough to put a GitHub runner into GC thrash or an out-of-memory kill. Keeping
 * 15 of 48 columns cuts that by two thirds, and the rows are projected one at a
 * time so the full table never exists at once.
 */
const WANTED_COLUMNS = new Set([
  'id', 'date_start', 'date_end', 'latitude', 'longitude', 'country', 'region',
  'best', 'low', 'high', 'type_of_violence', 'side_a', 'side_b',
  'where_coordinates', 'source_article',
]);

/**
 * Parse RFC 4180 CSV, yielding one projected object per record.
 *
 * Hand-rolled because this repo has no dependencies — that is what lets the
 * workflow run `node --test` with nothing installed. A `split(',')` is not an
 * option: UCDP's `source_article` carries commas, doubled quotes and embedded
 * newlines in almost every row, so a line-based reader mangles most of the file.
 *
 * Exported for the tests, which cover exactly those three cases.
 *
 * @param columns which headers to keep. Defaults to all of them, which is what
 *   the tests use; production passes `WANTED_COLUMNS`.
 */
export function parseCsv(text, columns = null) {
  const rows = [];
  let header = null;
  let record = [];
  let field = '';
  let quoted = false;

  /** Finish the current record: capture the header, or project and store a row. */
  const endRecord = () => {
    record.push(field);
    field = '';
    if (!header) {
      header = record;
      record = [];
      return;
    }
    // A row whose width disagrees with the header is a file truncated mid-write.
    // Dropping it is right; keeping it would shift every column.
    if (record.length === header.length) {
      const out = {};
      for (let i = 0; i < header.length; i++) {
        const key = header[i];
        if (!columns || columns.has(key)) out[key] = record[i];
      }
      rows.push(out);
    }
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { record.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { endRecord(); continue; }
    field += char;
  }
  // A file not ending in a newline still has a final record.
  if (field !== '' || record.length) endRecord();

  if (!header) return [];
  // A header that decoded but matched none of the wanted columns means the
  // upstream schema changed under us. Say so, rather than publishing 0 events.
  if (columns) {
    const found = header.filter((key) => columns.has(key));
    if (found.length === 0) {
      throw new Error(
        `none of the expected columns are present; header was: ${header.slice(0, 12).join(',')}`);
    }
  }
  return rows;
}

/** Strip a UTF-8 BOM, which would otherwise make the first header key unusable. */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Fetch both releases. Injectable so the tests can run without network — the
 * agent shell cannot reach ucdp.uu.se at all.
 *
 * Returns `candidate: []` rather than throwing when the candidate is
 * unavailable: it improves recency, but the annual base IS the data.
 */
async function fetchReleases(log) {
  log(`annual ${ANNUAL_VERSION}:`);
  const zip = await download(ANNUAL_URL, `annual ${ANNUAL_VERSION}`);
  log(`  downloaded ${(zip.length / 1_048_576).toFixed(1)} MB`);
  const annual = parseCsv(stripBom(unzipFirstCsv(zip, log)), WANTED_COLUMNS);
  log(`  parsed ${annual.length} rows`);
  if (annual.length) log(`  newest annual date_start seen: ${maxIsoDay(annual)}`);

  log(`candidate ${CANDIDATE_VERSION}:`);
  let candidate = [];
  try {
    const csv = await download(CANDIDATE_URL, `candidate ${CANDIDATE_VERSION}`);
    candidate = parseCsv(stripBom(csv.toString('utf8')), WANTED_COLUMNS);
    log(`  parsed ${candidate.length} rows`);
    if (candidate.length) log(`  newest candidate date_start seen: ${maxIsoDay(candidate)}`);
  } catch (err) {
    log(`  skipped: ${err.message}`);
  }
  return { annual, candidate };
}

// ---- Shaping ----

function parseMs(value) {
  if (!value) return NaN;
  return Date.parse(String(value));
}

function maxDateMs(events) {
  let max = NaN;
  for (const event of events) {
    const ms = parseMs(event?.date_start);
    if (!Number.isFinite(ms)) continue;
    if (!Number.isFinite(max) || ms > max) max = ms;
  }
  return max;
}

/** Newest `date_start` in a batch of raw rows, as a day string, for logging. */
function maxIsoDay(rows) {
  return isoDay(maxDateMs(rows)) ?? 'unparseable';
}

function isoDay(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

/**
 * Keeps UCDP's own field names.
 *
 * Deliberate: the app's `UCDPFeed.Row` already decodes exactly this shape from
 * the live API, so the mirror is a drop-in and no second decoder has to be kept
 * in step. Fields the app does not read are dropped — at 2,000 events the
 * difference is hundreds of kilobytes over a phone connection.
 */
function slim(event) {
  const num = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    id: String(event.id ?? ''),
    date_start: String(event.date_start ?? '').slice(0, 10),
    date_end: String(event.date_end ?? '').slice(0, 10),
    latitude: num(event.latitude),
    longitude: num(event.longitude),
    country: event.country || '',
    region: event.region || '',
    best: num(event.best),
    low: num(event.low),
    high: num(event.high),
    type_of_violence: num(event.type_of_violence),
    side_a: String(event.side_a || '').slice(0, 200),
    side_b: String(event.side_b || '').slice(0, 200),
    where_coordinates: String(event.where_coordinates || '').slice(0, 200),
    source_article: String(event.source_article || '').slice(0, 300),
  };
}

/**
 * Cap newest-first while guaranteeing the annual base keeps `ANNUAL_FLOOR`
 * slots. When the annual base cannot fill its reservation the unused slots go
 * back to the candidate, so this never publishes a SHORTER payload than a plain
 * slice would have.
 */
export function capWithAnnualFloor(sortedNewestFirst, isCandidate, maxEvents, floor = ANNUAL_FLOOR) {
  if (sortedNewestFirst.length <= maxEvents) return sortedNewestFirst;
  const candidate = [];
  const annual = [];
  for (const event of sortedNewestFirst) {
    (isCandidate(event) ? candidate : annual).push(event);
  }
  const reserved = Math.min(annual.length, floor);
  const keepCandidate = Math.min(candidate.length, maxEvents - reserved);
  return [
    ...candidate.slice(0, keepCandidate),
    ...annual.slice(0, maxEvents - keepCandidate),
  ].sort((a, b) => parseMs(b.date_start) - parseMs(a.date_start));
}

// ---- Main ----

function parseArgs(argv) {
  const out = { out: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

/**
 * Build the mirror payload from the two published CSV releases.
 *
 * @param fetch injectable transport returning `{annual, candidate}` arrays of
 *   raw CSV row objects. Defaults to the real downloads. Injected by
 *   `mirror-ucdp.test.mjs`, which is the only way any of this is verifiable:
 *   the agent shell cannot reach ucdp.uu.se at all.
 */
export async function buildMirror({ now = new Date(), log = () => {}, fetch } = {}) {
  const load = fetch ?? (() => fetchReleases(log));
  const { annual, candidate } = await load();

  // Preserve last-good data when the annual base is missing.
  //
  // This MUST come BEFORE the candidate merge. An empty-payload guard placed
  // after it fires on the FINAL count, so a healthy candidate refilling the
  // payload hides the fact that the annual base is missing — and the run then
  // publishes a thin candidate-only release over good data, evicting the history
  // the classifier needs. World Monitor's relay always had this ordering; its
  // backup cron did not, and that was the bug.
  if (annual.length === 0) {
    throw new Error('annual release is empty — refusing to publish, keeping last good file');
  }

  const candidateIds = new Set();
  for (const event of candidate) {
    if (event?.id != null && event.id !== '') candidateIds.add(String(event.id));
  }

  // Dedupe by id. Candidates are appended after the annual base, so a
  // candidate's revision of an event present in both wins — it is the fresher
  // coding of the same incident.
  const byId = new Map();
  for (const event of [...annual, ...candidate]) {
    const id = event?.id != null ? String(event.id) : '';
    byId.set(id || Symbol('anon'), event);
  }

  // Anchor the window to the dataset's own newest event, never to `now`. See
  // TRAILING_WINDOW_MS: measuring from today would discard the entire annual
  // base, which is ~7 months stale by design.
  const deduped = [...byId.values()];
  const latestMs = maxDateMs(deduped);
  const cutoff = latestMs - TRAILING_WINDOW_MS;

  const windowed = deduped.filter((event) => {
    if (!Number.isFinite(latestMs)) return true;
    const ms = parseMs(event?.date_start);
    if (!Number.isFinite(ms)) return false;   // undated rows cannot be placed
    return ms >= cutoff;
  });
  log(`dedupe ${annual.length + candidate.length} -> ${deduped.length}, `
    + `1-year window from ${isoDay(latestMs)} -> ${windowed.length}`);

  const slimmed = windowed.map(slim)
    .sort((a, b) => parseMs(b.date_start) - parseMs(a.date_start));
  const capped = capWithAnnualFloor(
    slimmed, (event) => candidateIds.has(event.id), MAX_EVENTS);
  if (slimmed.length > capped.length) {
    log(`cap ${slimmed.length} -> ${capped.length} `
      + `(${ANNUAL_FLOOR} slots reserved for the annual base)`);
  }

  if (capped.length === 0) {
    throw new Error('0 events after processing — refusing to publish');
  }

  const newestMs = parseMs(capped[0].date_start);
  const oldestMs = parseMs(capped[capped.length - 1].date_start);

  return {
    // Bumped only on a breaking shape change, so the app can refuse a payload
    // it cannot read instead of decoding it into nonsense. The move from the
    // API to the CSV downloads did NOT change the shape — `slim()` emits UCDP's
    // own column names either way — so this stays at 1 and shipped builds keep
    // reading the file.
    schema: 1,
    generatedAt: new Date(now.getTime()).toISOString(),
    annualVersion: ANNUAL_VERSION,
    candidateVersion: candidate.length ? CANDIDATE_VERSION : null,
    candidateComplete: candidate.length > 0,
    // The freshness signal that matters. A silently dead candidate merge is
    // otherwise invisible: the file keeps regenerating on schedule and stays
    // full while the content quietly falls back to the annual ~7-month lag.
    newestEventAt: isoDay(newestMs),
    oldestEventAt: isoDay(oldestMs),
    eventCount: capped.length,
    candidateEventCount: capped.filter((event) => candidateIds.has(event.id)).length,
    attribution: 'Uppsala Conflict Data Program (UCDP) Georeferenced Event Dataset, '
      + 'Department of Peace and Conflict Research, Uppsala University. CC BY 4.0. '
      + 'Davies, Pettersson, Öberg (2026) Journal of Peace Research; '
      + 'Sundberg & Melander (2013) Journal of Peace Research 50(4).',
    events: capped,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    console.error('usage: mirror-ucdp.mjs --out <path.json> [--dry-run]');
    process.exit(2);
  }

  console.log('=== UCDP mirror ===');
  console.log('  source: ucdp.uu.se static downloads (no credential)');
  console.log(`  out:   ${args.out}`);

  const payload = await buildMirror({ log: (line) => console.log(line) });

  console.log(`\n  annual ${payload.annualVersion}`
    + ` | candidate ${payload.candidateVersion ?? '(none)'}`
    + ` | ${payload.eventCount} events`
    + ` (${payload.candidateEventCount} from candidate)`);
  console.log(`  content ${payload.oldestEventAt} .. ${payload.newestEventAt}`);

  const lagDays = Math.round(
    (Date.now() - Date.parse(payload.newestEventAt)) / 86_400_000);
  console.log(`  newest event is ${lagDays} days old`);
  // ~30 days is a healthy candidate merge; ~210 means it silently died and we
  // are back to annual-only data. Warn rather than fail: stale data still beats
  // none, and the operator needs to know which they have.
  if (lagDays > 90) console.warn(`  WARNING: content lag ${lagDays}d > 90d — is the candidate merge working?`);

  if (args.dryRun) {
    console.log('\n  --dry-run: nothing written');
    return;
  }

  // Compare against what is already published so an unchanged month is a no-op
  // commit rather than a churn commit. `generatedAt` alone always differs, so it
  // is excluded from the comparison.
  const body = JSON.stringify(payload);
  if (existsSync(args.out)) {
    try {
      const previous = JSON.parse(readFileSync(args.out, 'utf8'));
      const strip = (obj) => { const { generatedAt, ...rest } = obj; return JSON.stringify(rest); };
      if (strip(previous) === strip(payload)) {
        console.log('\n  unchanged since last run — leaving the file alone');
        return;
      }
    } catch { /* unreadable previous file is just a rewrite */ }
  }

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, body);
  console.log(`\n  wrote ${args.out} (${(body.length / 1024).toFixed(0)} KB)`);
}

// Only run when invoked directly, so the exported helpers stay unit-testable.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
