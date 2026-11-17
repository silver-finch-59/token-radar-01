// Radar-2, the token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board always covers the snapshot's whole watchlist (the floor, never a ceiling), plus every
// other pre-token protocol that survives the watchlist's own exclusion rules: nothing wrapped,
// staked or bridged from a token that already trades, no exchange product, no versioned pool, no
// CEX. A protocol counts as pre-token when its index entry records no token at all — no market
// cap, no CoinGecko id, no symbol. Protocols that already trade are kept apart and shown at the
// market's own values, never mixed into the ranked board.
//
// Implied value comes only from the snapshot's own figures, never from a hand-kept list of names:
//
//   base     = 5 * tvl_usd^0.8        (diminishing returns: a $2B protocol is not 400x a $5M one)
//   growth   = clamp(change_7d, -60, 120), in per cent
//   growth   = 1 + (growth / 100) * 0.5
//   maturity = a ripe window on age_days: 0.6 rising to 1.0 across the first 730 days without a
//              token, then easing back to 0.85 by day 1825. Two years with no token is ripe; five
//              years with no token has had its chance and passed it up. (age_days unknown: 365)
//   chain    = 1 + 0.02 * min(chains - 1, 5)   (each extra chain is a little more surface to farm)
//   niche    = 0.9 + 0.05 * log2(tvl / categoryMedian), clamped to [0.9, 1.1]
//              (leading its own category is worth more than being a small fish in a big pond)
//   implied  = max(1, round(base * growth * maturity * chain * niche))
//
// The numbers above are the house model's, stated in the dashboard and changeable in its sandbox.
// No protocol name is ever special-cased: one function scores every row.

const MS_PER_DAY = 86_400_000;

/** Refusal to score: raised whenever the snapshot is not the shape the model scores. */
export class SnapshotError extends Error {
  constructor(message: string) { super(message); this.name = 'SnapshotError'; }
}

/** One protocol entry from the sealed snapshot: exactly the ten fields the input carries. */
export interface SnapshotProtocol {
  slug: string; name: string; chains: string[]; category: string | null;
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
}

/** The whole snapshot document, as the sealed input carries it. */
export interface Snapshot {
  as_of: string; source: string; floor_usd: number;
  protocols: SnapshotProtocol[]; watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox lets the reader change them. */
export interface ModelConstants {
  base_scale: number; base_exponent: number; growth_weight: number;
  growth_floor: number; growth_cap: number; maturity_floor: number;
  maturity_peak_days: number; maturity_decay_days: number; maturity_decay_to: number;
  unknown_age_days: number; chain_step: number; chain_max_bonus: number;
  niche_step: number; niche_floor: number; niche_cap: number;
}

export const MODEL: ModelConstants = {
  base_scale: 5, base_exponent: 0.8, growth_weight: 0.5, growth_floor: -60, growth_cap: 120,
  maturity_floor: 0.6, maturity_peak_days: 730, maturity_decay_days: 1095, maturity_decay_to: 0.85,
  unknown_age_days: 365, chain_step: 0.02, chain_max_bonus: 5,
  niche_step: 0.05, niche_floor: 0.9, niche_cap: 1.1,
};

/** The model's version label: the dashboard names it, and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, ordered by market cap. */
export const LIVE_ROWS = 24;

/** A usable number, or `fallback` when the value is missing or not finite. */
function pickNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fallback;
}

