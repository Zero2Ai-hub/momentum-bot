# Data Flow: End-to-End Event Processing

## Concrete Example: Token "PumpCoin" (mint: `Pump...ABC`)

### Timeline: T=0 to T=90 seconds

---

## STEP 1: Event Ingestion (T=0.000s)

**Source**: Solana WebSocket subscription to Raydium V4 program

```
WebSocket receives log:
{
  signature: "5xYz...123",
  slot: 289456789,
  logs: [
    "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]",
    "Program log: Instruction: Swap",
    "Program log: ray_log: AQAAAA0AAwB...base64data...",
    ...
  ]
}
```

**EventListener.handleLogs()** processes this:

```typescript
// 1. Deduplication check
if (this.recentSignatures.has("5xYz...123")) return; // Skip if seen
this.recentSignatures.add("5xYz...123");

// 2. Parse logs based on DEX source
const events = parseRaydiumSwap(signature, slot, logs, DEXSource.RAYDIUM_V4);
// Returns: [{
//   signature: "5xYz...123",
//   slot: 289456789,
//   timestamp: 1705234567890,
//   tokenMint: "Pump...ABC",
//   direction: SwapDirection.BUY,
//   notionalSol: Decimal(0.5),
//   walletAddress: "Wa11...xyz",
//   dexSource: DEXSource.RAYDIUM_V4
// }]

// 3. Emit to subscribers
this.emit('swap', event);
```

---

## STEP 2: Token Universe Update (T=0.001s)

**Bot.handleSwapEvent()** receives the event:

```typescript
// TokenUniverse.processSwap()
const tokenState = this.tokenUniverse.processSwap(event);

// Inside processSwap:
// - If token "Pump...ABC" doesn't exist:
//   - Create new TokenState
//   - Emit 'token:entered' event
// - If exists:
//   - Call tokenState.processSwap(event)
```

---

## STEP 3: Rolling Window Update (T=0.002s)

**TokenState.processSwap()** updates all windows:

```typescript
// Add event to all three windows
this.windows['5s'].addEvent(event);   // RollingWindow.addEvent()
this.windows['15s'].addEvent(event);
this.windows['60s'].addEvent(event);

// Inside RollingWindow.addEvent():
// 1. Expire old events (older than window size)
// 2. Add new event to array
// 3. Update incremental metrics:
//    - _swapCount++
//    - _buyCount++ (since direction = BUY)
//    - _buyNotional += 0.5 SOL
//    - _uniqueBuyers.set("Wa11...xyz", 0.5)
```

**State after this event (assuming first event for token):**
```
Window 5s:  { swapCount: 1, buyNotional: 0.5, uniqueBuyers: 1 }
Window 15s: { swapCount: 1, buyNotional: 0.5, uniqueBuyers: 1 }
Window 60s: { swapCount: 1, buyNotional: 0.5, uniqueBuyers: 1 }
```

---

## STEP 4: Momentum Scoring (T=0.003s)

**MomentumScorer.calculateScore()** computes score:

```typescript
// Extract metrics from 15s and 60s windows
const swapCount = 1;      // from 15s window
const netInflow = 0.5;    // buyNotional - sellNotional
const uniqueBuyers = 1;   // from 60s window
const priceChange = 0;    // first event, no change yet

// Update running statistics (for z-score normalization)
this.swapCountStats.update(1);
this.netInflowStats.update(0.5);
// ... etc

// Calculate z-scores
// With limited data, z-scores are near 0
const swapCountZScore = 0;   // Not enough observations yet
const netInflowZScore = 0;
const uniqueBuyersZScore = 0;
const priceChangeZScore = 0;

// Weighted score
const totalScore = 
  0.20 * 0 +   // swapCount
  0.35 * 0 +   // netInflow
  0.25 * 0 +   // uniqueBuyers
  0.20 * 0;    // priceChange
// = 0.0

// Check thresholds
const isAboveEntryThreshold = (0.0 >= 2.5); // false
const isAboveExitThreshold = (0.0 >= 0.5);  // false
```

**Result**: Score = 0.0, NOT ready for entry (need score >= 2.5 for 3+ seconds)

---

## STEP 5: More Events Arrive (T=1s to T=30s)

