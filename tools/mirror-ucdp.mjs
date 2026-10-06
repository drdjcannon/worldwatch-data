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
// Dropped with the API: token handling and page walking. Version probing came
// BACK on 2026-10-06, and why is worth reading — see CANDIDATE_FLOOR.
//
// Usage:
//   node mirror-ucdp.mjs --out ucdp-events.json
//   node mirror-ucdp.mjs --out /tmp/x.json --dry-run
//   node mirror-ucdp.mjs --out x.json --allow-stale   # publish past the lag ceiling

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
 * The cumulative year-to-date candidate is used rather than a single-month
 * file: one request then covers the whole year so far.
 */
const ANNUAL_URL = 'https://ucdp.uu.se/downloads/ged/ged261-csv.zip';
const ANNUAL_VERSION = '26.1';

/**
 * How the candidate files are named, measured rather than assumed.
 *
 * **UCDP renamed them, and that is why the mirror froze.** The pinned URL was
 * `GEDEvent_v26_01_26_06.csv`. Probing the downloads page from CI on
 * 2026-10-06 found it still serving, and found the releases after it published
 * as `GEDEvent_v26_0_7.csv` and `GEDEvent_v26_0_8.csv` — a different shape
 * entirely, with an unpadded month. Every `v26_01_26_{07..10}` spelling 404s.
 *
 * So the freeze had two causes stacked, and only one was the pin: the file was
 * pinned, AND the name it was pinned to stopped being the pattern. Incrementing
 * the month in the old name — the obvious fix, and the first one tried here —
 * produces four 404s and changes nothing.
 *
 * `{YY}_0_{M}` is also exactly the shape worldmonitor's `buildCandidateVersions`
 * has always probed for the REST API (`${year}.0.${month}`), which is the hint
 * that was sitting in a local checkout the whole time.
 */
const CANDIDATE_DIR = 'https://ucdp.uu.se/downloads/candidateged/';

/**
 * Months probed, newest first, starting one AHEAD of the current month.
 *
 * Six, matching the window worldmonitor has used for years. One ahead because
 * a release could be labelled by its publication month rather than by the month
 * it covers, and a single extra 404 is cheaper than missing a month. Bounded
 * rather than walking back to a fixed floor, so the number of probes stays
 * constant instead of growing by one every month forever — anything older than
 * six months is the staleness ceiling's problem, not the probe's.
 */
const CANDIDATE_LOOKBACK_MONTHS = 6;

/**
 * The last file published under the OLD naming convention, tried after every
 * modern name has missed.
 *
 * This is the degradation path: a probe that finds nothing falls back to
 * exactly what the mirror served before any of this, rather than to nothing.
 * Note the staleness ceiling will then refuse to publish it, which is correct —
 * reaching this entry means UCDP has renamed the files again.
 */
const LEGACY_CANDIDATE = Object.freeze({
  version: '26.01.26.06',
  url: `${CANDIDATE_DIR}GEDEvent_v26_01_26_06.csv`,
});

/**
 * Hard ceiling on how old the newest published event may be, in days.
 *
 * A green scheduled job is not evidence of fresh data — that is the whole
 * lesson of the 98-day freeze, where nothing in the system could report the
 * problem because nothing checked the DATA's age. The run now refuses to
 * publish past this and fails loudly, which commits the error log.
 *
 * **90 is calibrated against the freeze itself, and the first number I picked
 * was wrong.** 120 looked safe on the two known states — a healthy merge peaks
 * near 58 days (releases land on the 21st covering through the end of the
 * previous month, plus up to a week of our weekly polling, plus slack for UCDP
 * not publishing on a fixed day), and annual-only is ~210. But the live file
 * had been frozen at **99** days for two months, so a 120-day ceiling would
 * have sat silently through the exact failure it exists to catch, for another
 * three weeks. A guard has to be tighter than the bug it is for.
 *
 * At 90 this freeze fails on the first Monday after 2026-09-28 instead of
 * running green indefinitely. The cost is that a genuine two-release slip by
 * UCDP turns the job red; that is the right trade, and `--allow-stale`
 * publishes anyway when an operator has looked and decided.
 */