/** Whole days from the listing date to the snapshot date, never below zero; null when a date is missing or unparsable. */
export function ageDays(snapshotDate: string, listedDate: string | null): number | null {
  if (listedDate === null) return null;
  const start = Date.parse(`${snapshotDate}T00:00:00Z`);
  const end = Date.parse(`${listedDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((start - end) / MS_PER_DAY));
}

/** The maturity multiplier for an age in days, on the ripe window. */
export function maturityMultiplier(daysOld: number | null, model: ModelConstants): number {
  const days = daysOld ?? model.unknown_age_days;
  if (days <= model.maturity_peak_days) {
    return model.maturity_floor + (1 - model.maturity_floor) * (days / model.maturity_peak_days);
  }
  const pastPeak = Math.min(days - model.maturity_peak_days, model.maturity_decay_days);
  return 1 - (1 - model.maturity_decay_to) * (pastPeak / model.maturity_decay_days);
}

/** The multiplier for how many chains a protocol runs on. */
export function chainMultiplier(count: number, model: ModelConstants): number {
  return 1 + model.chain_step * Math.min(Math.max(count - 1, 0), model.chain_max_bonus);
}

/** The niche multiplier: the protocol's TVL weighed against its category's median TVL. */
export function nicheMultiplier(value: number, median: number, model: ModelConstants): number {
  if (!(median > 0) || !(value > 0)) return 1;
  const log2 = Math.log(value / median) / Math.log(2);
  return Math.min(model.niche_cap, Math.max(model.niche_floor, 1 + model.niche_step * log2));
}

/** The base value from TVL alone, before any multiplier, with diminishing returns. */
export function baseValue(value: number, model: ModelConstants): number {
  return model.base_scale * Math.pow(Math.max(value, 0), model.base_exponent);
}

/** Every multiplier and the implied value one protocol earns under `model`. */
export function impliedValue(
  entry: SnapshotProtocol,
  day: string,
  median: number,
  model: ModelConstants,
): { implied: number; base: number; growthPct: number; growthMult: number; maturityMult: number; chainMult: number; nicheMult: number; age: number | null } {
  const age = ageDays(day, entry.listed_at);
  const clipped = Math.min(model.growth_cap, Math.max(model.growth_floor, pickNumber(entry.change_7d, 0)));
  const growthMult = 1 + (clipped / 100) * model.growth_weight;
  const maturityMult = maturityMultiplier(age, model);
  const chainMult = chainMultiplier(entry.chains.length, model);
  const nicheMult = nicheMultiplier(entry.tvl_usd, median, model);
  const base = baseValue(entry.tvl_usd, model);
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * chainMult * nicheMult));
  return { implied, base, growthPct: clipped, growthMult, maturityMult, chainMult, nicheMult, age };
}

/** DefiLlama's version-marker rule: a name that ends in a release is a pool of another protocol. */
const VERSION_MARK = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories the watchlist leaves out: a bridged, staked or exchange product is not a launch in its own right. */
const SKIP_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Exchange names: a product beginning with one belongs to the exchange, not a new protocol. */
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** True when a protocol records no token at all. */
export function isPreToken(entry: SnapshotProtocol): boolean {
  return entry.mcap_usd === null && entry.gecko_id === null && entry.symbol === null;
}

/** Whether the board may rank a protocol: pre-token, not an exchange, not a versioned pool, and
 *  not a wrapped, staked or bridged product of a token that already trades. The watchlist's own
 *  exclusion rule, applied to every candidate rather than only to the floor. */
export function isRankable(entry: SnapshotProtocol): boolean {
  if (!isPreToken(entry)) return false;
  if (entry.category !== null && SKIP_CATEGORIES.has(entry.category)) return false;
  if (VERSION_MARK.test(entry.name)) return false;
  if (/\b(wrapped|staked|staking)\b/i.test(entry.name)) return false;
  if (EXCHANGE_NAMES.some((e) => entry.name.startsWith(e))) return false;
  return true;
}

/** A farm step: its action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string; cost: string; time: string;
}

/** One row of board.json: a ranked board row, with the model's working shown. */
export interface BoardRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
  token_status: 'pre-token'; age_days: number | null; implied_value_usd: number;
  model: {
    base_usd: number; growth_pct: number; growth_multiplier: number; maturity_multiplier: number;
    chain_multiplier: number; niche_multiplier: number; category_median_tvl_usd: number; age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row; the farm plan is generated in the page. */
export interface RadarRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null; listed_at: string | null;
  age_days: number | null; implied_value_usd: number;
  growth_multiplier: number; maturity_multiplier: number; chain_multiplier: number; niche_multiplier: number;
  category_median_tvl_usd: number; driver: string;
}

/** A live-token protocol: it already trades, so the board shows the market's own value rather than a model's. */
export interface LiveRow {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; mcap_usd: number | null; change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model behind them. */
export interface RadarData {
  as_of: string; source: string; floor_usd: number; model: ModelConstants; model_version: string;
  watchlist_size: number; watchlist_slugs: string[];
  board_size: number; early_size: number; live_size: number;
  rows: RadarRow[]; live: LiveRow[];
}

/** The headline sentence's figures: watchlist slugs, rows on the board, live protocols set aside. */
export interface BoardSummary {
  watchlist_size: number; board_size: number; early_size: number; live_size: number;
}

/** The snapshot's protocols indexed by slug. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  const index = new Map<string, SnapshotProtocol>();
  for (const entry of protocols) index.set(entry.slug, entry);
  return index;
}

/** The median of a sorted list of numbers (lower middle on an even count, for determinism). */
function lowerMiddle(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const middle = Math.floor((sorted.length - 1) / 2);
  return sorted[middle] as number;
}

/** Four decimals, for the multipliers the board prints. */
function round4dp(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** The single strongest driver of a row's rank, in plain words. */
interface DriverRule {
  test: (v: { growthMult: number; maturityMult: number; chainMult: number; nicheMult: number }) => boolean;
  label: string;
}
const DRIVER_RULES: DriverRule[] = [
  { test: (v) => v.growthMult >= 1.15, label: 'Strong 7d growth' },
  { test: (v) => v.maturityMult >= 0.97, label: 'Ripe age window' },
  { test: (v) => v.nicheMult >= 1.06, label: 'Category leader' },
  { test: (v) => v.chainMult >= 1.06, label: 'Multi-chain reach' },
  { test: (v) => v.growthMult >= 1.05, label: 'Growing fast' },
];
export function driverOf(v: { growthMult: number; maturityMult: number; chainMult: number; nicheMult: number; age: number | null }): string {
  for (const rule of DRIVER_RULES) if (rule.test(v)) return rule.label;
  return 'Large TVL base';
}

/** The protocols the board ranks: the watchlist first, then every other rankable protocol. */
function gatherCandidates(snapshot: Snapshot): Map<string, SnapshotProtocol> {
  const index = indexBySlug(snapshot.protocols);
  const picked = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug on it, even one the snapshot no longer carries (it cannot,
  // but the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const found = index.get(slug);
    if (found !== undefined) picked.set(slug, found);
  }
  // The early radar: every other pre-token protocol that passes the watchlist's exclusion rules,
  // above or below the floor. A picked protocol stays picked.
  for (const entry of snapshot.protocols) {
    if (!picked.has(entry.slug) && isRankable(entry)) picked.set(entry.slug, entry);
  }
  return picked;
}

/** Each category's median TVL over the chosen set, for the niche multiplier. */
function mediansByCategory(chosen: Iterable<SnapshotProtocol>): Map<string, number> {
  const grouped = new Map<string, number[]>();
  for (const entry of chosen) {
    const key = entry.category ?? 'Other';
    const list = grouped.get(key) ?? [];
    list.push(entry.tvl_usd);
    grouped.set(key, list);
  }
  const medians = new Map<string, number>();
  for (const [key, list] of grouped) medians.set(key, lowerMiddle([...list].sort((a, b) => a - b)));
  return medians;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const chosen = gatherCandidates(snapshot);
  const medians = mediansByCategory(chosen.values());
  const scored = [...chosen.values()].map((entry) => {
    const median = medians.get(entry.category ?? 'Other') ?? entry.tvl_usd;
    const v = impliedValue(entry, snapshot.as_of, median, model);
    return { entry, median, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.entry.slug < b.entry.slug ? -1 : a.entry.slug > b.entry.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1, slug: s.entry.slug, name: s.entry.name, category: s.entry.category, chains: s.entry.chains,
    tvl_usd: s.entry.tvl_usd, change_7d: s.entry.change_7d, mcap_usd: s.entry.mcap_usd, listed_at: s.entry.listed_at,
    gecko_id: s.entry.gecko_id, symbol: s.entry.symbol, token_status: 'pre-token', age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_usd: Math.round(s.base), growth_pct: s.growthPct,
      growth_multiplier: round4dp(s.growthMult), maturity_multiplier: round4dp(s.maturityMult),
      chain_multiplier: round4dp(s.chainMult), niche_multiplier: round4dp(s.nicheMult),
      category_median_tvl_usd: s.median, age_days: s.age,
    },
    farm_steps: farmSteps(s.entry, s.age).map(stepText),
  }));
}

/** One step as a single string: action first, then cost and time, inside the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  const joined = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
  if (joined.length > 600) return joined.slice(0, 596) + '...';
  if (joined.length < 20) return joined + " Hold the position and check the protocol's own page.";
  return joined;
}

/** The first chain a protocol names, or a neutral phrase when it names none. */
function firstChain(p: SnapshotProtocol): string {
  const first = p.chains[0];
  return first !== undefined ? first : 'its main chain';
}

/** The capital one farm position needs, sized from the protocol's own TVL. */
function stakeSize(p: SnapshotProtocol): number {
  const tvl = p.tvl_usd;
  if (tvl >= 5000000000) return 250;
  if (tvl >= 1000000000) return 150;
  return tvl >= 100000000 ? 100 : 50;
}

/** The hold length, from the protocol's age: younger protocols earn a longer qualifying window. */
function holdDays(age: number | null): number {
  if (age === null) return 30;
  return age < 180 ? 60 : age < 365 ? 45 : 30;
}

/** One entry action: the category keywords it answers to, and the sentence it writes. */
interface EntryAction {
  words: string[];
  write: (name: string, capital: number, chain: string) => string;
}

/** The first action of a farm plan, by category. The table is read top to bottom; the first row
 *  whose keywords appear in the category wins, and the last row is the fallback for the rest. */
const ENTRY_ACTIONS: EntryAction[] = [
  { words: ['lend', 'cdp', 'collateral'], write: (name, capital, chain) => `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.` },
  { words: ['dex', 'yield', 'leveraged farm'], write: (name, capital, chain) => `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.` },
  { words: ['bridge'], write: (name, capital, chain) => `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.` },
  { words: ['staking', 'restak'], write: (name, capital, chain) => `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.` },
  { words: ['perpetual', 'derivative'], write: (name, capital, chain) => `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.` },
  { words: ['prediction'], write: (name, capital, chain) => `Fund $${capital} and place one market position on ${name}.` },
  { words: ['curator', 'allocator', 'capital'], write: (name, capital, chain) => `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.` },
  { words: ['stable'], write: (name, capital, chain) => `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.` },
  { words: ['rwa'], write: (name, capital, chain) => `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.` },
  { words: ['insurance'], write: (name, capital, chain) => `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.` },
  { words: ['basis'], write: (name, capital, chain) => `Deposit $${capital} into ${name}'s basis vault on ${chain} and hold the receipt.` },
  { words: ['chain'], write: (name, capital, chain) => `Use $${capital} of the chain's native asset in ${name}'s app on ${chain} and keep the position.` },
  { words: [], write: (name, capital, chain) => `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.` },
];

/** The category's one action, worded so a farmer can follow it. */
function entryAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const category = (p.category ?? '').toLowerCase();
  for (const row of ENTRY_ACTIONS) {
    if (row.words.length === 0 || row.words.some((w) => category.includes(w))) return row.write(p.name, capital, chain);
  }
  return ENTRY_ACTIONS[ENTRY_ACTIONS.length - 1]?.write(p.name, capital, chain) ?? '';
}

