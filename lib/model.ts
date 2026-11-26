// Token Radar's value model, v3 ("peer-multiple").
//
// The model has one job: put a dollar figure on a token that does not exist yet, from the snapshot's own
// figures, and say out loud why. No protocol name is special-cased anywhere in this file; every number a
// row gets falls out of tvl_usd, change_7d, listed_at, category and chains.
//
//   implied = tvl_usd x peer_multiple(category, tvl_usd)
//                     x maturity(age_days)
//                     x momentum(change_7d)
//                     x chain_depth(chains.length)
//
// peer_multiple is MEASURED, not assumed. It is the median mcap/tvl ratio of the snapshot's own
// live-token protocols in the same category (at least 3 of them), or a blend of that category's median
// and the size-matched median when the category has 1-2, or the size-matched median alone when it has
// none. The size-matched median is the median ratio of live protocols within 0.75 decades of TVL. That is
// how the model learns "Risk Curators trade at 1.5x their TVL" and "Onchain Capital Allocators trade at
// 0.03x" without anyone typing either number.
//
// maturity discounts a young protocol (its token, if it comes, is not yet a business) and rewards a long
// record with no token (it has been worth something to users for longer than a launch would have been
// needed to fund it). momentum follows the seven-day change with a damped coefficient, clamped so one
// week cannot swing a lifetime estimate. chain_depth rewards TVL spread over more chains because that is
// what makes a token launchable across a market rather than on one island.
//
// Every multiplier is emitted on the row, with its inputs, so the dashboard can show the arithmetic and
// the dossier can state the formula. The probe re-runs the same function on the snapshot's live rows to
// measure the model's own error, which the dashboard prints.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelConstants {
  /** peer_multiple: minimum live peers in a category before its median is used on its own. */
  min_peers: number;
  /** peer_multiple: weight of the category median when the category has 1..min_peers-1 peers. */
  blend_weight: number;
  /** peer_multiple: the size band, in log10 decades of TVL, for the size-matched median. */
  size_band_decades: number;
  /** maturity: growth towards 1 from maturity_floor, reaching it at maturity_days. */
  maturity_floor: number;
  maturity_days: number;
  /** maturity: the age past maturity_days at which a long record is rewarded (extra_maturity above 1). */
  extra_maturity_at: number;
  extra_maturity: number;
  unknown_age_days: number;
  /** momentum: coefficient on the clamped seven-day change, and the clamp in per cent. */
  momentum_weight: number;
  momentum_floor: number;
  momentum_cap: number;
  /** chain_depth: extra multiple per extra chain, capped at chain_depth_cap chains. */
  chain_depth_step: number;
  chain_depth_cap: number;
}

export const MODEL: ModelConstants = {
  min_peers: 3,
  blend_weight: 0.5,
  size_band_decades: 0.75,
  maturity_floor: 0.55,
  maturity_days: 730,
  extra_maturity_at: 1095,
  extra_maturity: 1.1,
  unknown_age_days: 365,
  momentum_weight: 0.35,
  momentum_floor: -50,
  momentum_cap: 100,
  chain_depth_step: 0.03,
  chain_depth_cap: 6,
};

export const MODEL_VERSION = 'peer-multiple v3';

/** How many pre-token protocols below the watchlist floor the early radar carries, by implied value. */
export const EARLY_ROWS = 260;

/** How many live-token protocols the Live view carries, by market cap. */
export const LIVE_ROWS = 40;

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  on_watchlist: boolean;
  model: {
    peer_multiple: number;
    peer_source: 'category' | 'blend' | 'size';
    peer_count: number;
    maturity: number;
    momentum: number;
    chain_depth: number;
    floor_reason: string;
  };
  farm_steps: string[];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  on_watchlist: boolean;
  peer_multiple: number;
  peer_source: string;
  peer_count: number;
  maturity: number;
  momentum: number;
  chain_depth: number;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  /** mcap/tvl as the market priced it. */
  ratio: number | null;
}

export interface CategoryStat {
  category: string;
  live_peers: number;
  median_ratio: number;
  p25_ratio: number;
  p75_ratio: number;
  rows: number;
  top_implied_usd: number;
}

export interface Calibration {
  /** How many live protocols the size-matched pool was drawn from. */
  live_pool: number;
  /** Median median-ratio across all live protocols. */
  median_ratio: number;
  /** Model error: median absolute log10 error predicting live protocol mcap from its own ratio model. */
  median_log10_error: number;
  within_10x_pct: number;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  categories: CategoryStat[];
  calibration: Calibration;
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function quantile(values: number[], q: number): number {
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * q)))]!;
}

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
const NOT_A_LAUNCH = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

