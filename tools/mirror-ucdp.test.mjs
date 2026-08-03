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
import { capWithAnnualFloor, buildMirror, parseCsv } from './mirror-ucdp.mjs';

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
    ...extra,
  };
}

/** Fake downloads: hands `buildMirror` the parsed rows it would have fetched. */
function fakeReleases(annual = [], candidate = []) {
  return async () => ({ annual, candidate });
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
    'best', 'country', 'date_end', 'date_start', 'high', 'id', 'latitude',
    'longitude', 'low', 'region', 'side_a', 'side_b', 'source_article',
    'type_of_violence', 'where_coordinates',
  ]);
  assert.equal(out.schema, 1);
  assert.match(out.attribution, /Uppsala/);
  assert.match(out.attribution, /CC BY 4\.0/);
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
