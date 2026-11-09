// A local, dependency-free port of the kit's replay market model (harness sim/engine.ts and
// sim/curve.ts), used only for fast offline parameter sweeps on the dev window. The bot never
// imports this file; the grader's own engine is what scores. Kept faithful enough that a run here
// should land on the same net PnL as `agentfun grade-local` for the same strategy.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { BotState, type Batch, type Bot, type Fill, type Hello, type Mark, type Order } from '../vendor/makefun-bot.ts';

const BPS = 10_000n;
const MASK = (1n << 64n) - 1n;
const GAMMA = 0x9e3779b97f4a7c15n;

interface CurveState {
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
}
interface Offset {
  quote: bigint;
  tokens: bigint;
}
interface FeeBps {
  protocol: bigint;
  creator: bigint;
}

function mix64(z0: bigint): bigint {
  let z = z0 & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return z ^ (z >> 31n);
}
function keyedU64(seed: bigint, ...parts: bigint[]): bigint {
  let h = mix64((seed + GAMMA) & MASK);
  for (const p of parts) h = mix64((h ^ (p & MASK)) + GAMMA);
  return h;
}
const FAILED_TX = 0x6661696c65642d74n;
const PUBLIC_FAIL_KEY = 0x6661696c2d6b6579n;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const feeOf = (amount: bigint, bps: bigint) => ceilDiv(amount * bps, BPS);
const sellQuoteOut = (t: bigint, s: CurveState) => (t * s.vq) / (s.vt + t);
const buyQuoteInForTokens = (t: bigint, s: CurveState) => (t * s.vq) / (s.vt - t) + 1n;
const buyTokensOutForQuote = (q: bigint, s: CurveState) => (q <= 1n ? 0n : ((q - 1n) * s.vt) / (s.vq + q - 1n));

function quoteBuyExactIn(spend: bigint, s: CurveState, bps: FeeBps) {
  const net0 = (spend * BPS) / (BPS + bps.protocol + bps.creator);
  const fee = feeOf(net0, bps.protocol);
  const creatorFee = feeOf(net0, bps.creator);
  const over = net0 + fee + creatorFee > spend ? net0 + fee + creatorFee - spend : 0n;
  const q0 = net0 - over;
  const t = buyTokensOutForQuote(q0, s);
  if (t > s.rt) {
    const tc = s.rt;
    if (tc === 0n) return { q: 0n, t: 0n, paid: 0n };
    const q = buyQuoteInForTokens(tc, s);
    return { q, t: tc, paid: q + feeOf(q, bps.protocol) + feeOf(q, bps.creator) };
  }
  return { q: q0, t, paid: q0 + fee + creatorFee };
}
function quoteSell(t: bigint, s: CurveState, bps: FeeBps) {
  const q = sellQuoteOut(t, s);
  return { q, proceeds: q - feeOf(q, bps.protocol) - feeOf(q, bps.creator) };
}
function offsetReserves(r: CurveState, off: Offset): CurveState {
  let num = 1n;
  let den = 1n;
  if (off.tokens > r.rt) {
    num = r.rt;
    den = off.tokens;
  }
  if (off.quote < 0n && r.rq * den < num * -off.quote) {
    num = r.rq;
    den = -off.quote;
  }
  const scale = (x: bigint) => (num === den ? x : x >= 0n ? (x * num) / den : -((-x * num) / den));
  const q = scale(off.quote);
  const t = scale(off.tokens);
  return { vq: r.vq + q, rq: r.rq + q, vt: r.vt - t, rt: r.rt - t };
}

export interface Dataset {
  sha256: string;
  events: any[];
  endSlot: number;
  batches: { slot: number; events: any[] }[];
}