/** One weekly action: the category keywords it answers to, and the sentence it writes. */
interface WeeklyAction {
  words: string[];
  write: (name: string) => string;
}

/** The weekly qualifying action for the category, so the plan is not the same every week. */
const WEEKLY_ACTIONS: WeeklyAction[] = [
  { words: ['lend', 'cdp', 'collateral'], write: (name) => `Borrow a small amount against the deposit on ${name}, then repay it the same week.` },
  { words: ['dex', 'yield', 'leveraged farm'], write: (name) => `Swap a small amount through ${name}'s main pool, or add and remove a little liquidity.` },
  { words: ['bridge'], write: (name) => `Bridge a small amount through ${name} and use it in the destination app.` },
  { words: ['staking', 'restak'], write: (name) => `Restake the week's rewards through ${name} so the stake keeps growing.` },
  { words: ['perpetual', 'derivative'], write: (name) => `Open and close one small hedge on ${name} and keep the trade history.` },
  { words: ['prediction'], write: (name) => `Settle one market position on ${name} and open the next one.` },
  { words: ['curator', 'allocator', 'capital'], write: (name) => `Check ${name}'s vault allocation for the week and add a small top-up.` },
  { words: ['rwa'], write: (name) => `Check ${name}'s yield accrual for the week and reinvest a small amount.` },
  { words: ['insurance'], write: (name) => `Check ${name}'s cover terms for the week and renew if the policy lapses.` },
  { words: [], write: (name) => `Do one real action on ${name} this week, such as a deposit, a swap or a vote.` },
];