const MAX_CONTENT_LAG_DAYS = 90;

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
 * 18 of 48 columns cuts that by two thirds, and the rows are projected one at a
 * time so the full table never exists at once.
 *
 * `where_prec`, `date_prec` and `event_clarity` were added 2026-10-06, on
 * UCDP's own instruction to consumers. They are the three codebook fields that
 * say how much a row's coordinate and date may be trusted, and publishing them
 * costs about 46 bytes an event — roughly 10% on a 894 kB payload — against the
 * alternative of drawing province centroids as precise incident pins.
 */
const WANTED_COLUMNS = new Set([
  'id', 'date_start', 'date_end', 'latitude', 'longitude', 'country', 'region',
  'best', 'low', 'high', 'type_of_violence', 'side_a', 'side_b',
  'where_coordinates', 'source_article',
  'where_prec', 'date_prec', 'event_clarity',
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
 * Every candidate release worth trying, NEWEST FIRST.
 *
 * Pure and exported so the generation is testable without network — which
 * matters here more than usual, because ucdp.uu.se is unreachable from the
 * machine this repo is maintained from, so CI is the only place the real URLs
 * are ever exercised.
 *
 * `Date.UTC` with an out-of-range month does the year arithmetic, so December
 * rolls to January without a special case. Upstream had that branch written by
 * hand and its comment records that omitting it "silently narrowed the window
 * to 5 every December".
 */
export function candidateReleases(now = new Date(), lookback = CANDIDATE_LOOKBACK_MONTHS) {
  const out = [];
  for (let offset = 1; offset > 1 - lookback; offset--) {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const yy = month.getUTCFullYear() % 100;
    const mm = month.getUTCMonth() + 1;
    out.push({
      version: `${yy}.0.${mm}`,
      url: `${CANDIDATE_DIR}GEDEvent_v${yy}_0_${mm}.csv`,
    });
  }
  out.push(LEGACY_CANDIDATE);
  return out;
}

/**
 * Take the newest candidate release that resolves.
 *
 * **A parse failure counts as a miss, not an error**, and that is deliberate: a
 * WAF or a CDN answering 200 with an HTML notice is not a 404, and treating it
 * as success would hand `parseCsv` a page of markup. Falling through to the
 * next release turns "the server said something odd" into "that release is not
 * there", which is the same decision from the reader's side.
 *
 * Throws when NOTHING resolves. By this point the annual zip has already
 * downloaded, so the host is demonstrably up and every candidate URL missing
 * means the naming convention moved — which no fallback can paper over and
 * which must not be allowed to publish quietly.
 */
async function fetchCandidate(log, now) {
  const attempts = candidateReleases(now);
  log(`candidate: probing ${attempts.length} releases, newest first`);

  for (const { version, url } of attempts) {
    log(`  try ${url}`);
    let rows;
    try {
      const body = await download(url, `candidate ${version}`);
      rows = parseCsv(stripBom(body.toString('utf8')), WANTED_COLUMNS);
    } catch (err) {
      log(`    miss: ${String(err.message).slice(0, 140)}`);
      continue;
    }
    if (rows.length === 0) {
      log('    miss: resolved but parsed 0 rows');
      continue;
    }
    log(`    TAKEN ${version}: ${rows.length} rows, newest date_start ${maxIsoDay(rows)}`);
    return { version, rows };
  }

  throw new Error(
    `no candidate release resolved. Tried ${attempts.map((a) => a.version).join(', ')} `
    + `— including the ${LEGACY_CANDIDATE.version} legacy file, which served from 2026-06 `
    + 'until UCDP renamed the releases. They have most likely renamed them again; run this '
    + 'workflow with probe=true and read ucdp/last-probe.log for what the downloads page '
    + 'actually lists.');
}

/**
 * Report what UCDP actually publishes, and stop. `--probe`.
 *
 * **This exists because guessing cost a CI round.** The first probe generated
 * `GEDEvent_v26_01_26_{07..10}.csv` by incrementing the month in the known-good
 * floor's name, and all four answered 404 while `26_06` served perfectly — so
 * either UCDP has published nothing since June, or the filename convention is
 * not the one that name suggests. Those are opposite conclusions and no amount
 * of reasoning from here separates them: ucdp.uu.se is unreachable from the
 * machine this repo is maintained from, and only CI can see it.
 *
 * So this asks three questions in one run, cheaply, and prints the answers:
 * what the downloads page links to, whether the candidate directory lists
 * itself, and which of several plausible naming conventions resolve. A miss is
 * a 404 with a few hundred bytes of body, so the whole sweep costs less than
 * one real download.
 */
async function probe(log, now) {
  const show = async (label, url) => {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: '*/*' },
        signal: AbortSignal.timeout(60_000),
      });
      const body = await resp.text().catch(() => '');
      log(`  ${resp.status} ${String(body.length).padStart(8)} B  ${label}`);
      return resp.ok ? body : null;
    } catch (err) {
      log(`  ERR ${label}: ${String(err.message).slice(0, 100)}`);
      return null;
    }
  };

  log('pages:');
  const page = await show('downloads page', 'https://ucdp.uu.se/downloads/');
  await show('candidateged directory', CANDIDATE_DIR);

  // Every GED-shaped filename the page mentions, however it is spelled. A
  // substring scan rather than an href parse on purpose: the links may be built
  // by script, and the filename is the only thing actually needed.
  if (page) {
    const names = [...new Set(page.match(/GEDEvent[A-Za-z0-9_.-]*/g) ?? [])].sort();
    log(`\ndownloads page mentions ${names.length} GEDEvent filenames:`);
    for (const name of names) log(`  ${name}`);
    const dirs = [...new Set(page.match(/[A-Za-z0-9_/-]*candidate[A-Za-z0-9_/-]*/gi) ?? [])];
    log(`candidate paths mentioned: ${dirs.join(', ') || '(none)'}`);

    // Every downloadable the page links to, so a dataset we do not yet mirror
    // can be found without another round trip. UCDP/PRIO's Armed Conflict
    // Dataset is the one on the list: it carries UCDP's OWN war/minor
    // classification per conflict-year, which `ConflictClassifier` currently
    // approximates with thresholds transcribed out of World Monitor.
    const files = [...new Set(
      (page.match(/https?:\/\/[^"'\s<>]+\.(?:csv|zip|xlsx)/gi) ?? [])
        .map((url) => url.replace(/&amp;/g, '&')),
    )].sort();
    log(`\nall ${files.length} downloadable files linked from the page:`);
    for (const file of files) log(`  ${file}`);
  }

  // Whatever the generator would try today, so a future rename shows up as a
  // column of 404s next to the names the page actually lists.
  log('\nwhat the probe generator would try today:');
  for (const { version, url } of candidateReleases(now)) {
    await show(`${version}  ${url.split('/').pop()}`, url);
  }

  // UCDP/PRIO Armed Conflict Dataset, the one dataset on the list worth taking
  // next: it carries UCDP's OWN war/minor classification per conflict-year,
  // where `ConflictClassifier` currently approximates it with thresholds
  // transcribed out of World Monitor and applied to a 2,000-event slice.
  //
  // The shape is DUMPED rather than recalled. Twice this session a remembered
  // convention was wrong - the candidate filename, and `date_prec` 4 meaning a
  // month when the data says 8 to 16 days - and both were caught only by
  // looking. A column list is cheap; a wrong one is a silent mis-join.
  log('\nUCDP/PRIO Armed Conflict Dataset:');
  const acd = 'https://ucdp.uu.se/downloads/ucdpprio/ucdp-prio-acd-261-csv.zip';
  try {
    const zip = await download(acd, 'acd');
    log(`  ${(zip.length / 1024).toFixed(0)} kB  ${acd}`);
    const rows = parseCsv(stripBom(unzipFirstCsv(zip, log)));
    log(`  ${rows.length} rows`);
    if (rows.length) {
      log(`  columns: ${Object.keys(rows[0]).join(', ')}`);
      const years = rows.map((r) => Number(r.year)).filter(Number.isFinite);
      log(`  year range: ${Math.min(...years)} to ${Math.max(...years)}`);
      const newest = String(Math.max(...years));
      const latest = rows.filter((r) => String(r.year) === newest);
      log(`  ${latest.length} conflict-years in ${newest}`);
      const levels = new Map();
      for (const r of latest) {
        levels.set(r.intensity_level, (levels.get(r.intensity_level) ?? 0) + 1);
      }
      log(`  intensity_level in ${newest}: ${[...levels].map(([k, v]) => `${k}:${v}`).join('  ')}`);
      log(`  sample row: ${JSON.stringify(latest[0]).slice(0, 700)}`);
    }
  } catch (err) {
    log(`  FAILED: ${String(err.message).slice(0, 200)}`);
  }
}

/**
 * Fetch both releases. Injectable so the tests can run without network — the
 * agent shell cannot reach ucdp.uu.se at all.
 */
async function fetchReleases(log, now) {
  log(`annual ${ANNUAL_VERSION}:`);
  const zip = await download(ANNUAL_URL, `annual ${ANNUAL_VERSION}`);
  log(`  downloaded ${(zip.length / 1_048_576).toFixed(1)} MB`);
  const annual = parseCsv(stripBom(unzipFirstCsv(zip, log)), WANTED_COLUMNS);
  log(`  parsed ${annual.length} rows`);
  if (annual.length) log(`  newest annual date_start seen: ${maxIsoDay(annual)}`);

  const candidate = await fetchCandidate(log, now);
  return { annual, candidate: candidate.rows, candidateVersion: candidate.version };
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
    // UCDP's three precision codes, added 2026-10-06. ADDITIVE AT SCHEMA 1, and
    // that is not a style choice: `UCDPFeed.supportedSchema` is 1 and the app
    // THROWS on anything higher, so bumping the number would break UCDP on
    // every shipped 1.0 and 1.1 install until they updated. Swift's Codable
    // ignores keys it does not know, so an old build simply does not see these.
    //
    // `where_prec` 1-7: 3 and 4 place the event at an ADM2 or ADM1 CENTROID and
    // 6 at the country's, so drawing them as precise pins puts violence in the
    // geographic middle of provinces where nothing happened. `date_prec` 1-5:
    // above 1 the event is placeable only to a week, month or year, and a daily
    // time series that ignores it shows artificial spikes. `event_clarity` 1-2:
    // 2 means the report aggregates several incidents.
    //
    // `num()` yields 0 when the column is absent, and 0 is not a valid code for
    // any of the three — so 0 means "unknown" and the app must treat it exactly
    // as it treats the field being missing altogether, which is as today.
    where_prec: num(event.where_prec),
    date_prec: num(event.date_prec),
    event_clarity: num(event.event_clarity),
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
  const out = { out: null, dryRun: false, allowStale: false, probe: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--allow-stale') out.allowStale = true;
    else if (argv[i] === '--probe') out.probe = true;
  }
  return out;
}

/**
 * Per-country totals over the FULL windowed record, before the event cap.
 *
 * **This is why the app's death tolls were wrong.** The event list is capped at
 * 2,000 rows to keep the download small, and a year of global GED is tens of
 * thousands — so Ukraine arrived with 446 of its events and the app summed those
 * to 953 deaths and displayed it as the country's recorded toll. It is a real
 * sum of a truncated sample, which is a worse kind of wrong than an obvious gap.
 *
 * Aggregating here costs about 15 kB for ~120 countries and is computed over
 * every row inside the one-year window, so the figure is the whole record's
 * rather than the shipped slice's.
 *
 * Keyed by UCDP's own country spelling. The app maps those to its geometry (UCDP
 * writes "Russia (Soviet Union)" and "DR Congo (Zaire)"), which it already has
 * to do for the event rows.
 */
export function countryTotals(rows) {
  const byCountry = new Map();
  for (const row of rows) {
    const country = row.country || '';
    if (!country) continue;
    const entry = byCountry.get(country)
      ?? { country, events: 0, deaths: 0, deathsLow: 0, deathsHigh: 0 };
    entry.events += 1;
    entry.deaths += Number(row.best) || 0;
    entry.deathsLow += Number(row.low) || 0;
    entry.deathsHigh += Number(row.high) || 0;
    byCountry.set(country, entry);
  }
  // Deadliest first: a truncation here would drop the countries that matter, and
  // the app reads the whole map anyway.
  return [...byCountry.values()].sort((a, b) => b.deaths - a.deaths);
}

/**
 * Build the mirror payload from the two published CSV releases.
 *
 * @param fetch injectable transport returning
 *   `{annual, candidate, candidateVersion}`. Defaults to the real downloads.
 *   Injected by `mirror-ucdp.test.mjs`, which is the only way any of this is
 *   verifiable: the agent shell cannot reach ucdp.uu.se at all.
 * @param maxLagDays refuse to publish when the newest event is older than this.
 *   Null disables the check, which is the default so the shaping tests can use
 *   whatever dates they like; `main()` always passes a real ceiling.
 */
export async function buildMirror({
  now = new Date(), log = () => {}, fetch, maxLagDays = null,
} = {}) {
  const load = fetch ?? (() => fetchReleases(log, now));
  const { annual, candidate, candidateVersion = null } = await load();

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

  // Before the cap, deliberately: these totals describe the record, not the
  // slice that fits in the payload.
  const totals = countryTotals(windowed);
  log(`country totals: ${totals.length} countries, `
    + `${totals.reduce((sum, c) => sum + c.deaths, 0).toLocaleString('en-US')} deaths`);

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

  // The guard the 98-day freeze needed and did not have. Checked BEFORE the
  // payload is returned, so a stale run writes nothing and leaves the last-good
  // file in place — the same outcome as the freeze, except loud.
  if (maxLagDays != null) {
    const lagDays = Math.round((now.getTime() - newestMs) / 86_400_000);
    if (lagDays > maxLagDays) {
      throw new Error(
        `newest event ${isoDay(newestMs)} is ${lagDays} days old, past the ${maxLagDays}-day `
        + `ceiling. The candidate merge took ${candidateVersion ?? '(nothing)'}; either UCDP `
        + 'has stopped publishing candidates or the probe is resolving an old release. '
        + 'Refusing to publish — pass --allow-stale to override.');
    }
  }

  return {
    // Bumped only on a breaking shape change, so the app can refuse a payload
    // it cannot read instead of decoding it into nonsense. The move from the
    // API to the CSV downloads did NOT change the shape — `slim()` emits UCDP's
    // own column names either way — so this stays at 1 and shipped builds keep
    // reading the file.
    schema: 1,
    generatedAt: new Date(now.getTime()).toISOString(),
    annualVersion: ANNUAL_VERSION,
    candidateVersion: candidate.length ? candidateVersion : null,
    candidateComplete: candidate.length > 0,
    // The freshness signal that matters. A silently dead candidate merge is
    // otherwise invisible: the file keeps regenerating on schedule and stays
    // full while the content quietly falls back to the annual ~7-month lag.
    newestEventAt: isoDay(newestMs),
    oldestEventAt: isoDay(oldestMs),
    eventCount: capped.length,
    candidateEventCount: capped.filter((event) => candidateIds.has(event.id)).length,
    // Totals over the whole windowed record. `events` below is a capped slice of
    // it, so summing that gives a real total of the wrong population — which is
    // exactly the bug these exist to fix.
    countryTotals: totals,
    attribution: 'Uppsala Conflict Data Program (UCDP) Georeferenced Event Dataset, '
      + 'Department of Peace and Conflict Research, Uppsala University. CC BY 4.0. '
      + 'Davies, Pettersson, Öberg (2026) Journal of Peace Research; '
      + 'Sundberg & Melander (2013) Journal of Peace Research 50(4).',
    events: capped,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.probe) {
    console.log('=== UCDP probe: what does ucdp.uu.se actually publish? ===');
    await probe((line) => console.log(line), new Date());
    return;
  }

  if (!args.out) {
    console.error('usage: mirror-ucdp.mjs --out <path.json> [--dry-run] [--allow-stale]');
    console.error('       mirror-ucdp.mjs --probe');
    process.exit(2);
  }

  console.log('=== UCDP mirror ===');
  console.log('  source: ucdp.uu.se static downloads (no credential)');
  console.log(`  out:   ${args.out}`);

  const payload = await buildMirror({
    log: (line) => console.log(line),
    maxLagDays: args.allowStale ? null : MAX_CONTENT_LAG_DAYS,
  });

  console.log(`\n  annual ${payload.annualVersion}`
    + ` | candidate ${payload.candidateVersion ?? '(none)'}`
    + ` | ${payload.eventCount} events`
    + ` (${payload.candidateEventCount} from candidate)`);
  console.log(`  content ${payload.oldestEventAt} .. ${payload.newestEventAt}`);

  const lagDays = Math.round(
    (Date.now() - Date.parse(payload.newestEventAt)) / 86_400_000);
  const ceiling = args.allowStale ? 'waived' : `${MAX_CONTENT_LAG_DAYS}d`;
  console.log(`  newest event is ${lagDays} days old (ceiling ${ceiling})`);

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