export function loadDataset(kit: string): Dataset {
  const kitJson = JSON.parse(readFileSync(`${kit}/kit.json`, 'utf8'));
  const manifest = JSON.parse(readFileSync(`${kit}/dataset/manifest.json`, 'utf8'));
  const raw = gunzipSync(readFileSync(`${kit}/dataset/events/part-00000.ndjson.gz`)).toString('utf8');
  const all = raw.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
  const { modulus, residue } = manifest.universe.sample;
  const excluded = new Set<string>(manifest.excluded_mints ?? []);
  const members = new Set<string>();
  const events: any[] = [];
  for (const e of all) {
    if (e.event === 'CreateEvent' && !members.has(e.mint)) {
      const h = BigInt('0x' + createHash('sha256').update(e.mint, 'utf8').digest('hex'));
      if (e.quote_mint === '11111111111111111111111111111111' && !e.is_mayhem_mode && !e.is_cashback_enabled && !excluded.has(e.mint) && h % BigInt(modulus) === BigInt(residue)) {
        members.add(e.mint);
      }
    }
    if (members.has(e.mint)) events.push(e);
  }
  const batches: { slot: number; events: any[] }[] = [];
  for (const e of events) {
    const tail = batches[batches.length - 1];
    if (tail !== undefined && tail.slot === e.slot) tail.events.push(e);
    else batches.push({ slot: e.slot, events: [e] });
  }
  const lastSlot = all.length > 0 ? all[all.length - 1].slot : 0;
  return { sha256: kitJson.dataset_sha256, events, endSlot: manifest.window?.end_slot ?? lastSlot, batches };
}

export function phaseSeed(competition: string, phase: string, datasetSha: string): string {
  const h = createHash('sha256').update(`agent-fun/seed/v1\0${competition}\0${phase}\0${datasetSha}`).digest('hex');
  return BigInt(`0x${h.slice(0, 16)}`).toString();
}

