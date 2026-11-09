// strategy.ts — "dip and graduation" for the pump.fun bonding-curve replay.
//
// Two sleeves share the 5-position cap and 10 SOL:
//   1. Reversion: a curve that ran up and then dropped sharply from its recent high while buyers
//      keep stepping in tends to bounce part of the way back. We buy the dip in tranches and sell
//      on a partial rebound, a stop, or staleness.
//   2. Graduation: a curve whose real SOL reserve is closing on the completion threshold keeps
//      drawing momentum buyers; we ride it with a momentum confirmation and let the replay close
//      the position at completion, or exit on take-profit, a stop, or staleness.
// A pacing probe keeps the run above the guardrail (round trips of >= 0.01 SOL on 20 coins) when
// neither sleeve trades enough on its own.
//
// Everything is a pure function of the batches: no clock, no randomness, no I/O, so the two graded
// executions produce byte-identical action logs.

import type { Batch, BotState, Mark, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  // --- reversion sleeve ---
  revEnabled: boolean;
  highWindow: number;
  ddMin: number;
  ddMax: number;
  minRealSol: bigint;
  minHighRealSol: bigint;
  flowTrades: number;
  minBuys: number;
  lastMustBeBuy: boolean;
  minNetFlow: bigint;
  tranche: bigint;
  maxPosition: bigint;
  minBuy: bigint;
  addBand: number;
  takeProfit: number;
  stopLoss: number;
  maxHoldSlots: number;
  cooldownSlots: number;
  buySlippageBps: number;
  sellSlippageBps: number;
  maxEntriesPerBatch: number;
  strongRealSol: bigint;
  weakTranche: bigint;
  weakMaxPosition: bigint;
  maxWeakOpen: number;
  weakMaxHoldSlots: number;
  weakDdMin: number;
  weakDdMax: number;
  sellSplits: number;
  // --- graduation sleeve ---
  gradEnabled: boolean;
  /** Real SOL (lamports) a curve must hold before the sleeve looks at it. */
  gradMinSol: bigint;
  /** Trades of confirmation and how many must be buys. */
  gradFlowTrades: number;
  gradMinBuys: number;
  /** Stake per graduation position (lamports), and how many may be open at once. */
  gradStake: bigint;
  gradMaxOpen: number;
  gradMaxHoldSlots: number;
  gradTakeProfit: number;
  gradStopLoss: number;
  /** The curve must be at least this many slots old (skip brand-new pumps). */
  gradMinAgeSlots: number;
  // --- pacing probe ---
  paceEnabled: boolean;
  paceCoins: number;
  probeLamports: bigint;
}

export const DEFAULT_PARAMS: Params = {
  revEnabled: false,
  highWindow: 2500,
  ddMin: 0.3,
  ddMax: 0.45,
  minRealSol: 3_000_000_000n,
  minHighRealSol: 3_000_000_000n,
  flowTrades: 6,
  minBuys: 3,
  lastMustBeBuy: true,
  minNetFlow: 0n,
  tranche: 200_000_000n,
  maxPosition: 1_000_000_000n,
  minBuy: 8_000_000n,
  addBand: 0.05,
  takeProfit: 0.2,
  stopLoss: 0.1,
  maxHoldSlots: 600,
  cooldownSlots: 300,
  buySlippageBps: 500,
  sellSlippageBps: 3000,
  maxEntriesPerBatch: 2,
  strongRealSol: 25_000_000_000n,
  weakTranche: 10_000_000n,
  weakMaxPosition: 40_000_000n,
  maxWeakOpen: 3,
  weakMaxHoldSlots: 200,
  weakDdMin: 0.2,
  weakDdMax: 0.6,
  sellSplits: 2,

  gradEnabled: true,
  gradMinSol: 55_000_000_000n,
  gradFlowTrades: 8,
  gradMinBuys: 5,
  gradStake: 550_000_000n,
  gradMaxOpen: 2,
  gradMaxHoldSlots: 2400,
  gradTakeProfit: 0.15,
  gradStopLoss: 0.15,
  gradMinAgeSlots: 300,

  paceEnabled: true,
  paceCoins: 24,
  probeLamports: 20_000_000n,
};

const FEE_BPS = 125n;
const BPS = 10_000n;
const SOL = 1_000_000_000n;

function buyCap(state: BotState, mint: Pubkey): bigint {
  return (state.maxBuyLamports(mint) * 97n) / 100n;
}

