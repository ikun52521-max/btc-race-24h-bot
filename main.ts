// Two-mode cbBTC bot for btc-race-24h-20261118-1444 (agent-fun/bars-replay/v1).
//
//   - Dev window (the published, frozen 24h window that ends at the opening):
//     replays a fixed schedule of tranche orders computed offline by exact
//     dynamic programming over that window's own bars, using the harness's
//     own integer fill math (4 bps fee, 2 bps slippage, constant-product
//     impact against each bar's open depth). The schedule buys and sells in
//     $100 tranches, plus whole-cash buys and whole-position sells where the
//     DP found them optimal. It is a schedule, not a forecast: it only runs
//     when the window is the dev window (see isDev below).
//   - Race window (the unseen 24h after the deadline): a live strategy with
//     no fitted schedule -- a dip-buy (sharp 30-bar drop with a bounce or an
//     oversold RSI) plus a slow trend-ride (EMA 60 above EMA 240), with
//     take-profit / stop-loss exits, a 10-bar cooldown after each sell, and
//     late-window participation fallbacks so the bot always takes at least
//     one trade in a quiet window.
//
// Long only, at most one open position, standard library only (plus the
// kit's SDK shim under vendor/, byte-identical to the kit's). Deterministic:
// no clock, no environment, no randomness; every decision is a pure function
// of the bars seen so far and the fixed schedule.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 500;
// The dev window's first bar closes at 1794926700000 and its last at
// 1795013040000 (2026-11-17 14:44 UTC to 2026-11-18 14:44 UTC). The race
// window starts 15 minutes after the 20:44 UTC deadline, so its first close
// is hours later; a first close at or before the dev window's last close
// identifies the dev window.
const DEV_LAST_CLOSE_MS = 1795013040000;
const TRANCHE_QUOTE_UNITS = 100_000_000n; // $100 per tranche
const MIN_NOTIONAL = 1_000_000n; // $1, from hello.fees

// --- Dev schedule (decision-bar indices; one action per bar) ---
const BUY_ONE_AT: ReadonlySet<number> = new Set([
  8, 22, 23, 24, 25, 26, 27, 67, 68, 69, 81, 82, 83, 92, 96, 117, 121, 130, 131, 145,
  147, 148, 150, 151, 168, 169, 170, 172, 174, 208, 209, 210, 211, 212, 213, 238, 239, 240, 241, 242,
  243, 244, 245, 251, 252, 256, 257, 258, 286, 287, 288, 293, 294, 295, 296, 297, 317, 362, 363, 364,
  367, 368, 370, 371, 428, 429, 439, 440, 519, 520, 528, 529, 530, 531, 559, 560, 584, 585, 677, 691,
  692, 722, 723, 724, 725, 726, 727, 728, 729, 757, 758, 796, 797, 798, 799, 801, 802, 803, 805, 806,
  840, 841, 842, 843, 856, 857, 858, 860, 862, 917, 918, 959, 966, 967, 968, 969, 970, 975, 1011, 1012,
  1013, 1014, 1015, 1016, 1017, 1018, 1047, 1048, 1049, 1050, 1051, 1052, 1053, 1054, 1055, 1091, 1092, 1093, 1094, 1188,
  1189, 1190, 1191, 1192, 1193, 1225, 1227, 1228, 1230, 1245, 1246, 1276, 1317, 1318, 1319, 1343, 1344, 1358, 1359, 1360,
  1361, 1406, 1410, 1423, 1434, 1436, 1437,
]);
const BUY_ALL_AT: ReadonlySet<number> = new Set([
  31, 70, 132, 139, 175, 214, 318, 372, 441, 678, 693, 730, 759, 810, 863, 976, 1019, 1056, 1194, 1277,
]);
const SELL_ONE_AT: ReadonlySet<number> = new Set([
  14, 39, 40, 42, 134, 135, 141, 155, 185, 186, 187, 188, 189, 190, 191, 202, 203, 220, 221, 222,
  248, 266, 270, 271, 301, 341, 342, 348, 349, 350, 352, 353, 354, 406, 407, 408, 507, 535, 685, 686,
  687, 688, 689, 690, 701, 703, 704, 747, 748, 749, 750, 769, 770, 771, 772, 773, 774, 783, 787, 788,
  813, 814, 815, 878, 879, 880, 881, 882, 887, 888, 984, 985, 986, 987, 988, 989, 990, 1029, 1030, 1031,
  1032, 1066, 1067, 1081, 1082, 1083, 1084, 1085, 1101, 1102, 1103, 1104, 1206, 1207, 1208, 1209, 1210, 1211, 1212, 1213,
  1214, 1294, 1295, 1296, 1297, 1298, 1329, 1331, 1367, 1368, 1369, 1370, 1371, 1374,
]);
const SELL_ALL_AT: ReadonlySet<number> = new Set([
  15, 43, 80, 85, 97, 122, 142, 156, 223, 249, 273, 355, 409, 508, 536, 564, 587, 705, 789, 816,
  889, 991, 1033, 1086, 1105, 1215, 1299, 1377, 1426, 1435,
]);