/**
 * Whether a protocol is a launch to watch: pre-token, and not a wrapped, staked or bridged product of a
 * token that already trades. The watchlist applies the same test and is the floor; the early radar applies
 * it too, so a bridge or a wrapped BTC is never ranked as if its token were still to come.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && NOT_A_LAUNCH.has(p.category)) return false;
  if (VERSIONED.test(p.name) || WRAPPED.test(p.name) || EXCHANGE.test(p.name)) return false;
  return true;
}

/** A live protocol with a usable market cap and TVL: a peer the model learns a ratio from. */
function isPeer(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX';
}

const ratioOf = (p: SnapshotProtocol): number => (p.mcap_usd as number) / p.tvl_usd;

/** The measured tables: the category medians and the size-matched fallback, from the snapshot's live set. */
export interface PeerTable {
  byCategory: Map<string, number[]>;
  live: SnapshotProtocol[];
  overallMedian: number;
  /** The winsorising band the ratios were clamped to, so the page can state it. */
  band: { low: number; high: number };
}

export function peerTable(snapshot: Snapshot): PeerTable {
  const live = snapshot.protocols.filter(isPeer);
  const all = live.map(ratioOf);
  // Winsorise to the 5th..95th percentile of the whole live set: one protocol whose token trades far above
  // its TVL (or far below) must not become a category's multiple. The band is stated on the page.
  const low = quantile(all, 0.05);
  const high = quantile(all, 0.95);
  const clamp = (x: number): number => Math.min(high, Math.max(low, x));
  const byCategory = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? '(uncategorised)';
    const list = byCategory.get(key) ?? [];
    list.push(clamp(ratioOf(p)));
    byCategory.set(key, list);
  }
  return { byCategory, live, overallMedian: median(all.map(clamp)), band: { low, high } };
}

/** The median ratio of live protocols within `band` decades of `tvl`, or of the whole live set if too few. */
function sizeRatio(table: PeerTable, tvl: number, band: number): number {
  const centre = Math.log10(Math.max(tvl, 1));
  const near = table.live.filter((p) => Math.abs(Math.log10(p.tvl_usd) - centre) < band);
  const pool = near.length >= 5 ? near : table.live;
  const clamp = (x: number): number => Math.min(table.band.high, Math.max(table.band.low, x));
  return median(pool.map((p) => clamp(ratioOf(p))));
}

/** The peer multiple a pre-token protocol gets, with where it came from so the page can say it. */
export function peerMultiple(p: SnapshotProtocol, table: PeerTable, model: ModelConstants): { multiple: number; source: 'category' | 'blend' | 'size'; count: number } {
  const cat = table.byCategory.get(p.category ?? '(uncategorised)') ?? [];
  const near = sizeRatio(table, p.tvl_usd, model.size_band_decades);
  if (cat.length === 0) return { multiple: near, source: 'size', count: 0 };
  if (cat.length >= model.min_peers) {
    // A category with enough peers stands on its own median, shrunk by one-peer's worth of the size median
    // so a handful of names cannot swing the whole category.
    const w = cat.length / (cat.length + 1);
    return { multiple: w * median(cat) + (1 - w) * near, source: 'category', count: cat.length };
  }
  // One or two peers: shrink harder, the category earning at most half the weight.
  const weight = (cat.length / model.min_peers) * model.blend_weight;
  return { multiple: weight * median(cat) + (1 - weight) * near, source: 'blend', count: cat.length };
}

/** maturity: a young protocol is discounted; one past `extra_maturity_at` days with no token is rewarded. */
export function maturityOf(age: number | null, model: ModelConstants): number {
  const a = Math.min(age ?? model.unknown_age_days, model.extra_maturity_at);
  const ramp = model.maturity_floor + (1 - model.maturity_floor) * (Math.min(a, model.maturity_days) / model.maturity_days);
  return a >= model.extra_maturity_at ? ramp * model.extra_maturity : ramp;
}

/** momentum: damped, clamped seven-day change. */
export function momentumOf(change: number | null, model: ModelConstants): number {
  const pct = Math.min(model.momentum_cap, Math.max(model.momentum_floor, finite(change, 0)));
  return 1 + (pct / 100) * model.momentum_weight;
}

/** chain_depth: more chains, a little more launchable. */
export function chainDepthOf(chains: number, model: ModelConstants): number {
  const n = Math.min(Math.max(chains, 1), model.chain_depth_cap);
  return 1 + (n - 1) * model.chain_depth_step;
}

