# worldwatch-data

Published data files for the **WorldWatch** iOS app. This repo is public so the
app can read it with no credentials; there is nothing here to install or run.

## `ucdp/ucdp-events.json`

The Uppsala Conflict Data Program's Georeferenced Event Dataset, refreshed
weekly by [`.github/workflows/ucdp-mirror.yml`](.github/workflows/ucdp-mirror.yml).

**Why a mirror exists.** UCDP's API requires an `x-ucdp-access-token`, and the
only way to get one is to email their maintainer. Neither option open to an app
works: asking every user to email Uppsala means nobody ever sees conflict data,
and embedding one token makes it extractable, revocable out from under you, and
shares a single 5,000-requests/day quota across every install. So one operator
holds the token here and the app reads the result — the same shape World Monitor
uses, with a GitHub Action in place of a server.

**Licence and attribution.** UCDP GED is released under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), so redistribution is
permitted with credit. The payload carries an `attribution` field and the app
displays it:

> Uppsala Conflict Data Program (UCDP) Georeferenced Event Dataset, Department of
> Peace and Conflict Research, Uppsala University.

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

## Operating

One secret is required: `UCDP_ACCESS_TOKEN`, under
Settings → Secrets and variables → Actions. The workflow commits with the
built-in `GITHUB_TOKEN`, so no personal access token is needed.

Run it by hand from the Actions tab → *Mirror UCDP conflict data* → Run workflow.
A run whose output is byte-identical to the published file makes no commit.
