// sweep-local.mjs — grid over grad-sleeve params, dataset loaded once.
//   node sweep-local.mjs '<grid json>' [base overrides json]
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const kitDir = process.argv[2] ?? '../../memecoin-backtest-48h-01-kit';
const gridJson = process.argv[3];
const baseJson = process.argv[4] ?? '{}';
const { createStrategy, DEFAULT_PARAMS } = await import('../strategy.ts');

const base = { ...DEFAULT_PARAMS, revEnabled: false, paceEnabled: false, maxWeakOpen: 0, ...JSON.parse(baseJson) };
const grid = JSON.parse(gridJson);
const keys = Object.keys(grid);
let combos = [{}];
for (const k of keys) {
  const next = [];
  for (const c of combos) for (const v of grid[k]) next.push({ ...c, [k]: v });
  combos = next;
}

const ds = loadDataset(kitDir);
const hello = makeHello(phaseSeed('memecoin-backtest-48h-01', 'dev', ds.sha256));
console.log(`batches ${ds.batches.length} events ${ds.events.length} combos ${combos.length}`);

const rows = [];
for (const c of combos) {
  const p = { ...base, ...c };
  const r = simulate(ds, hello, { onBatch: createStrategy(p) });
  const pnl = r.trips.map((t) => Number(t.pnl) / 1e9).sort((a, b) => b - a);
  const net = Number(r.netPnl) / 1e9;
  rows.push({ c, net, wins: r.trips.filter((t) => t.pnl > 0n).length, trips: r.trips.length, mints: r.mints, dd: r.maxDrawdown, exBest: net - (pnl[0] ?? 0) });
  console.error(`done ${JSON.stringify(c)} net ${net.toFixed(3)}`);
}
rows.sort((a, b) => b.net - a.net);
for (const r of rows) {
  console.log(`net ${r.net.toFixed(4)} exBest ${r.exBest.toFixed(3)} wins ${r.wins}/${r.trips} mints ${r.mints} dd ${r.dd.toFixed(3)} ${JSON.stringify(r.c)}`);
}
