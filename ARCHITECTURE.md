# Solana Momentum Trading Bot - Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SOLANA MOMENTUM BOT                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐    ┌──────────────────┐    ┌─────────────────────────┐   │
│  │   SOLANA     │    │  EVENT LISTENER  │    │   TOKEN UNIVERSE        │   │
│  │   RPC/WS     │───▶│  - WebSocket     │───▶│   - In-memory registry  │   │
│  │   NODES      │    │  - Reconnect     │    │   - Token state objects │   │
│  └──────────────┘    │  - Dedup         │    │   - Auto-expiry         │   │
│                      └──────────────────┘    └───────────┬─────────────┘   │
│                                                          │                  │
│                                                          ▼                  │
│                      ┌──────────────────────────────────────────────────┐  │
│                      │            ROLLING ANALYTICS ENGINE               │  │
│                      │  ┌─────────┐  ┌─────────┐  ┌─────────┐           │  │
│                      │  │  5 sec  │  │ 15 sec  │  │ 60 sec  │           │  │
│                      │  │ window  │  │ window  │  │ window  │           │  │
│                      │  └─────────┘  └─────────┘  └─────────┘           │  │
│                      │  - Swap count    - Net inflow    - Unique wallets │  │
│                      │  - Buy/Sell vol  - Price delta   - Concentration  │  │
│                      └────────────────────┬─────────────────────────────┘  │
│                                           │                                 │
│                                           ▼                                 │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │                     MOMENTUM SCORING ENGINE                         │    │
│  │   score = w1*zscore(swaps) + w2*zscore(inflow) + w3*zscore(buyers) │    │
│  │   + w4*zscore(price_change)                                         │    │
│  │                                                                      │    │
│  │   Entry: score > ENTRY_THRESHOLD for CONFIRMATION_TIME              │    │
│  │   Exit:  score < EXIT_THRESHOLD OR flow reversal OR max_hold        │    │
│  └──────────────────────────────┬─────────────────────────────────────┘    │
│                                 │                                           │
│                                 ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │                      RISK & SAFETY GATES                            │    │
│  │   □ Min liquidity        □ Sell simulation passes                   │    │
│  │   □ Wallet diversity     □ Buy/sell ratio in range                  │    │
│  │   □ Position size cap    □ No wash-trading patterns                 │    │
│  └──────────────────────────────┬─────────────────────────────────────┘    │
│                                 │                                           │
│                                 ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │                      EXECUTION ENGINE                               │    │
│  │   - Jupiter aggregator for routing                                  │    │
│  │   - Dynamic slippage                                                │    │
│  │   - Priority fees                                                   │    │
│  │   - Retry with backoff                                              │    │
│  │   - Transaction confirmation                                        │    │
│  └──────────────────────────────┬─────────────────────────────────────┘    │
│                                 │                                           │
│                                 ▼                                           │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │                      POSITION MANAGER                               │    │
│  │   - Active position tracking                                        │    │
│  │   - Exit condition monitoring                                       │    │
│  │   - PnL calculation                                                 │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │                      LOGGING & REPLAY                               │    │
│  │   - Event logging (JSON Lines)                                      │    │
│  │   - Replay harness                                                  │    │
│  │   - Performance metrics                                             │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

1. **Event Ingestion**: WebSocket connection to Solana RPC receives log events
2. **Parse & Filter**: Extract swap events from AMM program logs (Raydium, Orca, etc.)
3. **Token Registry**: Create/update token state objects in memory
4. **Rolling Windows**: Push events into time-bucketed sliding windows
5. **Score Calculation**: Compute momentum score on each new event
6. **Gate Checks**: Validate all risk gates before entry
7. **Execution**: Build and submit swap transaction via Jupiter
8. **Position Monitoring**: Track position and exit conditions
9. **Logging**: Record all events for replay analysis

## Key Design Decisions

### Why Jupiter for Execution?
- Aggregates liquidity across all major DEXs
- Handles routing complexity
- Provides quote simulation
- Reduces DEX-specific adapter code

### Why Rolling Windows vs Polling?
- Event-driven updates = lower latency
- No wasted compute on inactive tokens
- Natural backpressure handling
- Memory-efficient with time-based expiry

### Why Z-Scores for Momentum?
- Normalizes across different volume levels
- Self-calibrating baseline
- Detects relative changes vs absolute

## Module Dependencies

```
config.ts           ← No dependencies (pure config)
    ↑
types.ts            ← No dependencies (type definitions)
    ↑
logger.ts           ← config
    ↑
rolling-window.ts   ← types
    ↑
token-state.ts      ← types, rolling-window
    ↑
token-universe.ts   ← token-state, logger
    ↑
analytics.ts        ← token-state, types
    ↑
momentum-scorer.ts  ← analytics, config
    ↑
risk-gates.ts       ← types, config, execution
    ↑
execution.ts        ← config, logger, types
    ↑
position-manager.ts ← execution, momentum-scorer, risk-gates
    ↑
event-listener.ts   ← token-universe, logger
    ↑
bot.ts              ← All above (orchestrator)
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
│   ├── event-listener.ts    # WebSocket event ingestion
│   ├── parsers/
│   │   ├── raydium.ts       # Raydium log parser
│   │   └── orca.ts          # Orca log parser
│   └── deduplicator.ts      # Event deduplication
├── universe/
│   ├── token-universe.ts    # Token registry
│   └── token-state.ts       # Per-token state
├── analytics/
│   ├── rolling-window.ts    # Sliding window implementation
│   └── analytics-engine.ts  # Metrics computation
├── scoring/
│   └── momentum-scorer.ts   # Momentum score calculation
├── risk/
│   └── risk-gates.ts        # Safety checks
├── execution/
│   ├── execution-engine.ts  # Transaction submission
│   └── jupiter-client.ts    # Jupiter API integration
├── positions/
│   └── position-manager.ts  # Active position tracking
├── logging/
│   ├── event-logger.ts      # Event persistence
│   └── metrics.ts           # Performance metrics
└── replay/
    └── replay-harness.ts    # Backtesting tool
```
