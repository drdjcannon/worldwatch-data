#!/usr/bin/env node
// Tests for the GPS interference mirror. Run: node --test tools/mirror-gpsjam.test.mjs
//
// These matter for the same reason the UCDP ones do: the machine this was written on cannot reach
// gpsjam.org at all (the agent shell is domain-allowlisted to GitHub), so a fake grid is the only
// way to verify the shaping before it runs for real in CI.
//
// **H3 is injected, so these run with nothing installed.** `h3-js` is the mirror's one dependency
// and it does exactly one thing: cell id to geometry. Everything else - the header lookup, the
// sample floor, the banding, the ordering, the cap, the abort guard - is logic that can be wrong in
// ways that publish a plausible file, so all of it is covered here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processHexes, latestDate, band } from './mirror-gpsjam.mjs';

/// A stand-in for h3-js: every id beginning with "84" is a valid cell, and its geometry is derived
/// from the id so a test can assert which cell a row came from.
const fakeH3 = {
  isValidCell: (id) => id.startsWith('84'),
  cellToLatLng: (id) => [Number(id.slice(2, 4)), Number(id.slice(4, 6))],
  cellToBoundary: (id, geoJson) => {
    assert.equal(geoJson, true, 'the mirror must ask for [lng, lat] order');
    const lat = Number(id.slice(2, 4));
    const lon = Number(id.slice(4, 6));
    return [[lon, lat], [lon + 1, lat], [lon + 1, lat + 1], [lon, lat + 1], [lon - 1, lat + 0.5]];
  },
};

const HEADER = 'hex,count_good_aircraft,count_bad_aircraft';

test('the newest date is the last manifest row, and a malformed tail is loud', () => {
  assert.equal(latestDate('date,suspect,num_bad_hexes\n2026-08-21,1,10\n2026-08-23,1,42\n'),
    '2026-08-23');
  // A quietly wrong date would publish yesterday's grid as today's measurement.
  assert.throws(() => latestDate('date,suspect\n2026-08-21,1\ntotals,,\n'), /does not start with a date/);
  assert.throws(() => latestDate('date,suspect,num_bad_hexes\n'), /no data rows/);
});

test('the bands are upstream\'s, including where they touch', () => {
  // Transcribed from worldmonitor: low under 2, medium 2 to 10 inclusive of 2, high above 10.
  assert.equal(band(0), 'low');
  assert.equal(band(1.9), 'low');
  assert.equal(band(2), 'medium');
  assert.equal(band(10), 'medium');
  assert.equal(band(10.1), 'high');
});

test('a low-sample cell is dropped and counted, not published as 100%', () => {
  // One aircraft reporting badly is a 100% cell. Publishing those makes a map of small samples,
  // and dropping them silently makes a quiet day and a thinned day look identical.
  const csv = `${HEADER}\n840000,0,1\n841020,50,20\n`;
  const { hexes, stats } = processHexes(csv, { minAircraft: 3, maxHexes: 100, h3: fakeH3 });
  assert.equal(hexes.length, 1);
  assert.equal(stats.droppedLowSample, 1);
  assert.equal(hexes[0].pct, 28.6);
  assert.equal(hexes[0].badAircraft, 20);
  assert.equal(hexes[0].totalAircraft, 70);
});

test('low interference is dropped, and the count says how much', () => {
  const csv = `${HEADER}\n841020,99,1\n842030,80,20\n`;
  const { hexes, stats } = processHexes(csv, { minAircraft: 3, maxHexes: 100, h3: fakeH3 });
  assert.equal(hexes.length, 1);
  assert.equal(hexes[0].level, 'high');
  assert.equal(stats.droppedLowInterference, 1);
});

test('columns are read by name, so an added column cannot shift every value', () => {
  const csv = 'hex,region,count_good_aircraft,extra,count_bad_aircraft\n'
    + '841020,europe,80,x,20\n';
  const { hexes } = processHexes(csv, { minAircraft: 3, maxHexes: 100, h3: fakeH3 });
  assert.equal(hexes.length, 1);
  assert.equal(hexes[0].totalAircraft, 100);
  // And a header without the columns at all stops the run rather than publishing zeroes.
  assert.throws(() => processHexes('a,b,c\n1,2,3\n', { minAircraft: 3, maxHexes: 9, h3: fakeH3 }),
    /unexpected hex CSV header/);
});