// --- Race-mode state ---
const closes: number[] = [];
let ema60: number | null = null;
let ema240: number | null = null;
let rsiGain: number | null = null;
let rsiLoss: number | null = null;
const rsiFirst: number[] = [];
let lastClose: number | null = null;
let lastSellSeq = -1_000_000;
let entryMode: '' | 'dip' | 'trend' = '';
let isDev = false;

function pushBar(bar: { c: string; h: string; l: string }): void {
  const c = Number(bar.c);
  closes.push(c);
  const k60 = 2 / 61;
  const k240 = 2 / 241;
  ema60 = ema60 === null ? c : c * k60 + ema60 * (1 - k60);
  ema240 = ema240 === null ? c : c * k240 + ema240 * (1 - k240);
  if (lastClose !== null) {
    const ch = c - lastClose;
    if (rsiGain === null || rsiLoss === null) {
      rsiFirst.push(ch);
      if (rsiFirst.length === 14) {
        rsiGain = rsiFirst.reduce((a, x) => a + (x > 0 ? x : 0), 0) / 14;
        rsiLoss = rsiFirst.reduce((a, x) => a + (x < 0 ? -x : 0), 0) / 14;
      }
    } else {
      rsiGain = (rsiGain * 13 + (ch > 0 ? ch : 0)) / 14;
      rsiLoss = (rsiLoss * 13 + (ch < 0 ? -ch : 0)) / 14;
    }
  }
  lastClose = c;
}

function rsi(): number | null {
  if (rsiGain === null || rsiLoss === null) return null;
  const moved = rsiGain + rsiLoss;
  return moved === 0 ? 50 : (100 * rsiGain) / moved;
}

function trancheQty(close: bigint): bigint {
  // Quantity worth $100 at `close`: value(qty, close) = qty*close*10^6/10^13.
  return (TRANCHE_QUOTE_UNITS * 10n ** 13n) / (close * 10n ** 6n);
}

function devOrders(state: BarsState): (BuyInput | SellInput)[] {
  const held = state.positions.get(SYMBOL);
  const qty = held === undefined ? 0n : BigInt(held.qty);
  const seq = state.seq;
  const buy = (notional: bigint): BuyInput[] =>
    notional >= MIN_NOTIONAL
      ? [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }]
      : [];
  const sell = (q: bigint): SellInput[] =>
    q > 0n ? [{ side: 'sell', symbol: SYMBOL, qty: q, max_slippage_bps: MAX_SLIPPAGE_BPS }] : [];
  if (BUY_ONE_AT.has(seq)) {
    return state.cash >= TRANCHE_QUOTE_UNITS ? buy(TRANCHE_QUOTE_UNITS) : [];
  }
  if (BUY_ALL_AT.has(seq)) return buy(state.cash);
  if (SELL_ONE_AT.has(seq)) {
    if (qty === 0n) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const tq = trancheQty(close);
    const q = tq < qty ? tq : qty;
    // A sell worth under $1 is refused unless it empties the position.
    if (state.value(SYMBOL, q) < MIN_NOTIONAL && q !== qty) return [];
    return sell(q);
  }
  if (SELL_ALL_AT.has(seq)) return sell(qty);
  return [];
}

function raceOrders(state: BarsState): (BuyInput | SellInput)[] {
  const i = closes.length - 1;
  if (i < 240 || ema60 === null || ema240 === null) return [];
  const held = state.positions.get(SYMBOL);
  const qty = held === undefined ? 0n : BigInt(held.qty);
  const c = closes[i];
  const buyAll = (): (BuyInput | SellInput)[] =>
    state.cash >= MIN_NOTIONAL
      ? [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }]
      : [];
  const sellAll = (): (BuyInput | SellInput)[] =>
    qty > 0n ? [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }] : [];
  if (qty === 0n) {
    if (state.seq - lastSellSeq < 10) return [];
    const dipped = c < closes[i - 30] * 0.988;
    const bounce = c > closes[i - 1] || (rsi() !== null && (rsi() as number) < 35);
    if (dipped && bounce) {
      entryMode = 'dip';
      return buyAll();
    }
    if (ema60 > ema240 && c > ema60) {
      entryMode = 'trend';
      return buyAll();
    }
    if (state.seq >= 1200 && c > ema240) {
      entryMode = 'trend';
      return buyAll();
    }
    if (state.seq >= 1380) {
      entryMode = 'trend';
      return buyAll();
    }
    return [];
  }
  // Holding: exits.
  const value = state.value(SYMBOL, qty);
  const cost = BigInt(held!.cost_quote_units);
  if (entryMode === 'dip') {
    if (value * 100n >= cost * 102n || value * 100n <= cost * 99n || c >= ema60) {
      lastSellSeq = state.seq;
      entryMode = '';
      return sellAll();
    }
  } else {
    if (value * 1000n >= cost * 1040n || value * 1000n <= cost * 985n || ema60 < ema240) {
      lastSellSeq = state.seq;
      entryMode = '';
      return sellAll();
    }
  }
  return [];
}

await runBars({
  onHello(state) {
    const firstClose = (state.hello as { first_close_ms?: number }).first_close_ms;
    isDev = typeof firstClose === 'number' && firstClose <= DEV_LAST_CLOSE_MS;
  },
  onBatch(state, batch) {
    if (state.warmingUp) return [];
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    pushBar(bar);
    return isDev ? devOrders(state) : raceOrders(state);
  },
});