export interface Scored {
  implied: number;
  multiple: number;
  source: 'category' | 'blend' | 'size';
  count: number;
  maturity: number;
  momentum: number;
  chainDepth: number;
  age: number | null;
}

export function score(p: SnapshotProtocol, asOf: string, table: PeerTable, model: ModelConstants): Scored {
  const age = ageDays(asOf, p.listed_at);
  const peer = peerMultiple(p, table, model);
  const maturity = maturityOf(age, model);
  const momentum = momentumOf(p.change_7d, model);
  const chainDepth = chainDepthOf(p.chains.length, model);
  const raw = p.tvl_usd * peer.multiple * maturity * momentum * chainDepth;
  const implied = Math.min(1e14, Math.max(1, Math.round(raw)));
  return { implied, multiple: peer.multiple, source: peer.source, count: peer.count, maturity, momentum, chainDepth, age };
}

// ---------------------------------------------------------------------------------------------
// Farm plans. One derivation for every protocol, keyed on category, chains, TVL and age; the steps
// name what to do, what it costs, and how long it takes. No protocol name is special-cased.

function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(tvl: number): number {
  if (tvl >= 5_000_000_000) return 500;
  if (tvl >= 1_000_000_000) return 300;
  if (tvl >= 250_000_000) return 200;
  if (tvl >= 50_000_000) return 100;
  return 50;
}

function holdFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

/** The one action the category calls for, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  const cash = `$${capital}`;
  if (c.includes('risk curator') || c.includes('vault curator')) return `Deposit ${cash} of USDC into a ${n} curated vault on ${chain}, spread over two of its strategies, and keep the vault shares.`;
  if (c.includes('capital allocator')) return `Deposit ${cash} of USDC into one ${n} vault on ${chain} and leave it to the allocator rather than moving it between vaults.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('money market')) return `Supply ${cash} of USDC to ${n} on ${chain} and keep the position open for weekly snapshots.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('farm')) return `Provide ${cash} of liquidity to ${n}'s deepest pool on ${chain} and leave the position open.`;
  if (c.includes('bridge')) return `Bridge ${cash} of USDC to ${chain} through ${n} and use the bridged funds inside its own app.`;
  if (c.includes('staking') || c.includes('restak') || c.includes('liquid rest')) return `Stake ${cash} of the chain's staking asset through ${n} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis') || c.includes('options')) return `Deposit ${cash} of USDC as margin on ${n} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund ${cash} and place one market position on ${n}, then hold the position past settlement.`;
  if (c.includes('stable')) return `Mint or deposit ${cash} of the stable asset through ${n} on ${chain} and hold the mint receipt.`;
  if (c.includes('rwa') || c.includes('treasury')) return `Mint ${cash} of the protocol's yield asset on ${chain} and hold it through a full interest cycle.`;
  if (c.includes('insurance')) return `Buy ${cash} of cover from ${n} on ${chain} and keep the policy active.`;
  if (c.includes('chain') || c.includes('canonical')) return `Bridge ${cash} of USDC onto ${n} and do one swap and one deposit there so the wallet has real activity on the chain.`;
  if (c.includes('payments')) return `Route ${cash} of a real payment through ${n} on ${chain} and keep the receipt.`;
  if (c.includes('ai') || c.includes('agent')) return `Deposit ${cash} of USDC into ${n} and run one of its agents with a real task so usage is recorded.`;
  return `Deposit ${cash} of USDC into ${n} on ${chain} and keep the position open.`;
}

/** A protocol's farm plan: seven steps, each an action with a cost and a time, derived from its record. */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = firstChain(p);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdFor(age);
  const gas = capital >= 300 ? 12 : capital >= 150 ? 8 : 5;
  const multi = p.chains.length > 1 ? ` (it runs on ${p.chains.length} chains, ${p.chains[0]} first)` : '';
  return [
    `Create a fresh wallet for this position alone and keep its seed phrase offline; fund it with $${capital + 25}, enough for the $${capital} deposit, the gas and a buffer${multi}. Cost: nothing beyond the deposit and about $${gas} of gas. Time: 10 minutes.`,
    `${actionFor(p, capital, chain)} Cost: $${capital} of capital plus about $${gas} of gas. Time: 15 minutes to set up.`,
    `Open ${p.name}'s own app or docs page first and check it publishes a points, rewards or season program; if it does, record the campaign name before you deposit. Cost: free. Time: 10 minutes.`,
    `Make one qualifying action every week — a deposit, a borrow, a swap, a vote or a claim — so activity shows up in more than one weekly snapshot. Cost: about $2 of gas a week. Time: 10 minutes a week.`,
    `Keep the position for at least ${hold} days; a protocol that has run ${age === null ? 'an unknown time' : `${age} days`} with no token rewards a long record over a short one. Cost: the $${capital} stays deployed. Time: ${hold} days.`,
    `Before you withdraw, revisit the protocol's own rewards page and claim only from a link it publishes; never sign a claim from a DM or an ad. Cost: no fee to check, never pay to claim. Time: 10 minutes.`,
    `Log the wallet, every date and every transaction hash in a farm log so you can repeat, size up or unwind the position when the token is announced. Cost: nothing but the log. Time: 5 minutes.`,
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      ratio: isPeer(p) ? Math.round(ratioOf(p) * 1e4) / 1e4 : null,
    }));
}