Multiple swaps arrive, building momentum:

```
T=1.2s:  BUY  0.3 SOL by wallet "Wa22..."
T=2.5s:  BUY  0.8 SOL by wallet "Wa33..."
T=4.1s:  BUY  0.2 SOL by wallet "Wa44..."
T=5.3s:  SELL 0.1 SOL by wallet "Wa11..." (original buyer takes profit)
T=7.0s:  BUY  1.2 SOL by wallet "Wa55..."
T=8.5s:  BUY  0.5 SOL by wallet "Wa66..."
T=10.2s: BUY  0.4 SOL by wallet "Wa77..."
...continuing...
T=25s:   BUY  0.6 SOL by wallet "Wa88..."
T=28s:   BUY  0.9 SOL by wallet "Wa99..."
```

**State at T=30s:**
```
Window 5s:  { swapCount: 4, buyNotional: 2.3, sellNotional: 0.0, 
             uniqueBuyers: 4, netInflow: 2.3 }
Window 15s: { swapCount: 8, buyNotional: 4.1, sellNotional: 0.1, 
             uniqueBuyers: 7, netInflow: 4.0 }
Window 60s: { swapCount: 12, buyNotional: 5.9, sellNotional: 0.1, 
             uniqueBuyers: 9, netInflow: 5.8 }
```

**Momentum Score at T=30s:**
```
After 30s of observations, running stats have baseline:
- swapCountMean ≈ 2, stdDev ≈ 1.5
- netInflowMean ≈ 0.3, stdDev ≈ 0.4

For this token:
- swapCountZScore = (8 - 2) / 1.5 = 4.0
- netInflowZScore = (4.0 - 0.3) / 0.4 = 9.25
- uniqueBuyersZScore = (7 - 3) / 2 = 2.0
- priceChangeZScore = (5 - 0) / 3 = 1.67

totalScore = 0.20*4.0 + 0.35*9.25 + 0.25*2.0 + 0.20*1.67
           = 0.80 + 3.24 + 0.50 + 0.33
           = 4.87

isAboveEntryThreshold = (4.87 >= 2.5) = TRUE
```

---

## STEP 6: Confirmation Period (T=30s to T=33s)

Score must stay above threshold for 3 consecutive seconds:

```
T=30s: Score 4.87 > 2.5 → consecutiveAboveEntry = 0s (just crossed)
T=31s: Score 4.92 > 2.5 → consecutiveAboveEntry = 1s
T=32s: Score 4.65 > 2.5 → consecutiveAboveEntry = 2s
T=33s: Score 4.78 > 2.5 → consecutiveAboveEntry = 3s ✓ CONFIRMED
```

**MomentumScorer.isEntryReady()** returns `true`

---

## STEP 7: Risk Gate Assessment (T=33.001s)

**RiskGates.assess()** runs 8 checks:

```typescript
Gate 1: Liquidity Check
  - estimatedLiquidity ≈ 5.8 * 5 = 29 SOL (heuristic)
  - minLiquidity = 10 SOL
  - PASS ✓

Gate 2: Wallet Diversity
  - uniqueBuyers = 9
  - minUniqueWallets = 5
  - PASS ✓

Gate 3: Buyer Concentration
  - Top buyer "Wa55..." has 1.2/5.9 = 20.3%
  - maxConcentration = 50%
  - PASS ✓

Gate 4: Buy/Sell Imbalance
  - ratio = 5.9/0.1 = 59
  - maxRatio = 20
  - FAIL ✗ (too imbalanced, suspicious)

Gate 5: Position Size
  - tradeSize = 0.1 SOL
  - poolLiquidity ≈ 29 SOL
  - pctOfPool = 0.34%
  - maxPct = 1%
  - PASS ✓

Gate 6: Wash Trading
  - overlapPercent = 1/9 = 11%
  - maxOverlap = 30%
  - PASS ✓

Gate 7: Momentum Confirmation
  - consecutiveAboveEntry = 3s
  - required = 3s
  - PASS ✓

Gate 8: Sell Simulation (Jupiter quote)
  - Quote returned: can sell for 0.095 SOL
  - priceImpact = 200 bps
  - PASS ✓
```

**Result**: Gate 4 FAILED → NO TRADE
**Reason**: Extreme buy/sell imbalance suggests potential manipulation

