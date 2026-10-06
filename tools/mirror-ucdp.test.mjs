#!/usr/bin/env node
// Tests for the UCDP mirror. Run: node --test tools/mirror-ucdp.test.mjs
//
// These matter more than usual: this machine cannot reach ucdp.uu.se at all
// (the agent shell is domain-allowlisted), so a fake transport is the only way
// to verify the strategy before it runs for real in CI. Most cases below are a
// bug World Monitor actually hit.
//
// The transport moved from the token-gated REST API to the published CSV
// downloads on 2026-08-03. The version-probing and page-walking tests went with
// it; everything about SHAPING the payload is unchanged and still tested here,
// because none of that logic changed and all of it is load-bearing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capWithAnnualFloor, buildMirror, parseCsv, countryTotals, candidateReleases,
  conflictClassification,
} from './mirror-ucdp.mjs';

const DAY = 86_400_000;

/** `date_start` n days before the given anchor. */
function day(anchorMs, daysAgo) {
  return new Date(anchorMs - daysAgo * DAY).toISOString().slice(0, 10);
}

function row(id, dateStart, extra = {}) {
  return {
    id, date_start: dateStart, date_end: dateStart,
    latitude: 15.5, longitude: 30.2, country: 'Sudan', region: 'Africa',
    best: 5, low: 4, high: 7, type_of_violence: 1,
    side_a: 'Government of Sudan', side_b: 'RSF',
    where_coordinates: 'El Fasher', source_article: 'https://example.test/a',
    where_prec: 1, date_prec: 1, event_clarity: 1,
    ...extra,
  };
}

/** Fake downloads: hands `buildMirror` the parsed rows it would have fetched. */
function fakeReleases(annual = [], candidate = [], candidateVersion = '26.0.8') {
  return async () => ({ annual, candidate, candidateVersion });
}

// ---- CSV parsing ----
//
// Hand-rolled because the repo has no dependencies, so it needs real coverage:
// a naive split(',') passes a smoke test and then mangles most of the file.

test('parses a plain CSV into keyed rows', () => {
  const rows = parseCsv('id,best\n123,5\n124,0\n');
  assert.deepEqual(rows, [{ id: '123', best: '5' }, { id: '124', best: '0' }]);
});

test('a quoted field may contain commas', () => {
  // UCDP's source_article contains commas in almost every row.
  const rows = parseCsv('id,source_article\n1,"Reuters, AFP, AP"\n');
  assert.equal(rows[0].source_article, 'Reuters, AFP, AP');
});

test('a doubled quote is an escaped quote', () => {
  const rows = parseCsv('id,side_b\n1,"the ""Wagner"" group"\n');
  assert.equal(rows[0].side_b, 'the "Wagner" group');
});