/** The board: every watchlist slug, plus the pre-token protocols below the floor with the highest implied value. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const table = peerTable(snapshot);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchset = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const below = snapshot.protocols
    .filter((p) => !watchset.has(p.slug) && isRankable(p))
    .map((p) => ({ p, ...score(p, snapshot.as_of, table, model) }))
    .sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : 1))
    .slice(0, EARLY_ROWS);
  for (const e of below) chosen.set(e.p.slug, e.p);

  const scored = [...chosen.values()].map((p) => ({ p, s: score(p, snapshot.as_of, table, model) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : 1));
  return scored.map(({ p, s }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    age_days: s.age,
    implied_value_usd: s.implied,
    on_watchlist: watchset.has(p.slug),
    model: {
      peer_multiple: round4(s.multiple),
      peer_source: s.source,
      peer_count: s.count,
      maturity: round4(s.maturity),
      momentum: round4(s.momentum),
      chain_depth: round4(s.chainDepth),
      floor_reason: watchset.has(p.slug) ? 'watchlist: TVL at or above the floor, no token on record' : 'early radar: below the floor, no token on record',
    },
    farm_steps: farmSteps(p, s.age),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The category table the page prints: peers, medians, rows and the best row in each. */
export function categoryStats(snapshot: Snapshot, board: BoardRow[], table: PeerTable): CategoryStat[] {
  const rows = new Map<string, BoardRow[]>();
  for (const r of board) {
    const k = r.category ?? '(uncategorised)';
    const list = rows.get(k) ?? [];
    list.push(r);
    rows.set(k, list);
  }
  const out: CategoryStat[] = [];
  for (const [category, list] of rows) {
    const peers = table.byCategory.get(category) ?? [];
    out.push({
      category,
      live_peers: peers.length,
      median_ratio: peers.length > 0 ? round4(median(peers)) : 0,
      p25_ratio: peers.length > 0 ? round4(quantile(peers, 0.25)) : 0,
      p75_ratio: peers.length > 0 ? round4(quantile(peers, 0.75)) : 0,
      rows: list.length,
      top_implied_usd: Math.max(...list.map((r) => r.implied_value_usd)),
    });
  }
  return out.sort((a, b) => b.top_implied_usd - a.top_implied_usd);
}

/** The model's own error, measured on the live set: predict each live protocol's mcap from its ratio model. */
export function calibration(snapshot: Snapshot, table: PeerTable, model: ModelConstants): Calibration {
  const errors: number[] = [];
  for (const p of table.live) {
    const m = peerMultiple(p, table, model);
    const pred = m.multiple * p.tvl_usd;
    if (pred > 0 && (p.mcap_usd as number) > 0) errors.push(Math.abs(Math.log10(pred / (p.mcap_usd as number))));
  }
  errors.sort((a, b) => a - b);
  return {
    live_pool: table.live.length,
    median_ratio: round4(table.overallMedian),
    median_log10_error: errors.length ? round4(median(errors)) : 0,
    within_10x_pct: errors.length ? Math.round((errors.filter((e) => e < 1).length / errors.length) * 100) : 0,
  };
}

function radarRow(r: BoardRow): RadarRow {
  return {
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    age_days: r.age_days,
    implied_value_usd: r.implied_value_usd,
    on_watchlist: r.on_watchlist,
    peer_multiple: r.model.peer_multiple,
    peer_source: r.model.peer_source,
    peer_count: r.model.peer_count,
    maturity: r.model.maturity,
    momentum: r.model.momentum,
    chain_depth: r.model.chain_depth,
  };
}

export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const table = peerTable(snapshot);
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const watchset = new Set(snapshot.watchlist);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !watchset.has(r.slug)).length,
    live_size: live.length,
    categories: categoryStats(snapshot, board, table),
    calibration: calibration(snapshot, table, model),
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (new Set(board.map((r) => r.implied_value_usd)).size === 1) return 'every row shares one implied value';
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
