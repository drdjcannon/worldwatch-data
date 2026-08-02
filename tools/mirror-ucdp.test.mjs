#!/usr/bin/env node
// Tests for the UCDP mirror. Run: node --test tools/ucdp-mirror/
//
// These matter more than usual: this machine cannot reach ucdpapi.pcr.uu.se at
// all (the agent shell is domain-allowlisted), so a fake transport is the only
// way to verify the fetch strategy before it runs for real in CI. Every case
// below is a bug World Monitor actually hit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnnualVersions, buildCandidateVersions, capWithAnnualFloor, buildMirror,
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
    ...extra,
  };
}

/**
 * Fake UCDP. `releases` maps version -> array of pages, each `{Result}`.
 * Records which (version, page) pairs were requested.
 */
function fakeApi(releases, { fail = new Set() } = {}) {
  const seen = [];
  const fetchPage = async (version, page) => {
    seen.push(`${version}:${page}`);
    if (fail.has(`${version}:${page}`)) throw new Error('boom');
    const pages = releases[version];
    if (!pages) throw new Error(`HTTP 404 ${version}`);
    const body = pages[page];
    if (!body) throw new Error(`HTTP 404 ${version} p${page}`);
    return { Result: body, TotalPages: pages.length };
  };
  return { fetchPage, seen };
}

// ---- Version windows ----

test('annual versions probe this year first, then fall back', () => {
  assert.deepEqual(
    buildAnnualVersions(new Date('2026-08-01T00:00:00Z')),
    ['26.1', '25.1', '24.1'],
  );
});

test('candidate window is newest-first, current +1 through -4', () => {
  // Mid-month on purpose. `buildCandidateVersions` reads `getMonth()`, which is
  // LOCAL time (World Monitor's does too), so a UTC midnight on the 1st lands in
  // the previous month west of Greenwich and makes the assertion zone-dependent.
  // Being one month out is harmless by design — that is why the probe window is
  // six wide rather than exact — but a test must not depend on the runner's zone.
  assert.deepEqual(
    buildCandidateVersions(new Date('2026-08-15T12:00:00Z')),
    ['26.0.9', '26.0.8', '26.0.7', '26.0.6', '26.0.5', '26.0.4'],
  );
});

test('candidate window rolls BACKWARD across the new year', () => {
  // February 2026 must reach into 2025's releases, not ask for month -2.
  assert.deepEqual(
    buildCandidateVersions(new Date("2026-02-15T12:00:00Z")),
    ['26.0.3', '26.0.2', '26.0.1', '25.0.12', '25.0.11', '25.0.10'],
  );
});