test('a quoted field may contain newlines', () => {
  // This is the one that breaks line-based parsers: the record spans two lines.
  const rows = parseCsv('id,source_article\n1,"line one\nline two"\n2,x\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source_article, 'line one\nline two');
  assert.equal(rows[1].id, '2');
});

test('CRLF line endings and a missing final newline both parse', () => {
  const rows = parseCsv('id,best\r\n1,5\r\n2,6');
  assert.deepEqual(rows.map((r) => r.id), ['1', '2']);
});

test('a truncated row is dropped rather than mis-keyed', () => {
  // A file cut off mid-write would otherwise shift every column right.
  const rows = parseCsv('id,best,country\n1,5,Sudan\n2,6\n');
  assert.deepEqual(rows.map((r) => r.id), ['1']);
});

test('only the requested columns are kept', () => {
  // Memory, not tidiness: the annual CSV is ~420k rows x 48 columns, and
  // materialising all of it can OOM a runner.
  const rows = parseCsv('id,best,geom_wkt\n1,5,POINT(1 2)\n', new Set(['id', 'best']));
  assert.deepEqual(rows, [{ id: '1', best: '5' }]);
});

test('a header sharing none of the wanted columns is a loud failure', () => {
  // An upstream schema change would otherwise publish 0 events silently.
  assert.throws(
    () => parseCsv('foo,bar\n1,2\n', new Set(['id', 'best'])),
    /none of the expected columns/,
  );
});

// ---- Cap ----

test('cap reserves slots for the annual base', () => {
  // Every candidate event is newer, so a plain slice would evict all history.
  const candidate = Array.from({ length: 1800 }, (_u, i) => ({ id: `c${i}`, date_start: '2026-07-01' }));
  const annual = Array.from({ length: 5000 }, (_u, i) => ({ id: `a${i}`, date_start: '2025-09-01' }));
  const capped = capWithAnnualFloor(
    [...candidate, ...annual], (e) => e.id.startsWith('c'), 2000, 500);

  assert.equal(capped.length, 2000);
  assert.equal(capped.filter((e) => e.id.startsWith('a')).length, 500,
    'the annual floor must be honoured exactly');
  assert.equal(capped.filter((e) => e.id.startsWith('c')).length, 1500);
});

test('cap gives unused annual slots back to the candidate', () => {
  // Must never publish a SHORTER payload than a plain slice would have.
  const candidate = Array.from({ length: 1900 }, (_u, i) => ({ id: `c${i}`, date_start: '2026-07-01' }));
  const annual = Array.from({ length: 200 }, (_u, i) => ({ id: `a${i}`, date_start: '2025-09-01' }));
  const capped = capWithAnnualFloor(
    [...candidate, ...annual], (e) => e.id.startsWith('c'), 2000, 500);

  assert.equal(capped.length, 2000);
  assert.equal(capped.filter((e) => e.id.startsWith('a')).length, 200);
  assert.equal(capped.filter((e) => e.id.startsWith('c')).length, 1800);
});

test('cap is a no-op below the ceiling', () => {
  const events = [{ id: 'a', date_start: '2026-01-01' }];
  assert.deepEqual(capWithAnnualFloor(events, () => false, 2000, 500), events);
});

// ---- Merge and dedupe ----

test('candidate is merged ON TOP of annual, never replacing it', async () => {
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const out = await buildMirror({
    now: new Date(anchor),
    fetch: fakeReleases([row('a1', day(anchor, 100))], [row('c1', day(anchor, 5))]),
  });

  assert.deepEqual(out.events.map((e) => e.id).sort(), ['a1', 'c1']);
  assert.equal(out.candidateEventCount, 1);
});

test('a candidate revision of an annual event wins the dedupe', async () => {
  // Same id in both releases: the candidate is the fresher coding.
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const out = await buildMirror({
    now: new Date(anchor),
    fetch: fakeReleases(
      [row('shared', day(anchor, 50), { best: 5 })],
      [row('shared', day(anchor, 50), { best: 99 })]),
  });

  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].best, 99, 'the candidate revision must win');
});

test('a missing candidate is not an error', async () => {
  // The candidate improves recency; the annual base IS the data.
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const out = await buildMirror({
    now: new Date(anchor),
    fetch: fakeReleases([row('a1', day(anchor, 30))], []),
  });

  assert.equal(out.eventCount, 1);
  assert.equal(out.candidateVersion, null);
  assert.equal(out.candidateComplete, false);
});

// ---- The window ----

test('the 1-year window is anchored to the DATASET, not to now', async () => {
  // The single most important behaviour here. The annual release is ~7 months
  // stale by design, so a window measured from today discards all of it.
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const out = await buildMirror({
    now: new Date(anchor),
    fetch: fakeReleases([
      row('recent', day(anchor, 200)),     // 6+ months old, must survive
      row('ancient', day(anchor, 900)),    // outside a year of the newest
    ], []),
  });

  assert.deepEqual(out.events.map((e) => e.id), ['recent']);
});

test('undated rows are dropped rather than placed at the epoch', async () => {
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const out = await buildMirror({
    now: new Date(anchor),
    fetch: fakeReleases([row('good', day(anchor, 10)), row('undated', '')], []),
  });

  assert.deepEqual(out.events.map((e) => e.id), ['good']);
});

