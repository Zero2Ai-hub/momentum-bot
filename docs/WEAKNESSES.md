# Known Weaknesses & Failure Modes

## ⚠️ Critical Issues (Must Fix Before Production)

### 1. Direction Inference Is Heuristic-Based

**Problem**: Buy vs sell direction is inferred from amount sizes, not actual pool state.

```typescript
// Current logic:
if (inputLamports.gt(outputLamports.mul(1000))) {
  direction = SwapDirection.BUY;
}
```

**Failure Cases**:
- Token-to-token swaps (no SOL involved)
- Tokens with unusual decimal counts (e.g., 9 vs 18)
- Pools where token A is not SOL

**Impact**: 
- Incorrect buy/sell classification → wrong net inflow calculation
- Score could be inverted (shows momentum when there's selling)

**Fix Required**:
```typescript
// Query pool accounts to determine base/quote
const poolInfo = await getPoolInfo(poolAddress);
const isSolInput = poolInfo.tokenA === SOL_MINT;
direction = isSolInput ? SwapDirection.BUY : SwapDirection.SELL;
```

---

### 2. No Gap Recovery After Disconnection

**Problem**: If WebSocket disconnects, events during downtime are lost.

**Failure Cases**:
- RPC node restart
- Network interruption
- Rate limiting

**Impact**:
- Missed momentum signals
- Positions opened during gap may exit incorrectly
- Token states become stale

**Fix Required**:
```typescript
// Track last processed slot
// On reconnect, backfill:
async function backfillGaps(lastSlot: number) {
  const signatures = await connection.getSignaturesForAddress(
    programId,
    { minContextSlot: lastSlot }
  );
  for (const sig of signatures) {
    const tx = await connection.getTransaction(sig.signature);
    // Re-parse and process
  }
}
```

---

### 3. Liquidity Estimation Is Rough

**Problem**: Pool liquidity is estimated from volume, not actual reserves.

```typescript
// Current logic:
if (liquidity.isZero()) {
  const volume60s = metrics.windows['60s'].buyNotional.plus(sellNotional);
  estimatedLiquidity = volume60s.mul(5); // Arbitrary multiplier
}
```

**Failure Cases**:
- New pools with high volume but low liquidity
- Illiquid pools with sporadic large trades
- Liquidity migrations

**Impact**:
- Position size may exceed safe % of pool
- Slippage may be much higher than expected
- May not be able to exit

**Fix Required**:
```typescript
// Query actual pool reserves:
const poolData = await connection.getAccountInfo(poolAddress);
const reserves = parsePoolReserves(poolData);
const liquidity = reserves.baseAmount.mul(reserves.quotePrice);
```

---

### 4. Z-Score Baseline Requires Warmup

**Problem**: Z-scores are meaningless until enough observations accumulate.

```typescript
// In RunningStats:
getZScore(value: number): number {
  if (this.n < 10) return 0; // Not enough data
  // ...
}
```

**Failure Cases**:
- Bot restart loses all baseline
- First 1-2 minutes have no scoring capability
- Outlier early tokens skew baseline

**Impact**:
- Miss early opportunities after restart
- Baseline may be biased by first tokens seen

**Fix Required**:
```typescript
// Persist baseline statistics:
function saveBaseline() {
  fs.writeFileSync('baseline.json', JSON.stringify({
    swapCount: { mean, m2, n },
    netInflow: { mean, m2, n },
    // ...
  }));
}

function loadBaseline() {
  const data = JSON.parse(fs.readFileSync('baseline.json'));
  // Restore running stats
}
```

---

## ⚡ Performance Issues

### 5. Single-Threaded Event Processing

**Problem**: All events processed sequentially on main thread.

**Failure Cases**:
- High-volume periods (100+ swaps/second)
- Complex scoring calculations
- Multiple active positions

**Impact**:
- Event backlog builds up
- Stale scores when processing catches up
- Delayed exit signals

**Fix Required**:
- Use worker threads for scoring
- Implement event batching
- Add backpressure handling

---

### 6. Memory Growth with Many Tokens

**Problem**: TokenUniverse keeps all seen tokens in memory.

```typescript
// Cleanup only removes after 2 minutes inactivity:
if (state.isInactiveSince(this.inactivityTimeoutMs)) {
  toRemove.push(mint);
}
```

**Failure Cases**:
- Thousands of memecoins launching daily
- Long-running bot without restart

**Impact**:
- Memory usage grows unbounded
- GC pauses affect latency

**Fix Required**:
- More aggressive cleanup
- LRU eviction by token count
- Persist state to disk for low-activity tokens

---

## 📊 Strategy Weaknesses

### 7. Momentum Can Reverse Instantly

**Problem**: Memecoin momentum can flip in <1 second.

**Failure Cases**:
- Influencer dumps
- Coordinated sell-offs
- Liquidity pulls

**Impact**:
- Entry confirmed, but reversal happens before execution completes
- Exit signal comes too late

**Mitigation** (not full fix):
```typescript
// Reduce confirmation time in volatile conditions
if (volatility > HIGH_THRESHOLD) {
  confirmationSeconds = 1; // Instead of 3
}
```

---

### 8. Fake Momentum Is Sophisticated

**Problem**: Adversaries know basic detection patterns.

**Evasion Tactics**:
- Use multiple wallets from same entity
- Space buys to avoid concentration flags
- Add fake sells to normalize ratio
- Coordinate with fresh wallets

**Impact**:
- All risk gates pass for coordinated pump
- Bot buys into manufactured momentum
- Dump follows immediately

**Mitigation**:
- Wallet age/history analysis (requires indexer)
- Cross-reference with known patterns
- Social signal correlation (out of scope)

---

### 9. Exit Logic Has Latency

**Problem**: 5-second negative inflow requirement is too slow.

```typescript
// Current:
if (tokenState.consecutiveNegativeInflowSeconds >= 5) {
  return { shouldExit: true, reason: 'flow_reversal' };
}
```

**Failure Cases**:
- Flash crash in 2 seconds
- Price moves 50% before exit triggers

**Impact**:
- Significant loss on rapid reversals

**Fix Required**:
```typescript
// Add immediate exit on severe conditions:
if (priceDropPercent > 20) {
  return { shouldExit: true, reason: 'crash_protection' };
}
if (instantSellVolume > 10 * avgVolume) {
  return { shouldExit: true, reason: 'panic_selling' };
}
```

---

### 10. No MEV Protection

**Problem**: Trades are submitted without MEV protection.

**Attack Vectors**:
- Sandwich attacks on entry
- Frontrunning our exit
- Backrunning our entry to pump then dump

**Impact**:
- Consistent slippage beyond expected
- Worse fills than quoted

**Fix Required**:
```typescript
// Use Jito bundles for MEV protection:
const bundle = new JitoBundle();
bundle.addTransaction(swapTx);
await bundle.sendWithTip(tipLamports);
```

---

## 🔧 Operational Weaknesses

### 11. No Circuit Breaker

**Problem**: Bot continues trading regardless of losses.

**Failure Cases**:
- Extended losing streak
- Market-wide crash
- Bug causing repeated bad trades

**Impact**:
- Can lose entire balance in bad market

**Fix Required**:
```typescript
// Add circuit breaker:
if (session.consecutiveLosses >= 5) {
  pauseTrading(30 * 60 * 1000); // 30 minute pause
}
if (session.totalPnl < -maxDailyLoss) {
  stopTrading('Daily loss limit reached');
}
```

---

### 12. Limited Observability

**Problem**: Difficult to diagnose why specific trades failed.

**Missing**:
- Per-trade detailed logs with all inputs
- Score component breakdown at decision time
- Risk gate values at check time

**Fix Required**:
- Add structured logging with correlation IDs
- Store full decision context for each trade
- Build dashboard for real-time monitoring

---

## 🎯 Market Condition Failures

### Conditions Where Strategy Breaks:

| Condition | Why It Breaks |
|-----------|---------------|
| **Low volatility market** | No momentum to detect |
| **Everything pumping** | Can't distinguish real vs fake |
| **Flash crashes** | Exit too slow |
| **Coordinated rugs** | Passes all gates, then dumps |
| **High gas periods** | Transactions fail, miss exits |
| **RPC outages** | Blind to market, stuck positions |
| **Token migrations** | Momentum in wrong direction |

---

## 📋 V2 Improvements Needed

### Priority 1 (Critical):
1. Proper direction detection from pool state
2. Actual liquidity queries
3. MEV protection (Jito)
4. Circuit breaker

### Priority 2 (Important):
5. Gap recovery on reconnect
6. Baseline persistence
7. Faster exit triggers
8. Better observability

### Priority 3 (Nice to Have):
9. Wallet reputation scoring
10. Multi-signal confirmation
11. Position sizing by conviction
12. Partial exit support

---

## ⚠️ Final Warning

This bot trades against sophisticated adversaries in a hostile environment.
The current implementation is a starting point, not production-ready.

**Before using real funds**:
1. Run in paper mode for at least 1 week
2. Analyze all paper trades manually
3. Start with minimum position size
4. Monitor every trade initially
5. Have manual override capability
6. Set strict daily loss limits

**Expected initial performance**: Roughly breakeven or slight loss while learning market patterns. Profitability requires tuning based on real data.