/** The weekly qualifying action for the category, worded so a farmer can follow it. */
function weeklyAction(p: SnapshotProtocol): string {
  const category = (p.category ?? '').toLowerCase();
  for (const row of WEEKLY_ACTIONS) {
    if (row.words.length === 0 || row.words.some((w) => category.includes(w))) return row.write(p.name);
  }
  return WEEKLY_ACTIONS[WEEKLY_ACTIONS.length - 1]?.write(p.name) ?? '';
}

/** The gas a setup step costs, from the size of the position. */
function setupGas(capital: number): number {
  return capital >= 150 ? 8 : 4;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan comes from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const capital = stakeSize(p);
  const hold = holdDays(age);
  const action = entryAction(p, capital, chain);
  const weekly = weeklyAction(p);
  return [
    { text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`, cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
    { text: action, cost: `$${capital} of capital and about $${setupGas(capital)} of gas`, time: '15 minutes to set up' },
    { text: weekly, cost: 'about $2 of gas a week', time: '10 minutes a week' },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
    { text: `Write the wallet, the dates and every transaction in a farm log, then unwind gradually instead of withdrawing everything at once.`, cost: 'nothing but the log', time: '5 minutes' },
  ];
}

/** The live-token protocols for the dashboard's Live token view, by market cap. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const trading = snapshot.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX');
  trading.sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd);
  return trading.slice(0, LIVE_ROWS).map((p) => ({
    slug: p.slug, name: p.name, category: p.category, chains: p.chains,
    tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d,
  }));
}

/** A board row's compact form for data.js; the farm plan is generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank, slug: row.slug, name: row.name, category: row.category, chains: row.chains,
    tvl_usd: row.tvl_usd, change_7d: row.change_7d, mcap_usd: row.mcap_usd, listed_at: row.listed_at,
    age_days: row.age_days, implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier, maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier, niche_multiplier: row.model.niche_multiplier,
    category_median_tvl_usd: row.model.category_median_tvl_usd,
    driver: driverOf({
      growthMult: row.model.growth_multiplier, maturityMult: row.model.maturity_multiplier,
      chainMult: row.model.chain_multiplier, nicheMult: row.model.niche_multiplier, age: row.age_days,
    }),
  };
}

/** Everything the dashboard renders, built from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd,
    model, model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length, watchlist_slugs: snapshot.watchlist,
    board_size: board.length, early_size: early, live_size: live.length,
    rows: board.map(radarRow), live,
  };
  return { board, radar };
}

/** One protocol entry out of a raw JSON value; refused unless it carries a slug, a name and a TVL. */
function readProtocol(value: unknown, index: number): SnapshotProtocol {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SnapshotError(`snapshot.json's protocol ${index} is not an object`);
  }
  const fields = value as Record<string, unknown>;
  if (typeof fields.slug !== 'string' || typeof fields.name !== 'string' || typeof fields.tvl_usd !== 'number' || !Number.isFinite(fields.tvl_usd)) {
    throw new SnapshotError(`snapshot.json's protocol ${index} lacks a slug, a name or a TVL`);
  }
  return {
    slug: fields.slug, name: fields.name,
    chains: Array.isArray(fields.chains) ? fields.chains.filter((c): c is string => typeof c === 'string') : [],
    category: typeof fields.category === 'string' ? fields.category : null, tvl_usd: fields.tvl_usd,
    change_7d: typeof fields.change_7d === 'number' && Number.isFinite(fields.change_7d) ? fields.change_7d : null,
    mcap_usd: typeof fields.mcap_usd === 'number' && Number.isFinite(fields.mcap_usd) ? fields.mcap_usd : null,
    listed_at: typeof fields.listed_at === 'string' ? fields.listed_at : null,
    gecko_id: typeof fields.gecko_id === 'string' ? fields.gecko_id : null, symbol: typeof fields.symbol === 'string' ? fields.symbol : null,
  };
}

/** The snapshot out of a file's text, refused unless it has the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new SnapshotError('snapshot.json is not a JSON object');
  const root = parsed as Record<string, unknown>;
  if (typeof root.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(root.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof root.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof root.floor_usd !== 'number' || !Number.isSafeInteger(root.floor_usd) || root.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(root.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(root.watchlist) || root.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  return {
    as_of: root.as_of, source: root.source, floor_usd: root.floor_usd,
    protocols: root.protocols.map((v, i) => readProtocol(v, i)), watchlist: root.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, a single shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const present = new Set(board.map((r) => r.slug));
  const absent = snapshot.watchlist.filter((s) => !present.has(s));
  if (absent.length > 0) return `the board misses ${absent.length} watchlist slug${absent.length === 1 ? '' : 's'}: ${absent.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank);
  ranks.sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if ((board[i] as BoardRow).implied_value_usd > (board[i - 1] as BoardRow).implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]?.implied_value_usd === board[board.length - 1]?.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]?.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const row of board) {
    const steps = row.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${row.slug} has ${steps.length} farm steps`;
    for (const step of steps) {
      if (step.length < 20 || step.length > 600) return `${row.slug} has a farm step of ${step.length} characters`;
    }
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) return `${row.slug} has implied value ${row.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset in one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return 'window.RADAR=' + JSON.stringify(radar) + ';\n';
}