test('events are sorted newest-first and the content dates are reported', async () => {
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const out = await buildMirror({
    now: new Date(anchor),
    fetch: fakeReleases(
      [row('older', day(anchor, 200)), row('newer', day(anchor, 20))], []),
  });

  assert.deepEqual(out.events.map((e) => e.id), ['newer', 'older']);
  assert.equal(out.newestEventAt, day(anchor, 20));
  assert.equal(out.oldestEventAt, day(anchor, 200));
});

// ---- Refusing to publish bad data ----

test('refuses to publish when the annual release is empty', async () => {
  await assert.rejects(
    buildMirror({ now: new Date('2026-08-01T00:00:00Z'), fetch: fakeReleases([], []) }),
    /annual release is empty/,
  );
});

test('refuses to publish a candidate-only payload over good annual data', async () => {
  // The ordering bug: an empty-payload guard placed AFTER the candidate merge
  // fires on the final count, so a healthy candidate masks a dead annual base
  // and the run overwrites last-good history with a thin release.
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  await assert.rejects(
    buildMirror({
      now: new Date(anchor),
      fetch: fakeReleases([], [row('c1', day(anchor, 5))]),
    }),
    /annual release is empty/,
  );
});

// ---- Country totals ----

test('totals are computed over the whole record, not the capped slice', async () => {
  // The bug this exists for: Ukraine arrived with 446 of its events in a
  // 2,000-event payload, summed to 953 deaths, and that was shown as the
  // country's recorded toll and fed the war/minor thresholds.
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const annual = Array.from({ length: 2500 }, (_u, i) =>
    row(`a${i}`, day(anchor, 10), { country: 'Ukraine', best: 10, low: 8, high: 12 }));

  const out = await buildMirror({ now: new Date(anchor), fetch: fakeReleases(annual, []) });

  assert.equal(out.eventCount, 2000, 'the event list is still capped');
  const ukraine = out.countryTotals.find((c) => c.country === 'Ukraine');
  assert.equal(ukraine.events, 2500, 'totals must count every row, not the 2000 kept');
  assert.equal(ukraine.deaths, 25_000, 'and sum every death, not the capped slice');
  assert.equal(ukraine.deathsLow, 20_000);
  assert.equal(ukraine.deathsHigh, 30_000);
});

test('totals are keyed by UCDP spelling and sorted deadliest first', () => {
  const totals = countryTotals([
    { country: 'Mexico', best: '5', low: '5', high: '5' },
    { country: 'Russia (Soviet Union)', best: '900', low: '800', high: '1000' },
    { country: 'Russia (Soviet Union)', best: '100', low: '90', high: '110' },
  ]);

  assert.deepEqual(totals.map((c) => c.country), ['Russia (Soviet Union)', 'Mexico']);
  assert.equal(totals[0].deaths, 1000, 'CSV strings must be coerced, not concatenated');
  assert.equal(totals[0].events, 2);
});

test('rows with no country are skipped rather than bucketed under empty', () => {
  const totals = countryTotals([{ country: '', best: '5' }, { best: '3' }]);
  assert.deepEqual(totals, []);
});

// ---- The app's contract ----

test('payload keeps UCDP field names so the app decoder is unchanged', async () => {
  // The whole point of the CSV move being transport-only: a shipped build must
  // keep reading the file without a schema bump.
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const out = await buildMirror({
    now: new Date(anchor),
    fetch: fakeReleases([row('a1', day(anchor, 10))], []),
  });

  assert.deepEqual(Object.keys(out.events[0]).sort(), [
    'best', 'country', 'date_end', 'date_prec', 'date_start', 'event_clarity',
    'high', 'id', 'latitude', 'longitude', 'low', 'region', 'side_a', 'side_b',
    'source_article', 'type_of_violence', 'where_coordinates', 'where_prec',
  ]);
  assert.equal(out.schema, 1,
    'the three precision fields are ADDITIVE - a schema bump breaks every shipped install');
  assert.match(out.attribution, /Uppsala/);
  assert.match(out.attribution, /CC BY 4\.0/);
});

// ---- The precision codes ----