test('geometry is [lng, lat] and rounded, and the centre travels with the ring', () => {
  const { hexes } = processHexes(`${HEADER}\n841020,10,90\n`,
    { minAircraft: 3, maxHexes: 100, h3: fakeH3 });
  const hex = hexes[0];
  // The fake encodes lat 10, lon 20 in the id. Longitude first, which is the order every other
  // geometry file the app reads uses; reversed, this puts cells in the wrong hemisphere.
  assert.deepEqual(hex.center, [20, 10]);
  assert.deepEqual(hex.ring[0], [20, 10]);
  assert.equal(hex.ring.length, 5);
  assert.ok(hex.ring.every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat)));
});

test('an invalid cell is counted as a failure rather than becoming a hexagon somewhere', () => {
  // h3-js returns a plausible centroid for garbage that parses as a cell, so a row that is not
  // validated first becomes a real-looking hexagon in the wrong place and never registers as a
  // failure - which would defeat the abort guard below.
  const csv = `${HEADER}\nnot-a-cell,10,90\n841020,10,90\n`;
  const { hexes, stats } = processHexes(csv, { minAircraft: 3, maxHexes: 100, h3: fakeH3 });
  assert.equal(hexes.length, 1);
  assert.equal(stats.conversionFailures, 1);
});

test('a majority of failed conversions aborts instead of publishing a thin file', () => {
  const rows = ['bad1,10,90', 'bad2,10,90', 'bad3,10,90', '841020,10,90'];
  assert.throws(
    () => processHexes(`${HEADER}\n${rows.join('\n')}\n`,
      { minAircraft: 3, maxHexes: 100, h3: fakeH3 }),
    /over half the H3 conversions failed/);
});

test('a day with nothing above the low band publishes empty rather than aborting', () => {
  // The abort guard divides by attempted conversions, and a quiet day attempts none. Without the
  // guard on attempts this threw, which would have turned "aviation is normal today" into a
  // failed mirror run.
  const { hexes, stats } = processHexes(`${HEADER}\n841020,100,1\n842030,200,1\n`,
    { minAircraft: 3, maxHexes: 100, h3: fakeH3 });
  assert.equal(hexes.length, 0);
  assert.equal(stats.droppedLowInterference, 2);
  assert.equal(stats.worstPct, 0);
});

test('the cap keeps the best-evidenced cells, not the smallest samples', () => {
  // The defect the first real run exposed: ordered by percentage, the published file led with
  // three-bad-of-four-aircraft cells at 75% while a large share of a hundred aircraft fell off the
  // end. Wilson's lower bound reverses that, and the *published* percentage is untouched.
  const csv = `${HEADER}\n`
    + '841020,1,3\n'      // 75% of 4 aircraft - loud and thin
    + '842030,55,45\n';   // 45% of 100 aircraft - quieter and solid
  const { hexes } = processHexes(csv, { minAircraft: 3, maxHexes: 1, h3: fakeH3 });
  assert.equal(hexes.length, 1);
  assert.equal(hexes[0].totalAircraft, 100, 'the cap kept the four-aircraft cell');
  assert.equal(hexes[0].pct, 45, 'the published figure is still the raw percentage');
  // And nothing internal leaks into the file.
  assert.equal(hexes[0]._confidence, undefined);

  // The worst percentage in the stats is still the worst *published* one, which is no longer the
  // first row now that ordering is by confidence.
  const both = processHexes(csv, { minAircraft: 3, maxHexes: 10, h3: fakeH3 });
  assert.equal(both.stats.worstPct, 75);
  assert.equal(both.stats.orderedBy, 'wilson95Lower');
});

test('bands and counts survive the reordering', () => {
  const csv = `${HEADER}\n`
    + '841020,70,30\n'   // 30%, high
    + '842030,95,5\n'    // 5%, medium
    + '843040,50,50\n'   // 50%, high
    + '844050,92,8\n';   // 8%, medium
  const all = processHexes(csv, { minAircraft: 3, maxHexes: 100, h3: fakeH3 });
  assert.deepEqual(all.hexes.map((hex) => hex.pct), [50, 30, 8, 5]);
  assert.equal(all.stats.highCount, 2);
  assert.equal(all.stats.mediumCount, 2);
  assert.equal(all.stats.droppedOverCap, 0);

  // The cap keeps the worst, and the file states the remainder so the app can say "2 of 4" rather
  // than implying it holds everything.
  const capped = processHexes(csv, { minAircraft: 3, maxHexes: 2, h3: fakeH3 });
  assert.deepEqual(capped.hexes.map((hex) => hex.pct), [50, 30]);
  assert.equal(capped.stats.droppedOverCap, 2);
  assert.equal(capped.stats.worstPct, 50);
});

test('a grid with no data rows is an error, not an empty publish', () => {
  assert.throws(() => processHexes(`${HEADER}\n`, { minAircraft: 3, maxHexes: 9, h3: fakeH3 }),
    /no data rows/);
});
