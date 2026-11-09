// main.ts — memecoin-backtest-48h-01 entry: dip and graduation on pump.fun bonding curves.
// Run by the grader as `node /bot/main.ts`; the SDK shim is vendored byte for byte in vendor/.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const onBatch = createStrategy(DEFAULT_PARAMS);

await runBot({ onBatch });
