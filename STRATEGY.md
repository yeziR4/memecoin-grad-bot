# Dip and graduation — what the bot trades on, how it sizes, when it exits

The bot runs two sleeves on pump.fun bonding curves over a 24-hour replay, starting from
10 SOL, at most five open positions, and each reply's buys capped at 1% of a curve's real
SOL reserve.

**Reversion sleeve.** A curve that ran up and then dropped sharply from its recent high
while buyers keep stepping in tends to bounce part of the way back. The bot buys such dips
in tranches of 0.2 SOL on deep curves (at least 25 SOL of real reserves; 0.01 SOL probes on
weaker ones), requiring three of the last six trades to be buys and the newest trade to be a
buy, with the price 30-45% under a ~17-minute high on deep curves (20-60% on weak ones).
It adds tranches while the price stays within 5% of the first entry, up to 1 SOL per
position, and exits the whole position on a 20% take-profit, a 10% stop, or after 600 slots
(200 for weak probes), then ignores the coin for 300 slots.

**Graduation sleeve.** A curve whose real SOL reserve is closing on the completion
threshold keeps drawing momentum buyers. When a curve holds at least 55 SOL of real
reserves, is at least 300 slots old, and five of its last eight trades are buys ending in a
buy, the bot buys 0.55 SOL and holds for the run, pyramiding up to three more 0.55 SOL adds
while the newest trade is still a buy, net flow over the window stays positive and the price
holds above the first entry. It exits on a 15% take-profit, a 15% stop, or 2400 slots of
staleness; the replay also closes the position at completion. At most two such positions at
once. Riding the run to completion without a take-profit was tested and loses: most runs
fade before the curve completes.

**Guardrail pacing.** The run must round-trip at least 0.01 SOL on 20 coins. The bot counts
its completed qualifying trips and, while it is behind a target of 24, buys 0.02 SOL of the
deepest curve touched in the batch and sells it as soon as it lands.

Fees are 125 bps of curve fees and 105,000 lamports of transaction fee per order, so every
order is at least 0.008 SOL and sells are split in two to limit slippage refusals. Buys
allow 500 bps of slippage, sells 3000. No clock, no randomness: the two graded executions
produce byte-identical action logs.