test('the three precision codes are published and coerced to numbers', async () => {
  // UCDP tells consumers to honour these: where_prec 3+ is a province or
  // country CENTROID, not an incident location, and date_prec above 1 means
  // the event is placeable only to a week, month or year.
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const out = await buildMirror({
    now: new Date(anchor),
    fetch: fakeReleases([row('a1', day(anchor, 10), {
      where_prec: '4', date_prec: '3', event_clarity: '2',
    })], []),
  });

  const event = out.events[0];
  assert.equal(event.where_prec, 4);
  assert.equal(event.date_prec, 3);
  assert.equal(event.event_clarity, 2);
  assert.equal(typeof event.where_prec, 'number', 'CSV strings must be coerced');
});

test('a row missing the precision codes publishes 0, which means unknown', async () => {
  // 0 is not a valid UCDP code for any of the three, so it cannot collide with
  // a real value - and the app must treat it exactly as it treats the key being
  // absent, which is as today's behaviour.
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const bare = row('a1', day(anchor, 10));
  delete bare.where_prec; delete bare.date_prec; delete bare.event_clarity;

  const out = await buildMirror({ now: new Date(anchor), fetch: fakeReleases([bare], []) });

  assert.equal(out.events[0].where_prec, 0);
  assert.equal(out.events[0].date_prec, 0);
  assert.equal(out.events[0].event_clarity, 0);
});

// ---- Candidate probing ----
//
// The hardcoded candidate URL froze the mirror for 98 days while every weekly
// run went green, because a superseded release does not 404 - it keeps serving.
// Worse, UCDP had also RENAMED the files, so incrementing the month in the old
// name (the obvious fix) produces nothing but 404s. The names below are the
// ones a CI probe measured on the live downloads page on 2026-10-06.

test('candidate names use the measured v{YY}_0_{M} convention, newest first', () => {
  // Measured: GEDEvent_v26_0_7.csv and GEDEvent_v26_0_8.csv both answer 200,
  // while every GEDEvent_v26_01_26_MM spelling after the floor answers 404.
  const releases = candidateReleases(new Date('2026-10-06T00:00:00Z'));

  assert.deepEqual(releases.map((r) => r.version), [
    '26.0.11', '26.0.10', '26.0.9', '26.0.8', '26.0.7', '26.0.6', '26.01.26.06',
  ]);
  assert.equal(releases[3].url,
    'https://ucdp.uu.se/downloads/candidateged/GEDEvent_v26_0_8.csv',
    'this exact URL was measured at 200, 1,436,409 bytes');
});

test('the month is NOT zero-padded', () => {
  // GEDEvent_v26_0_7.csv resolves; GEDEvent_v26_01_26_07.csv does not. One
  // character, and getting it wrong is three months of missing data.
  const releases = candidateReleases(new Date('2026-09-15T00:00:00Z'));
  assert.ok(releases.some((r) => r.url.endsWith('GEDEvent_v26_0_9.csv')));
  assert.ok(!releases.some((r) => r.url.includes('_09.csv')),
    'a padded month would silently 404 forever');
});

test('one month ahead is probed first', () => {
  // A release could be labelled by its publication month rather than by the
  // month it covers. One extra 404 is cheaper than missing a month.
  const releases = candidateReleases(new Date('2026-10-06T00:00:00Z'));
  assert.equal(releases[0].version, '26.0.11');
});

test('the window rolls over the year boundary', () => {
  // Upstream wrote this branch by hand and its comment records that omitting it
  // "silently narrowed the window to 5 every December". Date.UTC does it here.
  const releases = candidateReleases(new Date('2026-12-20T00:00:00Z'));
  assert.equal(releases[0].version, '27.0.1', 'January of the next year');
  assert.equal(releases[1].version, '26.0.12');
  assert.equal(releases.at(-2).version, '26.0.8');
});

test('the legacy name is always tried last and never first', () => {
  // The degradation path: a probe that finds nothing falls back to exactly what
  // the mirror served before any of this, rather than to nothing.
  for (const when of ['2026-10-06', '2027-03-01', '2026-07-01']) {
    const releases = candidateReleases(new Date(`${when}T00:00:00Z`));
    assert.equal(releases.at(-1).version, '26.01.26.06', `last at ${when}`);
    assert.equal(releases.at(-1).url,
      'https://ucdp.uu.se/downloads/candidateged/GEDEvent_v26_01_26_06.csv');
    assert.notEqual(releases[0].version, '26.01.26.06');
  }
});

