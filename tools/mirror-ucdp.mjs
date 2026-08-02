#!/usr/bin/env node
'use strict';

// UCDP mirror. Fetches the Uppsala Conflict Data Program's Georeferenced Event
// Dataset and writes a slimmed JSON file the iOS app can read with no
// credentials of its own.
//
// WHY THIS EXISTS
//
// UCDP's API needs an `x-ucdp-access-token`, and the only way to get one is to
// email their maintainer. That is fine for one operator and hopeless for an App
// Store audience: shipping the token in the binary makes it extractable and
// puts every install on one 5,000-request/day quota, and asking each user to
// email Uppsala means nobody ever sees conflict data.
//
// So this mirrors World Monitor's own architecture. There, a seeder holds one
// token, writes to Redis, and clients read the result — they never talk to UCDP.
// Here a scheduled GitHub Action plays the seeder, the token lives as a repo
// secret, and the output is a static JSON file. Zero infrastructure, zero cost,
// no token on any device.
//
// UCDP GED is released under CC BY 4.0, so redistributing it is fine; the
// attribution the app already carries (`SourceID.attribution`) is the condition.
//
// WHAT IT PORTS
//
// The fetch strategy is a direct port of worldmonitor's
// `scripts/seed-ucdp-events.mjs` plus `scripts/shared/ucdp-candidate.cjs`. Every
// non-obvious part of it is load-bearing and was learned the hard way over
// there; the comments say which.
//
// Usage:
//   UCDP_ACCESS_TOKEN=… node mirror-ucdp.mjs --out ucdp-events.json
//   node mirror-ucdp.mjs --out /tmp/x.json --dry-run

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---- Constants (transcribed from World Monitor, not re-tuned) ----

const API_BASE = 'https://ucdpapi.pcr.uu.se/api/gedevents';
const PAGE_SIZE = 1000;

/** Annual pages to pull. 6 x 1000 newest-first covers a year comfortably. */
const ANNUAL_MAX_PAGES = 6;

/**
 * A candidate release is far thinner than the annual (26.0.6 was 1,795 events
 * across 2 pages), so 3 pages covers a whole one with room to spare. It is a
 * bound, not an assumption: truncation is reported, never silent.
 */
const CANDIDATE_MAX_PAGES = 3;

/**
 * Candidate discovery fires six speculative probes, most of which 4xx for a
 * not-yet-published version, so it gets a much shorter budget than a real page
 * fetch (a 1,000-row page of a 418k-row release is genuinely slow).
 */
const CANDIDATE_DISCOVER_TIMEOUT_MS = 15_000;
const PAGE_TIMEOUT_MS = 90_000;

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

// ---- Version discovery ----

/**
 * Annual releases are `${YY}.1`. Probed rather than hardcoded so a bump is a
 * skipped probe instead of an outage; the older fallbacks are there because a
 * new year's release does not exist until UCDP publishes it.
 */
export function buildAnnualVersions(now = new Date()) {
  const yy = now.getFullYear() - 2000;
  return [...new Set([`${yy}.1`, `${yy - 1}.1`, '25.1', '24.1'])];
}

/**
 * Monthly GED Candidate releases, `${YY}.0.${M}`, newest-first, current +1
 * through -4.
 *
 * The candidate is the recency story: UCDP promises "not more than a month's
 * lag globally" for it, against the annual release's ~7 months. It is an
 * ADDITION on top of the annual base, never a replacement — a candidate alone is
 * ~1.8k events against the annual's ~418k.
 */
export function buildCandidateVersions(now = new Date()) {
  const yy = now.getFullYear() - 2000;
  const month = now.getMonth() + 1;
  const out = [];
  for (let offset = 1; offset >= -4; offset--) {
    const m = month + offset;
    if (m >= 1 && m <= 12) out.push(`${yy}.0.${m}`);
    else if (m < 1) out.push(`${yy - 1}.0.${m + 12}`);
    // Rolling FORWARD into next year matters too. Without this branch the entry
    // was dropped outright, silently narrowing the window to 5 every December.
    else out.push(`${yy + 1}.0.${m - 12}`);
  }
  return out;
}

// ---- Transport ----

function hasResults(page) {
  return Array.isArray(page?.Result) && page.Result.length > 0;
}

