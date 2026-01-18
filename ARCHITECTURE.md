# Solana Momentum Trading Bot - Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SOLANA MOMENTUM BOT                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                     TWO-PHASE DETECTION SYSTEM                       │    │
│  │                                                                       │    │
│  │   PHASE 1: FREE LOG PARSING              PHASE 2: RPC VERIFICATION   │    │
│  │   ┌─────────────────────────┐            ┌─────────────────────────┐ │    │
│  │   │  WebSocket Logs         │  5+ swaps  │  getParsedTransaction   │ │    │
│  │   │  ─────────────────────  │  ───────▶  │  ─────────────────────  │ │    │
│  │   │  • Parse raw logs       │   /30s     │  • Verify SPL mint      │ │    │
│  │   │  • Track swap count     │  (HOT!)    │  • Accurate token ID    │ │    │
│  │   │  • NO RPC credits       │            │  • SOL notional         │ │    │
│  │   └─────────────────────────┘            └─────────────┬───────────┘ │    │
│  │              │                                         │             │    │
│  │              │ Track ALL tokens                        │ Only hot    │    │
│  │              ▼                                         ▼             │    │
│  │   ┌─────────────────────────┐            ┌─────────────────────────┐ │    │
│  │   │  Hot Token Tracker      │            │  Token Universe         │ │    │
│  │   │  ~300 tokens tracked    │            │  ~30 verified tokens    │ │    │
│  │   └─────────────────────────┘            └─────────────────────────┘ │    │
│  │                                                                       │    │
│  │   Result: ~90% reduction in RPC credits while seeing ALL activity    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│                                        │                                     │
│                                        ▼                                     │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    ROLLING ANALYTICS ENGINE                           │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐                               │   │
│  │  │  5 sec  │  │ 15 sec  │  │ 60 sec  │                               │   │
│  │  │ window  │  │ window  │  │ window  │                               │   │
│  │  └─────────┘  └─────────┘  └─────────┘                               │   │
│  │  - Swap count    - Net inflow    - Unique wallets                    │   │
│  │  - Buy/Sell vol  - Price delta   - Concentration                     │   │
│  └────────────────────┬─────────────────────────────────────────────────┘   │
│                       │                                                      │
│                       ▼                                                      │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │                     MOMENTUM SCORING ENGINE                         │     │
│  │   score = w1*zscore(swaps) + w2*zscore(inflow) + w3*zscore(buyers) │     │
│  │   + w4*zscore(price_change)                                         │     │
│  │                                                                      │     │
│  │   Entry: score > ENTRY_THRESHOLD for CONFIRMATION_TIME              │     │
│  │   Exit:  score < EXIT_THRESHOLD OR flow reversal OR max_hold        │     │
│  └──────────────────────────────┬─────────────────────────────────────┘     │
│                                 │                                            │
│                                 ▼                                            │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │                      RISK & SAFETY GATES (8 CHECKS)                 │     │
│  │   ☑ Min liquidity (10 SOL)     ☑ Sell simulation passes            │     │
│  │   ☑ Wallet diversity (5+)      ☑ Buy/sell ratio (1.0 - 20.0)       │     │
│  │   ☑ Position size cap (1%)     ☑ No wash-trading patterns          │     │
│  │   ☑ Buyer concentration (<50%) ☑ Momentum confirmation (3s)        │     │
│  └──────────────────────────────┬─────────────────────────────────────┘     │
│                                 │                                            │
│                                 ▼                                            │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │                      EXECUTION ENGINE                               │     │
│  │   - Jupiter aggregator for optimal routing                          │     │
│  │   - Dynamic slippage protection                                     │     │
│  │   - Priority fees for faster confirmation                           │     │
│  │   - Retry with exponential backoff                                  │     │
│  │   - Transaction confirmation polling                                │     │
│  └──────────────────────────────┬─────────────────────────────────────┘     │
│                                 │                                            │
│                                 ▼                                            │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │                      POSITION MANAGER                               │     │
│  │   - Active position tracking                                        │     │
│  │   - Exit condition monitoring (momentum, flow, time)                │     │
│  │   - PnL calculation & reporting                                     │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │                      LOGGING & REPLAY                               │     │
│  │   - Event logging (JSON Lines format)                               │     │
│  │   - Replay harness for backtesting                                  │     │
│  │   - Performance metrics & statistics                                │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Two-Phase Detection Deep Dive

### Why Two Phases?

The Helius Free Plan has rate limits that can cause "blindness" during high-volume periods. Two-phase detection solves this:

| Challenge | Solution |
|-----------|----------|
| Rate limits cause missed events | Phase 1 sees ALL events via raw logs |
| RPC credits burn quickly | Phase 2 only for hot tokens (~10% of traffic) |
| Fake tokens waste resources | RPC verification confirms real SPL mints |
| Complex swaps hard to parse | Phase 2 uses `getParsedTransaction` for accuracy |

### Phase 1: Hot Token Tracker

```typescript
// Tracks swap counts per token (NO RPC)
interface TokenActivity {
  swapCount: number;       // Total swaps seen
  firstSeen: number;       // Timestamp
  lastSeen: number;        // Timestamp
  estimatedBuys: number;   // From log parsing
  estimatedSells: number;  // From log parsing
  signatures: Set<string>; // For deduplication
}
```

**Trigger Condition**: `swapCount >= HOT_TOKEN_THRESHOLD` within `HOT_TOKEN_WINDOW_MS`

Default: 5 swaps in 30 seconds

### Phase 2: RPC Verification

