# Token Radar — pre-token protocols ranked by implied value

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/silver-finch-59/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/silver-finch-59/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar for the [make.fun](https://make.fun) token-radar-01 bounty: it reads a
sealed DefiLlama snapshot of 758 protocols, ranks the 198 pre-token protocols that could still
launch a token, and hands you a dashboard that shows what each one is worth farming — and exactly
how to farm it.

## What it builds

`main.ts` (Node 22, standard library only) reads `/input/snapshot.json` and writes:

- `board.json` — 198 ranked rows (40 watchlist + 158 early finds), each with an implied value
  in whole dollars and a six-step farm plan.
- `dashboard/` — a static page with no network: search, category and chain filters, a
  watchlist / early-finds scope switch, a sortable board, a live-token view, and a detail
  drawer for every protocol with the full model breakdown.
- `screenshots/` — three views of the dashboard: the board, a protocol detail, a filtered view.
- `dossier.json` — built with the kit's vendored `vendor/makefun-board.ts`.

## The model (radar-2)

Every row is scored by one function of the snapshot's own figures. No protocol name is
special-cased.

```
implied = round( 5 x tvl_usd^0.8
               x (1 + clamp(change_7d, -60, 120) / 100 x 0.5)
               x maturity(age_days)
               x (1 + 0.02 x min(chains - 1, 5))
               x niche )
```

- **Base** uses diminishing returns on TVL: a $2B protocol is not worth 400x a $5M one.
- **Maturity is a ripe window**: it rises from 0.60 to 1.00 over the first 730 days with no
  token, then eases back to 0.85 by day 1825. Two years with no token is ripe; five years
  with no token has had its chance and passed it up.
- **Niche** compares a protocol with the median TVL of its own category (0.90–1.10): a
  category leader is worth more than a small fish in a big pond.
- **Eligibility** applies the watchlist's own exclusion rules to every candidate: no wrapped,
  staked or bridged product of a token that already trades, no exchange product, no versioned
  pool, no CEX. That is why WBTC and staked ETH — the biggest "pre-token" names by TVL —
  are not on the board at all.

The dashboard recomputes every row from the same figures and shows whether its number
matches `board.json`.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

Then open `out/dashboard/index.html` beside `out/data.js` (for example, serve `out/` over
HTTP) and take the three screenshots yourself.

## Entry

- Competition: token-radar-01 — deadline Mon 2026-12-14 10:00 UTC.
- License: MIT — see `LICENSE`.