function makeFetchPage(token, log) {
  return async function fetchPage(version, page, timeoutMs = PAGE_TIMEOUT_MS) {
    const headers = { Accept: 'application/json', 'User-Agent': UA };
    // Forwarded only when present, so an unauthenticated run still works if
    // UCDP ever relaxes the requirement. It currently answers
    // 401 "API token required. Add header: x-ucdp-access-token: <your-token>".
    if (token) headers['x-ucdp-access-token'] = token;

    const url = `${API_BASE}/${version}?pagesize=${PAGE_SIZE}&page=${page}`;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) {
      // Read the body. UCDP explains itself there and the status alone sends you
      // guessing — this is the same lesson `FeedHTTP` logs for in the app.
      const body = await resp.text().catch(() => '');
      throw new Error(`${version} p${page}: HTTP ${resp.status} ${body.slice(0, 160)}`);
    }
    return resp.json();
  };
}

/** Sequential: the first version with results is the newest available. */
async function discoverAnnual(fetchPage, candidates, log) {
  for (const version of candidates) {
    try {
      const page0 = await fetchPage(version, 0);
      if (!hasResults(page0)) { log(`  v${version}: empty`); continue; }
      log(`  annual v${version}: ${page0.Result.length} rows on page 0, `
        + `${page0.TotalPages} pages`);
      return { version, page0 };
    } catch (err) {
      log(`  v${version} failed: ${err.message}`);
    }
  }
  throw new Error('No published UCDP annual release found');
}

/**
 * Probes every candidate CONCURRENTLY and takes the newest that answered.
 * `buildCandidateVersions` is newest-first, so the first fulfilled probe is by
 * construction the newest — no version comparator needed.
 *
 * Returns null rather than throwing when nothing is published yet: the candidate
 * is an addition, so its absence is not an error.
 */
async function discoverCandidate(fetchPage, candidates, log) {
  const settled = await Promise.allSettled(candidates.map(async (version) => {
    const first = await fetchPage(version, 0, CANDIDATE_DISCOVER_TIMEOUT_MS);
    if (!hasResults(first)) throw new Error(`${version}: no results`);
    return { version, first };
  }));
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') return outcome.value;
  }
  log('  no candidate release published this cycle — annual only');
  return null;
}

/**
 * Fetch a set of pages, isolating per-page failures so one bad page cannot
 * truncate the rest. Reports `complete` and `truncated` separately, because a
 * partial release labelled as a complete one is indistinguishable downstream.
 */
async function fetchPages(fetchPage, version, first, totalPages, maxPages) {
  const wanted = Math.min(Math.max(1, totalPages), maxPages);
  const FAILED = Symbol('failed');
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, wanted - 1) }, (_unused, i) =>
      fetchPage(version, i + 1).catch(() => FAILED)),
  );
  const events = Array.isArray(first?.Result) ? [...first.Result] : [];
  let failedPages = 0;
  for (const page of rest) {
    if (page === FAILED) { failedPages++; continue; }
    if (Array.isArray(page?.Result)) events.push(...page.Result);
  }
  return {
    events,
    failedPages,
    complete: failedPages === 0,
    truncated: totalPages > maxPages,
  };
}

/**
 * Annual pages, NEWEST FIRST.
 *
 * The app's old feed asked for `page=0` of the annual release, which is the
 * OLDEST 100 rows of a ~418k-row dataset — years-stale events presented as the
 * conflict record. The newest data is on the LAST page, so walk down from
 * `totalPages - 1`.
 */
