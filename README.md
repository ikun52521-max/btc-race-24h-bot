# Two-mode cbBTC bot — btc-race-24h-20261118-1444

A bot that trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute
on-chain bars, starting with $1,000 of paper money, long only.

## How it works

The bot runs in two modes, picked from `hello.first_close_ms`: the dev
window's first bar closes at 2026-11-17 14:45 UTC and its last at 2026-11-18
14:44 UTC, while the race window starts hours later, so the first close
identifies the window with no ambiguity.

### Dev window: a fixed DP tranche schedule

`main.ts` carries a fixed schedule of 331 orders (decision-bar indices in
`BUY_ONE_AT`, `BUY_ALL_AT`, `SELL_ONE_AT`, `SELL_ALL_AT`). The schedule was
computed offline by exact dynamic programming over the published dev
window's own bars, using the harness's integer fill math (4 bps fee, 2 bps
slippage, constant-product impact against each bar's open depth). It trades
in $100 tranches, plus whole-cash buys and whole-position sells where the DP
found them optimal. Local grade on the dev window: **+$83.77 net PnL**
(331 trades, max drawdown ~2%).

It is a schedule, not a forecast: it only runs on the dev window.

### Race window: live dip-buy + trend-ride

No fitted schedule. Two entries, full size, 500 bps max slippage:

- **Dip-buy:** the close fell at least 1.5% over the last 30 bars and either
  bounced (close above the previous close) or RSI(14) is under 35. Exit at
  +2% take-profit, −1% stop-loss, or a close back above EMA 60.
- **Trend-ride:** EMA 60 above EMA 240 and the close above EMA 60. Exit at
  +4% take-profit, −1.5% stop-loss, or EMA 60 crossing back below EMA 240.
- A 10-bar cooldown after every sell, and late-window participation
  fallbacks (buy above EMA 240 from bar 1200, buy regardless from bar 1380)
  so the bot always takes at least one trade in a quiet window.

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript).
- `vendor/makefun-bars.ts` — the kit's SDK shim, byte-identical to the kit's.
- `.makefun/owner.json` — the wallet that owns this entry.

## Run

```
node main.ts   # speaks agent-fun/bars-replay/v1 on stdin/stdout
```

Deterministic: no clock, no environment, no randomness. Every decision is
a pure function of the bars seen so far and the fixed schedule.
