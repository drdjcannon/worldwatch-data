# worldwatch-data

Published data files for the **WorldWatch** iOS app. This repo is public so the
app can read it with no credentials; there is nothing here to install or run.

## `ucdp/ucdp-events.json`

The Uppsala Conflict Data Program's Georeferenced Event Dataset, refreshed
weekly by [`.github/workflows/ucdp-mirror.yml`](.github/workflows/ucdp-mirror.yml).

**Why a mirror exists.** Not because of credentials — see below — but because a
phone should not download a 50 MB zip of 418,000 events to display a map. The
workflow does that once a week and publishes a slimmed 2,000-event JSON file
instead, windowed to a year and carrying only the fields the app reads.

**Where the data comes from, and why not the API.** UCDP's REST API requires an
`x-ucdp-access-token` obtainable only by emailing their maintainer — confirmed
2026-08-03, when an unauthenticated run answered `401 "API token required"` for
every one of v26.1, v25.1 and v24.1.

It turns out that does not matter. UCDP publishes **the same data** as static
CSV downloads at [ucdp.uu.se/downloads](https://ucdp.uu.se/downloads/) with no
token, no login and no rate limit, so the script fetches those. Two files: the
annual GED release as the base, and the monthly Candidate release merged on top
for recency (the annual is ~7 months stale by design; the candidate is under a
month).

**Licence and attribution.** UCDP's download page states that all datasets are
"free of charge and licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — you are free to use
and redistribute them provided you cite the relevant publications". So
redistribution here is explicitly granted. The payload carries an `attribution`
field and the app displays it:

> Uppsala Conflict Data Program (UCDP) Georeferenced Event Dataset, Department of
> Peace and Conflict Research, Uppsala University. CC BY 4.0. Davies, Pettersson,
> Öberg (2026) Journal of Peace Research; Sundberg & Melander (2013) Journal of
> Peace Research 50(4).

Cite UCDP, not this repo, if you use the data.

### Shape

```jsonc
{
  "schema": 1,              // bumped only on a breaking change
  "generatedAt": "...",
  "annualVersion": "25.1",  // UCDP's finalized annual release
  "candidateVersion": "26.0.7",
  "newestEventAt": "2026-07-02",
  "oldestEventAt": "2025-07-05",
  "eventCount": 2000,
  "attribution": "...",
  "events": [ /* UCDP's own field names, unchanged */ ]
}
```

Event objects keep UCDP's field names (`date_start`, `side_a`, `best`,
`type_of_violence`, …) so the app's decoder reads the mirror and the live API
identically.

### Health

`newestEventAt` is the signal worth watching. UCDP publishes a monthly **GED
Candidate** release lagging about a month, on top of an annual release lagging
about seven. A newest event ~30 days old means the candidate merge is working;
~210 days means it silently died and only the annual base is landing. The
workflow warns above 90 days and reports it in the run summary.

## Consuming it

Prefer jsDelivr, which is built to serve GitHub content at scale:

```
https://cdn.jsdelivr.net/gh/drdjcannon/worldwatch-data@main/ucdp/ucdp-events.json
```

`raw.githubusercontent.com` also works and the app falls back to it, but it is
not a CDN and GitHub's terms discourage using it as one.

## Status

Live since 2026-08-03. The published file carries 2,000 events; the last run
reported `newestEventAt` 2026-06-30, a 34-day content lag, which means the
candidate merge is working (annual-only would be ~7 months).

## Operating

**No secrets required.** The workflow commits with the built-in `GITHUB_TOKEN`,
and the UCDP downloads need no credential, so there is nothing to configure.

Run it by hand from the Actions tab → *Mirror UCDP conflict data* → Run workflow.
A run whose output is byte-identical to the published file makes no commit.

If a run fails, it commits the tail of its own output to `ucdp/last-error.log`.
Read that first.

**When a new UCDP release lands**, bump `ANNUAL_URL` / `ANNUAL_VERSION` and
`CANDIDATE_URL` / `CANDIDATE_VERSION` at the top of
[`tools/mirror-ucdp.mjs`](tools/mirror-ucdp.mjs). The versions are in the URL
rather than probed, so a stale URL fails the run loudly with a 404 instead of
quietly publishing last year's data. Check
[ucdp.uu.se/downloads](https://ucdp.uu.se/downloads/) for the current filenames.