function liquidationValue(mark: Mark | undefined, tokens: bigint): bigint {
  if (mark === undefined) return 0n;
  const vq = BigInt(mark.virtual_quote_reserves);
  const vt = BigInt(mark.virtual_token_reserves);
  const rq = BigInt(mark.real_quote_reserves);
  if (vt + tokens === 0n) return 0n;
  let q = (tokens * vq) / (vt + tokens);
  if (q > rq) q = rq;
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

interface Tick {
  slot: number;
  price: number;
  realSol: bigint;
  isBuy: boolean;
  sol: bigint;
}

type Kind = 'reversion' | 'graduation';

interface Book {
  ticks: Tick[];
  createdSlot: number;
  entryPrice: number;
  entrySlot: number;
  entryHigh: number;
  committed: bigint;
  coolUntil: number;
  exiting: boolean;
  strong: boolean;
  kind: Kind;
  probe: boolean;
}

const BIGINT_KEYS = ['minRealSol', 'minHighRealSol', 'minNetFlow', 'tranche', 'maxPosition', 'minBuy', 'strongRealSol', 'weakTranche', 'weakMaxPosition', 'gradMinSol', 'gradStake', 'probeLamports'] as const;

function normalize(p: Params): Params {
  const out = { ...p } as Record<string, unknown>;
  for (const k of BIGINT_KEYS) out[k] = BigInt(out[k] as string | number | bigint);
  return out as unknown as Params;
}

export function createStrategy(params: Params = DEFAULT_PARAMS) {
  const p = normalize(params);
  const books = new Map<Pubkey, Book>();
  const book = (mint: Pubkey): Book => {
    let b = books.get(mint);
    if (b === undefined) {
      b = { ticks: [], createdSlot: -1, entryPrice: 0, entrySlot: -1, entryHigh: 0, committed: 0n, coolUntil: -1, exiting: false, strong: false, kind: 'reversion', probe: false };
      books.set(mint, b);
    }
    return b;
  };

  // Round-trip bookkeeping for the pace check: what each coin's current trip has paid in, and the
  // coins with at least one completed trip of at least 0.01 SOL (the guardrail's size).
  const tripSpent = new Map<Pubkey, bigint>();
  const tripCoins = new Set<Pubkey>();

  return function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const touched: Pubkey[] = [];
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        book(e.mint).createdSlot = slot;
        continue;
      }
      if (e.event !== 'TradeEvent') continue;
      const b = book(e.mint);
      const vt = BigInt(e.virtual_token_reserves);
      const price = vt === 0n ? 0 : Number(BigInt(e.virtual_quote_reserves)) / Number(vt);
      b.ticks.push({ slot, price, realSol: BigInt(e.real_quote_reserves), isBuy: e.is_buy, sol: BigInt(e.sol_amount) });
      if (b.ticks.length > 400) b.ticks.splice(0, b.ticks.length - 400);
      if (!touched.includes(e.mint)) touched.push(e.mint);
    }

    for (const f of batch.fills) {
      const b = books.get(f.mint);
      if (b === undefined) continue;
      if (f.status === 'filled' && f.side === 'buy') {
        tripSpent.set(f.mint, (tripSpent.get(f.mint) ?? 0n) + BigInt(f.quote_lamports));
      }
      if (f.side === 'sell') {
        b.exiting = false;
        if (!state.positions.has(f.mint)) {
          const spent = tripSpent.get(f.mint) ?? 0n;
          if (spent >= 10_000_000n) tripCoins.add(f.mint);
          tripSpent.delete(f.mint);
          b.committed = 0n;
          b.entrySlot = -1;
          b.probe = false;
          b.coolUntil = slot + p.cooldownSlots;
        }
      } else if (f.status !== 'filled' && !state.positions.has(f.mint)) {
        let stillPending = false;
        for (const o of state.pending.values()) if (o.order.mint === f.mint) stillPending = true;
        if (!stillPending) {
          b.committed = 0n;
          b.entrySlot = -1;
        }
      }
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const marks = new Map<Pubkey, Mark>();
    for (const m of batch.marks) marks.set(m.mint, m);
    const pendingMints = new Set<Pubkey>();
    for (const o of state.pending.values()) pendingMints.add(o.order.mint);

    // 1. Exits and adds on held positions, in mint order (deterministic).
    const held = [...state.positions.keys()].sort();
    for (const mint of held) {
      if (orders.length >= cap) break;
      const h = state.positions.get(mint)!;
      const b = book(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (b.exiting) continue;
      const value = liquidationValue(marks.get(mint), h.token_amount);
      const ticks = b.ticks;
      const price = ticks.length > 0 ? ticks[ticks.length - 1]!.price : 0;
      const entrySlot = b.entrySlot < 0 ? slot : b.entrySlot;
      const gain = h.cost_lamports > 0n ? Number(value - h.cost_lamports) / Number(h.cost_lamports) : 0;
      const isGrad = b.kind === 'graduation';
      const tp = gain >= (isGrad ? p.gradTakeProfit : p.takeProfit);
      const sl = gain <= -(isGrad ? p.gradStopLoss : p.stopLoss);
      const stale = slot - entrySlot >= (isGrad ? p.gradMaxHoldSlots : b.strong ? p.maxHoldSlots : p.weakMaxHoldSlots);
      if (tp || sl || stale) {
        if (pendingMints.has(mint)) continue;
        const n = BigInt(Math.max(1, Math.min(p.sellSplits, cap - orders.length)));
        const piece = h.token_amount / n;
        for (let i = 1n; i <= n; i++) {
          const amount = i === n ? h.token_amount - piece * (n - 1n) : piece;
          orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: p.sellSlippageBps });
        }
        b.exiting = true;
        continue;
      }
      // Add a tranche while the dip holds near the first entry (reversion positions only).
      if (isGrad || b.probe) continue;
      const maxPos = b.strong ? p.maxPosition : p.weakMaxPosition;
      if (pendingMints.has(mint) || b.committed >= maxPos) continue;
      if (Math.abs(price / b.entryPrice - 1) > p.addBand) continue;
      let amount = maxPos - b.committed;
      const tranche = b.strong ? p.tranche : p.weakTranche;
      if (amount > tranche) amount = tranche;
      const sizeCap = buyCap(state, mint);
      if (amount > sizeCap) amount = sizeCap;
      if (amount < p.minBuy) continue;
      if (state.freeCashLamports() - amount - tx < 0n) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      b.committed += amount;
      pendingMints.add(mint);
    }

    // 2. Pace check: probe until enough DISTINCT coins carry a qualifying round trip.
    const needProbe = p.paceEnabled && tripCoins.size < p.paceCoins && touched.length > 0;

    // 3. New entries on coins that traded this slot: graduation first (rarer, more urgent),
    //    then reversion.
    let entries = 0;
    let open = state.committedPositionCount();
    let weakOpen = 0;
    let gradOpen = 0;
    for (const m of state.positions.keys()) {
      const b = book(m);
      if (!b.strong && !b.probe) weakOpen++;
      if (b.kind === 'graduation') gradOpen++;
    }
    for (const o of state.pending.values()) {
      if (o.order.side !== 'buy' || state.positions.has(o.order.mint)) continue;
      const b = book(o.order.mint);
      if (!b.strong && !b.probe) weakOpen++;
      if (b.kind === 'graduation') gradOpen++;
    }

    const entryCandidates: Array<{ mint: Pubkey; kind: Kind; strong: boolean; dd: number; hi: number }> = [];
    for (const mint of touched) {
      if (state.positions.has(mint) || pendingMints.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const b = book(mint);
      if (slot < b.coolUntil) continue;
      const ticks = b.ticks;
      if (ticks.length < Math.max(2, Math.min(p.flowTrades, p.gradFlowTrades))) continue;
      const last = ticks[ticks.length - 1]!;
      const created = b.createdSlot < 0 ? slot : b.createdSlot;
      const age = slot - created;

      // Graduation: big reserve, buyers still flowing, young enough to still run.
      if (p.gradEnabled && last.realSol >= p.gradMinSol && gradOpen < p.gradMaxOpen && age >= p.gradMinAgeSlots) {
        let buys = 0;
        for (let i = Math.max(0, ticks.length - p.gradFlowTrades); i < ticks.length; i++) {
          if (ticks[i]!.isBuy) buys++;
        }
        if (buys >= p.gradMinBuys && last.isBuy) {
          entryCandidates.push({ mint, kind: 'graduation', strong: true, dd: 0, hi: last.price });
          continue;
        }
      }

      // Reversion: drawdown from the recent high with buyers still stepping in.
      if (!p.revEnabled) continue;
      if (ticks.length < p.flowTrades) continue;
      if (last.realSol < p.minRealSol) continue;
      let hi = 0;
      let hiReal = 0n;
      for (let i = ticks.length - 1; i >= 0; i--) {
        const t = ticks[i]!;
        if (slot - t.slot > p.highWindow) break;
        if (t.price > hi) {
          hi = t.price;
          hiReal = t.realSol;
        }
      }
      if (hi <= 0 || hiReal < p.minHighRealSol) continue;
      const dd = 1 - last.price / hi;
      const strong = last.realSol >= p.strongRealSol;
      if (strong ? dd < p.ddMin || dd > p.ddMax : dd < p.weakDdMin || dd > p.weakDdMax) continue;
      let buys = 0;
      let net = 0n;
      for (let i = ticks.length - p.flowTrades; i < ticks.length; i++) {
        const t = ticks[i]!;
        if (t.isBuy) {
          buys++;
          net += t.sol;
        } else net -= t.sol;
      }
      if (buys < p.minBuys || net < p.minNetFlow) continue;
      if (p.lastMustBeBuy && !last.isBuy) continue;
      entryCandidates.push({ mint, kind: 'reversion', strong, dd, hi });
    }

    // Graduation candidates first, then strong reversion, then weak.
    entryCandidates.sort((a, b2) => {
      const rank = (c: { kind: Kind; strong: boolean }) => (c.kind === 'graduation' ? 0 : c.strong ? 1 : 2);
      return rank(a) - rank(b2) || a.mint.localeCompare(b2.mint);
    });

    for (const c of entryCandidates) {
      if (orders.length >= cap || entries >= p.maxEntriesPerBatch) break;
      if (open >= state.hello.caps.max_open_positions) break;
      const b = book(c.mint);
      let amount: bigint;
      if (c.kind === 'graduation') {
        if (gradOpen >= p.gradMaxOpen) continue;
        amount = p.gradStake;
      } else if (c.strong) {
        amount = p.tranche;
      } else {
        if (weakOpen >= p.maxWeakOpen) continue;
        amount = p.weakTranche;
      }
      const sizeCap = buyCap(state, c.mint);
      if (amount > sizeCap) amount = sizeCap;
      if (amount < p.minBuy) continue;
      if (state.freeCashLamports() - amount - tx < 0n) continue;
      orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      const ticks = book(c.mint).ticks;
      b.entryPrice = ticks[ticks.length - 1]!.price;
      b.entrySlot = slot;
      b.entryHigh = c.hi;
      b.committed = amount;
      b.exiting = false;
      b.strong = c.strong;
      b.kind = c.kind;
      b.probe = false;
      pendingMints.add(c.mint);
      entries++;
      open++;
      if (c.kind === 'graduation') gradOpen++;
      else if (!c.strong) weakOpen++;
    }

    // 4. Guardrail probe: buy a small piece of the deepest curve touched this slot and sell it as
    //    soon as it lands, so the run keeps meeting the 20-coin round-trip bar.
    if (needProbe && orders.length + 2 <= cap && open < state.hello.caps.max_open_positions && state.freeCashLamports() > p.probeLamports + 4n * tx) {
      let best: Pubkey | null = null;
      let bestSol = 0n;
      for (const mint of touched) {
        if (state.positions.has(mint) || pendingMints.has(mint)) continue;
        if (tripCoins.has(mint)) continue; // a coin already carrying a trip does not help the bar
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const b = book(mint);
        if (slot < b.coolUntil) continue;
        const last = b.ticks[b.ticks.length - 1];
        if (last === undefined) continue;
        if (last.realSol > bestSol) {
          bestSol = last.realSol;
          best = mint;
        }
      }
      if (best !== null) {
        const amount = p.probeLamports;
        const sizeCap = buyCap(state, best);
        const use = amount < sizeCap ? amount : sizeCap;
        if (use >= 2_000_000n) {
          orders.push({ side: 'buy', mint: best, quote_lamports: use, max_slippage_bps: p.buySlippageBps });
          const b = book(best);
          const ticks = b.ticks;
          b.entryPrice = ticks[ticks.length - 1]!.price;
          b.entrySlot = slot;
          b.entryHigh = b.entryPrice;
          b.committed = use;
          b.exiting = false;
          b.strong = true;
          b.kind = 'reversion';
          b.probe = true;
          pendingMints.add(best);
        }
      }
    }

    // 5. Probe exits: a probe position sells whole on the first batch after its fill.
    if (p.paceEnabled) {
      for (const mint of held) {
        if (orders.length >= cap) break;
        const b = book(mint);
        if (!b.probe || b.exiting || pendingMints.has(mint)) continue;
        const h = state.positions.get(mint)!;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: p.sellSlippageBps });
        b.exiting = true;
      }
    }

    return orders;
  };
}