---

## STEP 8: Waiting for Better Conditions (T=33s to T=45s)

More sells come in, normalizing the ratio:

```
T=35s: SELL 0.3 SOL by "Wa22..."
T=38s: SELL 0.2 SOL by "Wa33..."
T=42s: BUY  0.4 SOL by "WaAA..."
```

**At T=45s, re-assess:**
```
Window 15s: buyNotional: 3.2, sellNotional: 0.6
ratio = 3.2/0.6 = 5.3 (within 1-20 range)
```

All gates now pass → **ENTRY TRIGGERED**

---

## STEP 9: Execution (T=45.002s)

**ExecutionEngine.executeBuy():**

```typescript
// 1. Get quote from Jupiter
const quote = await jupiterClient.getBuyQuote("Pump...ABC", Decimal(0.1));
// Returns: {
//   inputMint: SOL,
//   outputMint: "Pump...ABC",
//   inputAmount: 100000000 (0.1 SOL in lamports),
//   expectedOutputAmount: 150000000 (150 tokens),
//   minimumOutputAmount: 145500000 (3% slippage),
//   priceImpactBps: 85
// }

// 2. Build transaction
const tx = await jupiterClient.buildSwapTransaction(quote, wallet);

// 3. Sign and submit
const blockhash = await connection.getLatestBlockhash();
tx.sign([wallet]);
const signature = await connection.sendRawTransaction(tx.serialize());

// 4. Confirm
await connection.confirmTransaction(signature);

// Result: Bought 148,500,000 tokens for 0.1 SOL
```

**Position Created:**
```typescript
{
  id: "pos-uuid-123",
  tokenMint: "Pump...ABC",
  status: "ACTIVE",
  entryTimestamp: 1705234612890,
  entrySizeSol: 0.1,
  tokenAmount: 148500000,
  entryMomentumScore: 4.78
}
```

---

## STEP 10: Position Monitoring (T=45s to T=75s)

**PositionManager.monitorPositions()** runs every 1 second:

```
T=50s: Score 4.2 > 0.5 (exit threshold) → HOLD
       netInflow = 0.8 > 0 → HOLD
       holdTime = 5s < 300s → HOLD

T=60s: Score 3.1 > 0.5 → HOLD
       netInflow = 0.3 > 0 → HOLD

T=70s: Score 1.8 > 0.5 → HOLD
       netInflow = -0.2 < 0 → consecutiveNegativeInflow = 1

T=71s: netInflow = -0.4 < 0 → consecutiveNegativeInflow = 2
T=72s: netInflow = -0.6 < 0 → consecutiveNegativeInflow = 3
T=73s: netInflow = -0.5 < 0 → consecutiveNegativeInflow = 4
T=74s: netInflow = -0.3 < 0 → consecutiveNegativeInflow = 5 → EXIT TRIGGERED
```

---

## STEP 11: Exit Execution (T=74.001s)

**PositionManager.closePosition():**

```typescript
// Sell all tokens
const result = await executionEngine.executeSell("Pump...ABC", Decimal(148500000));

// Transaction confirms
// Received: 0.108 SOL

// Update position
position.exitSizeSol = 0.108;
position.realizedPnlSol = 0.108 - 0.1 = 0.008 SOL (+8%)
position.exitReason = ExitReason.FLOW_REVERSAL;
position.holdTimeMs = 29000 (29 seconds);
```

---

## COMPLETE TIMELINE SUMMARY

```
T=0s:    First swap detected for "Pump...ABC"
T=0-30s: Activity builds, 12 swaps from 9 unique wallets
T=30s:   Momentum score crosses entry threshold (4.87)
T=33s:   Score confirmed above threshold for 3s
T=33s:   Risk gate fails (buy/sell imbalance too high)
T=35-42s: Sells come in, ratio normalizes
T=45s:   All gates pass, BUY executed (0.1 SOL → 148.5M tokens)
T=45-74s: Position held, monitored every second
T=74s:   5 consecutive seconds of negative inflow → EXIT triggered
T=74s:   SELL executed (148.5M tokens → 0.108 SOL)

RESULT: +0.008 SOL profit (+8%) in 29 seconds
```