export function makeHello(seed: string): Hello {
  return {
    type: 'hello',
    protocol: 'agent-fun/replay/v2',
    seed,
    universe: { program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', quote: 'SOL', mayhem: 'excluded', exclude_cashback: true, sample: { hash: 'sha256', modulus: 16, residue: 0 } },
    capital: { lamports: '10000000000' },
    caps: { max_open_positions: 5, max_order_bps_of_real_reserve: 100, max_orders_per_batch: 16, shorts: false, leverage: false },
    latency_slots: 2,
    fees: { protocol_bps_fallback: 95, creator_bps_fallback: 30, base_fee_lamports: '5000', priority_fee_lamports: '100000', failed_tx_bps: 200 },
  };
}

interface MintRt {
  state: CurveState;
  stateSlot: number;
  lastTrade: any | null;
  lastTradeSlot: number;
  complete: boolean;
  offset: Offset;
}
interface Pending {
  order: Order;
  seq: number;
  index: number;
  decidedSlot: number;
  fillSlot: number;
  reject: string | null;
  decision: CurveState | null;
}

export interface SimResult {
  netPnl: bigint;
  fills: number;
  mints: number;
  rejected: number;
  failed: number;
  maxDrawdown: number;
  trips: { mint: string; open: number; close: number; pnl: bigint }[];
  perMint: Map<string, bigint>;
  rejectReasons: Record<string, number>;
}

export interface SimOptions {
  /** Draw failures from this key; null disables the failed-tx draw. */
  failKey?: bigint | null;
  feeMultiplier?: bigint;
}

export function simulate(ds: Dataset, hello: Hello, bot: Bot, opts: SimOptions = {}): SimResult {
  const failKey = opts.failKey === undefined ? keyedU64(BigInt(hello.seed), PUBLIC_FAIL_KEY) : opts.failKey;
  const mult = opts.feeMultiplier ?? 1n;
  const txFee = (BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports)) * mult;
  const latency = hello.latency_slots;
  const caps = hello.caps;
  const mints = new Map<string, MintRt>();
  const pending: Pending[] = [];
  const usedIds = new Set<string>();
  const positions = new Map<string, { tokens: bigint; cost: bigint }>();
  const startCash = BigInt(hello.capital.lamports);
  let cash = startCash;
  let undelivered: Fill[] = [];
  let curSlot = -1;
  let seq = 0;
  let closeCounter = 0;
  const spent = { seq: -1, byMint: new Map<string, bigint>() };
  let fills = 0;
  let rejected = 0;
  let failed = 0;
  const rejectReasons: Record<string, number> = {};
  const filledMints = new Set<string>();
  const perMint = new Map<string, bigint>();
  const openPnl = new Map<string, { pnl: bigint; open: number }>();
  const trips: SimResult['trips'] = [];
  let peak = startCash;
  let maxDd = 0;

  const flow = (mint: string, d: bigint) => {
    perMint.set(mint, (perMint.get(mint) ?? 0n) + d);
    const o = openPnl.get(mint);
    if (o) o.pnl += d;
  };
  const closeTrip = (mint: string, slot: number) => {
    const o = openPnl.get(mint);
    if (!o) return;
    trips.push({ mint, open: o.open, close: slot, pnl: o.pnl });
    openPnl.delete(mint);
  };
  const reserves = (m: MintRt) => offsetReserves(m.state, m.offset);
  const feesFor = (landing: any | null): FeeBps =>
    landing !== null && BigInt(landing.fee_basis_points) > 0n
      ? { protocol: BigInt(landing.fee_basis_points) * mult, creator: BigInt(landing.creator_fee_basis_points) * mult }
      : { protocol: BigInt(hello.fees.protocol_bps_fallback) * mult, creator: BigInt(hello.fees.creator_bps_fallback) * mult };
  const impact = (m: MintRt, isBuy: boolean, q: bigint, t: bigint) => {
    m.offset = isBuy ? { quote: m.offset.quote + q, tokens: m.offset.tokens + t } : { quote: m.offset.quote - q, tokens: m.offset.tokens - t };
  };
  const closeQuote = (m: MintRt, tokens: bigint, s: CurveState = reserves(m)) => {
    const bps = feesFor(m.lastTrade);
    const raw = quoteSell(tokens, s, bps);
    const q = raw.q > s.rq ? s.rq : raw.q;
    const proceeds = q - feeOf(q, bps.protocol) - feeOf(q, bps.creator);
    return { q, proceeds, net: proceeds - txFee, abandon: proceeds - txFee <= 0n };
  };
  const equityNow = () => {
    let e = cash;
    for (const [mint, p] of positions) {
      const c = closeQuote(mints.get(mint)!, p.tokens);
      if (!c.abandon) e += c.net;
    }
    return e;
  };
  const pushEquity = (e: bigint) => {
    if (e > peak) peak = e;
    const dd = Number(peak - e) / Number(peak);
    if (dd > maxDd) maxDd = dd;
  };
  const fill = (p: Pending, status: Fill['status'], reason: string | null, quote: bigint, tokens: bigint): void => {
    if (status === 'rejected') {
      rejected++;
      rejectReasons[reason!] = (rejectReasons[reason!] ?? 0) + 1;
    }
    if (status === 'failed') failed++;
    if (status === 'filled') {
      fills++;
      filledMints.add(p.order.mint);
    }
    undelivered.push({
      client_id: p.order.client_id,
      mint: p.order.mint,
      side: p.order.side,
      status,
      reason: reason as Fill['reason'],
      decided_slot: p.decidedSlot,
      slot: p.fillSlot,
      quote_lamports: quote.toString(),
      token_amount: tokens.toString(),
      fee_lamports: '0',
      tx_fee_lamports: status === 'rejected' ? '0' : txFee.toString(),
      fee_fallback: false,
    });
  };
  const openCount = () => {
    let n = 0;
    for (const p of positions.values()) if (p.tokens > 0n) n++;
    return n;
  };
  const isFailed = (p: Pending) => failKey !== null && keyedU64(failKey, FAILED_TX, BigInt(p.seq), BigInt(p.index)) % 10_000n < BigInt(hello.fees.failed_tx_bps);

  const resolve = (p: Pending): void => {
    if (p.reject !== null) return fill(p, 'rejected', p.reject, 0n, 0n);
    const m = mints.get(p.order.mint)!;
    if (m.complete) return fill(p, 'rejected', 'token_complete', 0n, 0n);
    const landing = m.lastTradeSlot === p.fillSlot ? m.lastTrade : null;
    const bps = feesFor(landing);
    const slip = BigInt(p.order.max_slippage_bps);
    const decision = p.decision!;
    const s = reserves(m);
    if (p.order.side === 'sell') {
      const pos = positions.get(p.order.mint);
      const t = BigInt(p.order.token_amount);
      if (pos === undefined || pos.tokens < t) return fill(p, 'rejected', 'insufficient_tokens', 0n, 0n);
      const sq = quoteSell(t, s, bps);
      if (sq.q > s.rq) return fill(p, 'rejected', 'max_order_size', 0n, 0n);
      if (sq.proceeds <= 0n) return fill(p, 'rejected', 'zero_amount', 0n, 0n);
      const expected = quoteSell(t, decision, bps).proceeds;
      if (sq.proceeds * BPS < expected * (BPS - slip)) return fill(p, 'rejected', 'max_slippage', 0n, 0n);
      if (cash < txFee) return fill(p, 'rejected', 'insufficient_cash', 0n, 0n);
      if (isFailed(p)) {
        cash -= txFee;
        flow(p.order.mint, -txFee);
        return fill(p, 'failed', null, 0n, 0n);
      }
      cash += sq.proceeds - txFee;
      flow(p.order.mint, sq.proceeds - txFee);
      const removed = pos.tokens === t ? pos.cost : (pos.cost * t) / pos.tokens;
      pos.tokens -= t;
      pos.cost -= removed;
      impact(m, false, sq.q, t);
      if (pos.tokens === 0n) {
        positions.delete(p.order.mint);
        closeTrip(p.order.mint, p.fillSlot);
      }
      return fill(p, 'filled', null, sq.proceeds, t);
    }
    const spend = BigInt(p.order.quote_lamports);
    const held = positions.get(p.order.mint);
    if ((held === undefined || held.tokens === 0n) && openCount() >= caps.max_open_positions) return fill(p, 'rejected', 'max_open_positions', 0n, 0n);
    if (spent.seq !== p.seq) {
      spent.seq = p.seq;
      spent.byMint.clear();
    }
    const total = (spent.byMint.get(p.order.mint) ?? 0n) + spend;
    if (total * BPS > decision.rq * BigInt(caps.max_order_bps_of_real_reserve)) return fill(p, 'rejected', 'max_order_size', 0n, 0n);
    spent.byMint.set(p.order.mint, total);
    const bq = quoteBuyExactIn(spend, s, bps);
    if (bq.t === 0n) return fill(p, 'rejected', 'zero_amount', 0n, 0n);
    const expected = quoteBuyExactIn(spend, decision, bps).t;
    if (bq.t * BPS < expected * (BPS - slip)) return fill(p, 'rejected', 'max_slippage', 0n, 0n);
    if (cash < spend + txFee) return fill(p, 'rejected', 'insufficient_cash', 0n, 0n);
    if (isFailed(p)) {
      cash -= txFee;
      flow(p.order.mint, -txFee);
      return fill(p, 'failed', null, 0n, 0n);
    }
    cash -= bq.paid + txFee;
    let pos = held;
    const opening = pos === undefined || pos.tokens === 0n;
    if (pos === undefined) {
      pos = { tokens: 0n, cost: 0n };
      positions.set(p.order.mint, pos);
    }
    if (opening) openPnl.set(p.order.mint, { pnl: 0n, open: p.fillSlot });
    flow(p.order.mint, -(bq.paid + txFee));
    pos.tokens += bq.t;
    pos.cost += bq.paid;
    impact(m, true, bq.q, bq.t);
    return fill(p, 'filled', null, bq.paid, bq.t);
  };

  const forceClose = (mint: string, why: string, slot: number) => {
    const pos = positions.get(mint)!;
    const m = mints.get(mint)!;
    const c = closeQuote(m, pos.tokens);
    const n = closeCounter++;
    const kind = c.abandon ? 'writeoff' : why;
    if (!c.abandon) {
      cash += c.net;
      flow(mint, c.net);
      impact(m, false, c.q, pos.tokens);
    }
    undelivered.push({
      client_id: `_${kind}_${n}`,
      mint,
      side: 'sell',
      status: 'filled',
      reason: null,
      decided_slot: slot,
      slot,
      quote_lamports: c.abandon ? '0' : c.proceeds.toString(),
      token_amount: pos.tokens.toString(),
      fee_lamports: '0',
      tx_fee_lamports: c.abandon ? '0' : txFee.toString(),
      fee_fallback: false,
    });
    positions.delete(mint);
    closeTrip(mint, slot);
  };
  const account = () => ({
    cash_lamports: cash.toString(),
    positions: [...positions.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([mint, p]) => ({ mint, token_amount: p.tokens.toString(), cost_lamports: p.cost.toString() })),
  });
  const marks = (): Mark[] => {
    const want = new Set<string>(positions.keys());
    for (const p of pending) if (mints.has(p.order.mint)) want.add(p.order.mint);
    return [...want].sort().map((mint) => {
      const m = mints.get(mint)!;
      const s = reserves(m);
      return { mint, slot: m.stateSlot, virtual_token_reserves: s.vt.toString(), virtual_quote_reserves: s.vq.toString(), real_token_reserves: s.rt.toString(), real_quote_reserves: s.rq.toString() };
    });
  };

  const state = new BotState(hello);
  bot.onHello?.(state);
  for (const b of ds.batches) {
    const x = b.slot;
    while (pending.length > 0 && pending[0]!.fillSlot < x) {
      const p = pending.shift()!;
      curSlot = p.fillSlot;
      resolve(p);
    }
    curSlot = x;
    const completed: string[] = [];
    for (const e of b.events) {
      if (e.event === 'CreateEvent') {
        mints.set(e.mint, { state: { vq: BigInt(e.virtual_quote_reserves), vt: BigInt(e.virtual_token_reserves), rq: 0n, rt: BigInt(e.real_token_reserves) }, stateSlot: x, lastTrade: null, lastTradeSlot: -1, complete: false, offset: { quote: 0n, tokens: 0n } });
      } else if (e.event === 'TradeEvent') {
        const m = mints.get(e.mint)!;
        m.state = { vq: BigInt(e.virtual_quote_reserves), vt: BigInt(e.virtual_token_reserves), rq: BigInt(e.real_quote_reserves), rt: BigInt(e.real_token_reserves) };
        m.stateSlot = x;
        m.lastTrade = e;
        m.lastTradeSlot = x;
      } else {
        mints.get(e.mint)!.complete = true;
        completed.push(e.mint);
      }
    }
    for (const mint of completed) if (positions.has(mint)) forceClose(mint, 'complete', x);
    while (pending.length > 0 && pending[0]!.fillSlot === x) resolve(pending.shift()!);
    const batch: Batch = { type: 'batch', seq, slot: x, events: b.events, marks: marks(), fills: undelivered, account: account() };
    undelivered = [];
    pushEquity(equityNow());
    state.applyBatch(batch);
    const orders = state.toOrders(bot.onBatch(state, batch) as any);
    state.recordOrders(orders);
    orders.forEach((order, index) => {
      let reject: string | null = null;
      const amount = order.side === 'buy' ? order.quote_lamports : order.token_amount;
      if (index >= caps.max_orders_per_batch) reject = 'max_orders_per_batch';
      else if (usedIds.has(order.client_id)) reject = 'duplicate_client_id';
      else if (amount === '0') reject = 'zero_amount';
      else if (!mints.has(order.mint)) reject = 'not_in_universe';
      usedIds.add(order.client_id);
      const m = mints.get(order.mint);
      pending.push({ order, seq, index, decidedSlot: curSlot, fillSlot: curSlot + latency, reject, decision: m ? reserves(m) : null });
    });
    seq++;
  }
  curSlot = ds.endSlot;
  while (pending.length > 0) {
    const p = pending.shift()!;
    if (p.fillSlot > ds.endSlot) fill(p, 'rejected', 'after_end', 0n, 0n);
    else resolve(p);
  }
  for (const mint of [...positions.keys()].sort()) forceClose(mint, 'flatten', ds.endSlot);
  pushEquity(cash);
  return { netPnl: cash - startCash, fills, mints: filledMints.size, rejected, failed, maxDrawdown: maxDd, trips, perMint, rejectReasons };
}
