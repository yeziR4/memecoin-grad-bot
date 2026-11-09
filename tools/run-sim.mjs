// run-sim.mjs — run our strategy on the dev window with the local engine port.
//   node run-sim.mjs '<params json overrides>'  (defaults: DEFAULT_PARAMS)
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const kitDir = process.argv[2] ?? '../memecoin-backtest-48h-01-kit';
const overrides = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const { createStrategy, DEFAULT_PARAMS } = await import('../strategy.ts');

const ds = loadDataset(kitDir);
const hello = makeHello(phaseSeed('memecoin-backtest-48h-01', 'dev', ds.sha256));
const p = { ...DEFAULT_PARAMS, ...overrides };
const r = simulate(ds, hello, { onBatch: createStrategy(p) });
const pnl = r.trips.map((t) => Number(t.pnl) / 1e9).sort((a, b) => b - a);
const net = Number(r.netPnl) / 1e9;
console.log(JSON.stringify({
  net: +net.toFixed(4),
  fills: r.fills,
  mints: r.mints,
  trips: r.trips.length,
  wins: r.trips.filter((t) => t.pnl > 0n).length,
  dd: +r.maxDrawdown.toFixed(3),
  best3: +pnl.slice(0, 3).reduce((s, x) => s + x, 0).toFixed(3),
  exBest: +(net - (pnl[0] ?? 0)).toFixed(3),
  worst: pnl.slice(-3).map((x) => +x.toFixed(3)),
  rejected: r.rejected,
  reasons: r.rejectReasons,
}, null, 1));
