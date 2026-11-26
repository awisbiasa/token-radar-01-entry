# Token Radar — pre-token protocols ranked by implied value

An entry for make.fun's **token-radar-01** bounty ("Build the best token launch radar").

`main.ts` reads the sealed snapshot at `/input/snapshot.json`, scores every pre-token protocol with the
model in `lib/model.ts`, and writes `/output/board.json`, `/output/data.js`, a copy of `dashboard/` and
`screenshots/`, and `/output/dossier.json` with `buildDossier` from `vendor/makefun-board.ts`.

## The model (`lib/model.ts`)

```
implied = tvl_usd × peer_multiple × maturity × momentum × chain_depth
```

- **peer_multiple** is measured, not assumed: the median market-cap-to-TVL ratio of the snapshot's own
  live-token protocols in the same category (at least 3 peers), blended toward a size-matched median when
  a category has fewer, and winsorised to the live set's 5th–95th percentile so one outlier cannot define
  a lane. No protocol name is special-cased.
- **maturity** discounts a young protocol and rewards a long record with no token (1.1× past 1,095 days).
- **momentum** follows the seven-day change, damped and clamped.
- **chain_depth** rewards TVL spread across chains.

`calibration()` re-runs the same multiple on the snapshot's live protocols and reports the model's own
error, which the dashboard prints: **×3.3 median, 82% of live tokens within 10×**.

## The dashboard (`dashboard/`)

A static, no-network page: a sortable, filterable, searchable board, a sticky detail panel that shows each
row's arithmetic and a seven-step farm plan with what each step costs and how long it takes, a category
table showing where every multiple came from, a live-token view kept apart from the pre-token board, and a
focus layout that gives one protocol a full page. Every value is recomputed in the page from the snapshot
figures, so the board and the page run visibly the same model.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Node 22.18 or later, standard library only. `tools/shoot.mjs` re-renders the three screenshots from the
page with the Chromium binary over CDP (development only; not run by `main.ts`).

## License

MIT — see `LICENSE`.