1. **Token Mint Verification**
   - `getAccountInfo(mint)`
   - Verify owner is Token Program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`)
   - Verify data length = 82 bytes (SPL Mint account)
   - Also supports Token-2022 mints

2. **Accurate Token Selection**
   - Uses `getParsedTransaction` 
   - Identifies signer's net token delta
   - Selects mint with largest absolute delta (not first mint)

3. **SOL Notional Calculation**
   - Uses signer's balance index
   - Subtracts transaction fee
   - Sanity bounds: 0.0001 - 1000 SOL

## Data Flow

```
1. WebSocket     ──▶  2. Phase 1         ──▶  3. Hot Detection
   (log events)        (raw log parse)         (5+ swaps/30s)
                                                    │
                                                    ▼
6. Risk Gates   ◀──  5. Momentum Score  ◀──  4. Phase 2 RPC
   (8 checks)         (z-score calc)          (verify & emit)
       │
       ▼
7. Execution    ──▶  8. Position         ──▶  9. Exit Monitor
   (Jupiter)          (track PnL)              (decay/reversal)
```

## Key Design Decisions

### Why Two-Phase Detection?
- **Problem**: Helius Free Plan has 10 RPC calls/sec limit
- **Problem**: Raw WebSocket sees ~5-10 swaps/sec → immediate rate limiting
- **Solution**: Only RPC for tokens showing real activity
- **Result**: ~90% credit reduction, no blindness

### Why Jupiter for Execution?
- Aggregates liquidity across all major DEXs
- Handles routing complexity automatically
- Provides quote simulation for slippage
- Reduces DEX-specific adapter code

### Why Rolling Windows vs Polling?
- Event-driven updates = lower latency
- No wasted compute on inactive tokens
- Natural backpressure handling
- Memory-efficient with time-based expiry

### Why Z-Scores for Momentum?
- Normalizes across different volume levels
- Self-calibrating baseline
- Detects relative changes vs absolute values
- No need to manually set thresholds per token

## Module Dependencies

```
config.ts               ← No dependencies (pure config)
    ↑
types.ts                ← No dependencies (type definitions)
    ↑
logger.ts               ← config
    ↑
rolling-window.ts       ← types
    ↑
token-state.ts          ← types, rolling-window
    ↑
token-universe.ts       ← token-state, logger, token-verifier
    ↑
hot-token-tracker.ts    ← config, logger          [NEW - Phase 1]
    ↑
token-verifier.ts       ← config, logger          [NEW - Verification]
    ↑
helius-parser.ts        ← types, logger           [NEW - Phase 2 parsing]
    ↑
analytics.ts            ← token-state, types
    ↑
momentum-scorer.ts      ← analytics, config
    ↑
risk-gates.ts           ← types, config, execution
    ↑
execution.ts            ← config, logger, types
    ↑
position-manager.ts     ← execution, momentum-scorer, risk-gates
    ↑
event-listener.ts       ← token-universe, hot-token-tracker, parsers
    ↑
bot.ts                  ← All above (orchestrator)
```

## File Structure

```
src/
├── index.ts                 # Entry point
├── bot.ts                   # Main bot orchestrator
├── config/
│   └── config.ts            # Configuration management
├── types/
│   └── index.ts             # Type definitions
├── listener/
│   ├── event-listener.ts    # Two-Phase Detection orchestrator
│   ├── hot-token-tracker.ts # Phase 1: Free log tracking
│   ├── token-verifier.ts    # SPL mint verification
│   ├── helius-parser.ts     # Phase 2: Accurate parsing
│   ├── deduplicator.ts      # Event deduplication
│   └── parsers/
│       ├── known-addresses.ts # Program ID blocklist
│       ├── raydium.ts       # Raydium V4/CLMM parser
│       ├── orca.ts          # Orca Whirlpool parser
│       ├── pumpfun.ts       # Pump.fun bonding curve parser
│       └── pumpswap.ts      # PumpSwap parser
├── universe/
│   ├── token-universe.ts    # Token registry
│   └── token-state.ts       # Per-token state
├── analytics/
│   ├── rolling-window.ts    # Sliding window implementation
│   └── analytics-engine.ts  # Metrics computation
├── scoring/
│   └── momentum-scorer.ts   # Momentum score calculation
├── risk/
│   └── risk-gates.ts        # 8 safety checks
├── execution/
│   ├── execution-engine.ts  # Transaction submission
│   └── jupiter-client.ts    # Jupiter API integration
├── positions/
│   └── position-manager.ts  # Active position tracking
├── logging/
│   ├── logger.ts            # Structured logging
│   └── metrics.ts           # Performance metrics
├── replay/
│   └── replay-harness.ts    # Backtesting tool
└── test/
    ├── validate-tx.ts       # Transaction validator
    ├── simulate-momentum.ts # Momentum simulation
    └── run-synthetic-test.ts # Synthetic testing
```

## Supported DEXs

| DEX | Program ID | Phase 1 Parser | Notes |
|-----|------------|----------------|-------|
| Raydium V4 | `675kPX...1Mp8` | `raydium.ts` | Standard AMM |
| Raydium CLMM | `CAMMCz...WqK` | `raydium.ts` | Concentrated liquidity |
| Orca Whirlpool | `whirLb...yCc` | `orca.ts` | Concentrated liquidity |
| Meteora | `LBUZKh...wxo` | Generic | DLMM pools |
| PumpSwap | `pswapR...Syg` | `pumpswap.ts` | Graduated pump.fun tokens |
| Pump.fun | `6EF8rr...uBE` | `pumpfun.ts` | Early bonding curve |

## Performance Characteristics

| Metric | Value | Notes |
|--------|-------|-------|
| Phase 1 Latency | <10ms | Raw log parsing |
| Phase 2 Latency | 200-500ms | RPC verification |
| Memory Usage | ~50MB | 1000 tokens tracked |
| RPC Savings | ~90% | vs naive approach |
| Tokens/Second | 50+ | Phase 1 throughput |