test('the probe window stays a constant size as time passes', () => {
  // Walking back to a fixed floor would add a 404 every month forever. Anything
  // older than the window is the staleness ceiling's problem, not the probe's.
  const sizes = ['2026-10-06', '2027-10-06', '2030-01-01']
    .map((when) => candidateReleases(new Date(`${when}T00:00:00Z`)).length);
  assert.deepEqual(sizes, [7, 7, 7]);
});

test('the probed version reaches the payload', async () => {
  const anchor = Date.parse('2026-10-06T00:00:00Z');
  const out = await buildMirror({
    now: new Date(anchor),
    fetch: fakeReleases([row('a1', day(anchor, 30))], [row('c1', day(anchor, 5))],
      '26.0.8'),
  });

  assert.equal(out.candidateVersion, '26.0.8',
    'the published version must be the one actually taken, not a constant');
});

// ---- The staleness ceiling ----

test('refuses to publish when the newest event is past the lag ceiling', async () => {
  // The guard the 98-day freeze needed. A green run that commits nothing is
  // indistinguishable from a correctly idle one unless something checks the
  // DATA's age.
  //
  // 99 days is the REAL lag measured on the live file on 2026-10-06, and it is
  // in this test because the first ceiling I chose, 120, would have let it
  // through. A guard calibrated loosely enough to miss its own motivating bug
  // is decoration.
  const anchor = Date.parse('2026-10-06T00:00:00Z');
  await assert.rejects(
    buildMirror({
      now: new Date(anchor),
      maxLagDays: 90,
      fetch: fakeReleases([row('a1', day(anchor, 99))], []),
    }),
    /99 days old, past the 90-day ceiling/,
  );
});

test('a healthy lag publishes normally', async () => {
  // 58 days is the worst a working candidate merge produces: a release lands on
  // the 21st covering through the end of the previous month, plus a week of our
  // own weekly polling.
  const anchor = Date.parse('2026-10-06T00:00:00Z');
  const out = await buildMirror({
    now: new Date(anchor),
    maxLagDays: 90,
    fetch: fakeReleases([row('a1', day(anchor, 58))], []),
  });

  assert.equal(out.eventCount, 1);
});

test('the ceiling is off by default so the shaping tests are unaffected', async () => {
  const anchor = Date.parse('2026-10-06T00:00:00Z');
  const out = await buildMirror({
    now: new Date(anchor),
    fetch: fakeReleases([row('ancient', day(anchor, 300))], []),
  });

  assert.equal(out.eventCount, 1);
});

test('CSV strings are coerced to the numeric types the app expects', async () => {
  // Every CSV value arrives as a string. The app decodes latitude, best and
  // type_of_violence as numbers, so slim() must convert rather than pass through.
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const out = await buildMirror({
    now: new Date(anchor),
    fetch: fakeReleases([row('a1', day(anchor, 10), {
      latitude: '15.5', longitude: '30.2', best: '7', low: '4', high: '9',
      type_of_violence: '1',
    })], []),
  });

  const event = out.events[0];
  assert.equal(typeof event.latitude, 'number');
  assert.equal(event.latitude, 15.5);
  assert.equal(typeof event.best, 'number');
  assert.equal(event.best, 7);
  assert.equal(typeof event.type_of_violence, 'number');
  assert.equal(event.id, 'a1', 'id stays a string');
});

// ---- UCDP's own war/minor classification ----
//
// The Armed Conflict Dataset answers authoritatively what `ConflictClassifier`
// currently derives from thresholds transcribed out of World Monitor. Measured
// 2026-10-06: 2,816 rows, years 1946 to 2025, 65 conflict-years in the newest
// year split 52 minor and 13 war.