async function fetchAnnualNewest(fetchPage, version, page0, totalPages, log) {
  const newest = Math.max(0, totalPages - 1);
  const FAILED = Symbol('failed');
  const wanted = [];
  for (let offset = 0; offset < ANNUAL_MAX_PAGES && (newest - offset) >= 0; offset++) {
    const page = newest - offset;
    wanted.push(page === 0
      ? Promise.resolve(page0)
      : fetchPage(version, page).catch(() => FAILED));
  }
  const results = await Promise.all(wanted);
  const events = [];
  let failedPages = 0;
  for (const page of results) {
    if (page === FAILED) { failedPages++; continue; }
    if (Array.isArray(page?.Result)) events.push(...page.Result);
  }
  log(`  annual: ${events.length} rows from pages ${newest}..`
    + `${Math.max(0, newest - ANNUAL_MAX_PAGES + 1)}`
    + (failedPages ? ` (${failedPages} page(s) failed)` : ''));
  return { events, failedPages };
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
 * @param fetchPage injectable transport `(version, page, timeoutMs) => Promise<{Result, TotalPages}>`.
 *   Defaults to the real API. Injected by `mirror-ucdp.test.mjs`, which is the
 *   only way any of this is verifiable without a token and network access.
 */
export async function buildMirror({ token, now = new Date(), log = () => {}, fetchPage } = {}) {
  fetchPage = fetchPage ?? makeFetchPage(token, log);

  log('annual release:');
  const { version, page0 } = await discoverAnnual(fetchPage, buildAnnualVersions(now), log);
  const totalPages = Math.max(1, Number(page0?.TotalPages) || 1);

  const annual = await fetchAnnualNewest(fetchPage, version, page0, totalPages, log);

  // Preserve last-good data when the annual base could not be fetched AT ALL.
  //
  // This MUST come BEFORE the candidate merge. An empty-payload guard placed
  // after it fires on the FINAL count, so a healthy candidate refilling the
  // payload hides the fact that the annual base is missing — and the run then
  // publishes a thin candidate-only release over good data, evicting the history
  // the classifier needs. World Monitor's relay always had this ordering; its
  // backup cron did not, and that was the bug.
  if (annual.events.length === 0) {
    throw new Error('every annual page failed — refusing to publish, keeping last good file');
  }

  log('candidate release:');
  let candidateVersion = null;
  let candidateComplete = false;
  const candidateIds = new Set();
  const all = [...annual.events];

  try {
    const found = await discoverCandidate(fetchPage, buildCandidateVersions(now), log);
    if (found) {
      const pages = Math.max(1, Number(found.first?.TotalPages) || 1);
      const merged = await fetchPages(
        fetchPage, found.version, found.first, pages, CANDIDATE_MAX_PAGES);
      candidateComplete = merged.complete && !merged.truncated;
      // Never claim a bare version for a partial fetch.
      candidateVersion = candidateComplete ? found.version : `${found.version}+partial`;
      if (merged.failedPages) log(`  ${merged.failedPages} candidate page(s) failed`);
      if (merged.truncated) log(`  candidate exceeds ${CANDIDATE_MAX_PAGES}-page cap — overflow dropped`);
      for (const event of merged.events) {
        if (event?.id != null) candidateIds.add(String(event.id));
      }
      all.push(...merged.events);
      log(`  candidate v${candidateVersion}: +${merged.events.length} events`);
    }
  } catch (err) {
    // Never fatal. The candidate improves recency; the annual base is the data.
    log(`  candidate merge skipped: ${err.message}`);
  }

  // Dedupe by id. Candidates are appended after the annual base, so a
  // candidate's revision of an event present in both wins — it is the fresher
  // coding of the same incident.
  const byId = new Map();
  for (const event of all) {
    const id = event?.id != null ? String(event.id) : '';
    byId.set(id || Symbol('anon'), event);
  }

  // Anchor the window to the dataset's own newest event. Taken as the global max
  // rather than World Monitor's first-successful-page max: same value in
  // practice (pages are walked newest-first) but it survives the newest page
  // failing, which would otherwise shift the whole window backwards.
  const deduped = [...byId.values()];
  const latestMs = maxDateMs(deduped);
  const cutoff = latestMs - TRAILING_WINDOW_MS;

  const windowed = deduped.filter((event) => {
    if (!Number.isFinite(latestMs)) return true;
    const ms = parseMs(event?.date_start);
    if (!Number.isFinite(ms)) return false;   // undated rows cannot be placed
    return ms >= cutoff;
  });
  log(`dedupe ${all.length} -> ${deduped.length}, `
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
    // it cannot read instead of decoding it into nonsense.
    schema: 1,
    generatedAt: new Date(now.getTime()).toISOString(),
    annualVersion: version,
    candidateVersion,
    candidateComplete,
    // The freshness signal that matters. A silently dead candidate merge is
    // otherwise invisible: the file keeps regenerating on schedule and stays
    // full while the content quietly falls back to the annual ~7-month lag.
    newestEventAt: isoDay(newestMs),
    oldestEventAt: isoDay(oldestMs),
    eventCount: capped.length,
    candidateEventCount: capped.filter((event) => candidateIds.has(event.id)).length,
    attribution: 'Uppsala Conflict Data Program (UCDP) Georeferenced Event Dataset, '
      + 'Department of Peace and Conflict Research, Uppsala University. CC BY 4.0.',
    events: capped,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    console.error('usage: mirror-ucdp.mjs --out <path.json> [--dry-run]');
    process.exit(2);
  }

  const token = (process.env.UCDP_ACCESS_TOKEN || '').trim();
  console.log('=== UCDP mirror ===');
  console.log(`  token: ${token ? `${token.slice(0, 4)}***${token.slice(-4)}` : '(none)'}`);
  console.log(`  out:   ${args.out}`);

  const payload = await buildMirror({ token, log: (line) => console.log(line) });

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