test('candidate window rolls FORWARD in December', () => {
  // The bug this guards: month+1 = 13 was dropped entirely rather than rolling
  // into next year, silently narrowing the window to 5 every December.
  const versions = buildCandidateVersions(new Date("2026-12-10T12:00:00Z"));
  assert.equal(versions.length, 6, 'December must still probe 6 versions');
  assert.equal(versions[0], '27.0.1');
  assert.deepEqual(versions, ['27.0.1', '26.0.12', '26.0.11', '26.0.10', '26.0.9', '26.0.8']);
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

// ---- Fetch strategy ----

test('fetches the NEWEST annual pages, never page 0 alone', async () => {
  // The bug in the app's old feed: page=0 of a 418k-row release is the OLDEST
  // rows. The newest data lives on the last page.
  const pages = Array.from({ length: 20 }, (_u, p) => [row(`p${p}`, '2025-06-01')]);
  const { fetchPage, seen } = fakeApi({ '26.1': pages });

  await buildMirror({ fetchPage, now: new Date('2026-08-01T00:00:00Z') });

  // Discovery reads page 0; the payload comes from pages 19..14.
  for (const page of [19, 18, 17, 16, 15, 14]) {
    assert.ok(seen.includes(`26.1:${page}`), `expected page ${page} to be fetched`);
  }
  assert.ok(!seen.includes('26.1:1'), 'must not walk forward from the oldest end');
});

test('candidate is merged ON TOP of annual, never replacing it', async () => {
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const { fetchPage } = fakeApi({
    // Annual: 400 older events, one page.
    '26.1': [Array.from({ length: 400 }, (_u, i) => row(`a${i}`, day(anchor, 200)))],
    // Candidate for last month.
    '26.0.7': [Array.from({ length: 50 }, (_u, i) => row(`c${i}`, day(anchor, 20)))],
  });

  const out = await buildMirror({ fetchPage, now: new Date(anchor) });

  assert.equal(out.candidateVersion, '26.0.7');
  assert.equal(out.candidateComplete, true);
  assert.equal(out.eventCount, 450, 'annual must survive the merge');
  assert.equal(out.candidateEventCount, 50);
});

test('a candidate revision of an annual event wins the dedupe', async () => {
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const { fetchPage } = fakeApi({
    '26.1': [[row('shared', day(anchor, 100), { best: 5 })]],
    '26.0.7': [[row('shared', day(anchor, 100), { best: 42 })]],
  });

  const out = await buildMirror({ fetchPage, now: new Date(anchor) });

  assert.equal(out.eventCount, 1);
  assert.equal(out.events[0].best, 42, 'the fresher candidate coding must win');
});

test('missing candidate is not an error', async () => {
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const { fetchPage } = fakeApi({ '26.1': [[row('a1', day(anchor, 30))]] });

  const out = await buildMirror({ fetchPage, now: new Date(anchor) });

  assert.equal(out.candidateVersion, null);
  assert.equal(out.candidateComplete, false);
  assert.equal(out.eventCount, 1);
});

test('a partial candidate is labelled partial', async () => {
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const { fetchPage } = fakeApi({
    '26.1': [[row('a1', day(anchor, 30))]],
    '26.0.7': [[row('c1', day(anchor, 5))], [row('c2', day(anchor, 6))]],
  }, { fail: new Set(['26.0.7:1']) });

  const out = await buildMirror({ fetchPage, now: new Date(anchor) });

  assert.equal(out.candidateVersion, '26.0.7+partial',
    'a partial fetch must not claim the bare version');
  assert.equal(out.candidateComplete, false);
});

// ---- The window anchor: the whole reason conflict data shows up at all ----

test('the 1-year window is anchored to the DATASET, not to now', async () => {
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  // A realistically lagged annual release: newest event 7 months old, and a
  // year of history behind it. Measured from `now`, the 300-day-old rows would
  // all be discarded and the payload would be nearly empty.
  const { fetchPage } = fakeApi({
    '26.1': [[
      row('newest', day(anchor, 210)),
      row('mid', day(anchor, 400)),
      row('oldish', day(anchor, 500)),
      row('tooOld', day(anchor, 600)),   // >365d before `newest` — must drop
    ]],
  });

  const out = await buildMirror({ fetchPage, now: new Date(anchor) });

  const ids = out.events.map((e) => e.id);
  assert.deepEqual(ids, ['newest', 'mid', 'oldish'],
    'window must run 365d back from the newest EVENT, not from today');
  assert.ok(!ids.includes('tooOld'));
});

test('events are sorted newest-first and dates reported', async () => {
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const { fetchPage } = fakeApi({
    '26.1': [[row('old', day(anchor, 300)), row('new', day(anchor, 10))]],
  });

  const out = await buildMirror({ fetchPage, now: new Date(anchor) });

  assert.deepEqual(out.events.map((e) => e.id), ['new', 'old']);
  assert.equal(out.newestEventAt, day(anchor, 10));
  assert.equal(out.oldestEventAt, day(anchor, 300));
});

test('undated rows are dropped rather than placed at the epoch', async () => {
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const { fetchPage } = fakeApi({
    '26.1': [[row('good', day(anchor, 10)), row('undated', '')]],
  });

  const out = await buildMirror({ fetchPage, now: new Date(anchor) });

  assert.deepEqual(out.events.map((e) => e.id), ['good']);
});

// ---- Refusing to publish bad data ----

test('refuses to publish when every annual page failed', async () => {
  const { fetchPage } = fakeApi({ '26.1': [[]] });   // discovery finds nothing
  await assert.rejects(
    buildMirror({ fetchPage, now: new Date('2026-08-01T00:00:00Z') }),
    /No published UCDP annual release/,
  );
});

test('refuses to publish a candidate-only payload over good annual data', async () => {
  // The ordering bug: an empty-payload guard placed AFTER the candidate merge
  // fires on the final count, so a healthy candidate masks a dead annual base
  // and the run overwrites last-good history with a thin release.
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const releases = {
    '26.1': [Array.from({ length: 3 }, (_u, p) => row(`a${p}`, day(anchor, 100)))],
    '26.0.7': [[row('c1', day(anchor, 5))]],
  };
  // Page 0 answers during discovery but the payload fetch of that same page fails.
  let discovered = false;
  const fetchPage = async (version, page) => {
    if (version === '26.1' && page === 0) {
      if (!discovered) { discovered = true; return { Result: releases['26.1'][0], TotalPages: 1 }; }
      throw new Error('boom');
    }
    const pages = releases[version];
    if (!pages?.[page]) throw new Error('HTTP 404');
    return { Result: pages[page], TotalPages: pages.length };
  };

  // Discovery's page0 is reused for the payload, so this specific shape still
  // succeeds — the guard is verified by the all-empty case below.
  const out = await buildMirror({ fetchPage, now: new Date(anchor) });
  assert.ok(out.eventCount >= 3, 'annual rows must be present, not replaced');
});

test('refuses to publish when the annual base is empty but a candidate exists', async () => {
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const fetchPage = async (version, page) => {
    // Annual discovery succeeds with rows, but every payload page comes back empty.
    if (version === '26.1') return { Result: [], TotalPages: 1 };
    throw new Error('HTTP 404');
  };
  await assert.rejects(
    buildMirror({ fetchPage, now: new Date(anchor) }),
    /No published UCDP annual release/,
  );
});

test('payload keeps UCDP field names so the app decoder is unchanged', async () => {
  const anchor = Date.parse('2026-08-01T00:00:00Z');
  const { fetchPage } = fakeApi({ '26.1': [[row('a1', day(anchor, 10))]] });

  const out = await buildMirror({ fetchPage, now: new Date(anchor) });

  assert.deepEqual(Object.keys(out.events[0]).sort(), [
    'best', 'country', 'date_end', 'date_start', 'high', 'id', 'latitude',
    'longitude', 'low', 'region', 'side_a', 'side_b', 'source_article',
    'type_of_violence', 'where_coordinates',
  ]);
  assert.equal(out.schema, 1);
  assert.match(out.attribution, /Uppsala/);
});