/** One ACD conflict-year. Field names and codes are UCDP's own. */
function acd(location, year, level, extra = {}) {
  return {
    conflict_id: '209', location, year: String(year),
    intensity_level: String(level), ep_end: '0', type_of_conflict: '3',
    side_a: 'Government', side_b: 'Rebels', region: '3', version: '26.1',
    ...extra,
  };
}

test('only the newest year counts', () => {
  // One row per conflict-year back to 1946. A country at war in 1998 is not a
  // country at war now.
  const out = conflictClassification([
    acd('Cambodia', 1998, 2), acd('Philippines', 2025, 1),
  ]);
  assert.equal(out.year, 2025);
  assert.deepEqual(out.countries.map((c) => c.country), ['Philippines']);
});

test('an episode that ENDED in that year is not a current conflict', () => {
  // ep_end 1 means the episode finished. Since the newest year is already ten
  // months old, including it would report a finished war as ongoing for a year.
  const out = conflictClassification([
    acd('Ethiopia', 2025, 2, { ep_end: '1' }),
    acd('Myanmar (Burma)', 2025, 1),
  ]);
  assert.deepEqual(out.countries.map((c) => c.country), ['Myanmar (Burma)']);
  assert.equal(out.endedEpisodesExcluded, 1, 'and it is counted, not silently dropped');
});

test('a multi-country conflict reaches every country it names', () => {
  // UCDP writes these as "DR Congo (Zaire), Rwanda". A whole-string key joins
  // to neither country.
  const out = conflictClassification([acd('DR Congo (Zaire), Rwanda', 2025, 2)]);
  assert.deepEqual(out.countries.map((c) => c.country).sort(),
    ['DR Congo (Zaire)', 'Rwanda']);
  assert.ok(out.countries.every((c) => c.intensity === 'war'));
});

test('the highest intensity wins where a country has several conflicts', () => {
  // One war and four insurgencies is a country at war.
  const out = conflictClassification([
    acd('Nigeria', 2025, 1), acd('Nigeria', 2025, 2), acd('Nigeria', 2025, 1),
  ]);
  assert.equal(out.countries.length, 1);
  assert.equal(out.countries[0].intensity, 'war');
  assert.equal(out.countries[0].conflicts, 3);
});

test('intensity is published as a word, not UCDP\'s code', () => {
  // The payload should say what it means; the app should not need the codebook.
  const out = conflictClassification([acd('Sudan', 2025, 2), acd('Mali', 2025, 1)]);
  assert.equal(out.countries.find((c) => c.country === 'Sudan').intensity, 'war');
  assert.equal(out.countries.find((c) => c.country === 'Mali').intensity, 'minor');
});

test('wars sort first', () => {
  const out = conflictClassification([acd('Mali', 2025, 1), acd('Sudan', 2025, 2)]);
  assert.deepEqual(out.countries.map((c) => c.country), ['Sudan', 'Mali']);
});

test('an out-of-range intensity is dropped rather than guessed at', () => {
  const out = conflictClassification([acd('Nowhere', 2025, 9), acd('Mali', 2025, 1)]);
  assert.deepEqual(out.countries.map((c) => c.country), ['Mali']);
});

test('an empty dataset publishes null rather than an empty claim', () => {
  assert.equal(conflictClassification([]), null);
});

test('the classification rides in the payload and is optional', async () => {
  // Additive at schema 1: an app that has never heard of it ignores the key,
  // and a fetch failure costs authority rather than data.
  const anchor = Date.parse('2026-10-06T00:00:00Z');
  const withIt = await buildMirror({
    now: new Date(anchor),
    fetch: async () => ({
      annual: [row('a1', day(anchor, 30))], candidate: [], candidateVersion: null,
      classification: conflictClassification([acd('Sudan', 2025, 2)]),
    }),
  });
  assert.equal(withIt.schema, 1);
  assert.equal(withIt.conflictClassification.countries[0].country, 'Sudan');

  const without = await buildMirror({
    now: new Date(anchor), fetch: fakeReleases([row('a1', day(anchor, 30))], []),
  });
  assert.equal(without.conflictClassification, null);
  assert.equal(without.eventCount, 1, 'and the events are unaffected');
});
