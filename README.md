# Solana Momentum Trading Bot

An on-chain momentum trading bot for Solana that detects tokens transitioning from low activity to real momentum using only on-chain signals.

## ✨ Key Features

- **Two-Phase Detection**: Credit-optimized detection system (see [Two-Phase Detection](#two-phase-detection))
- **On-Chain Signal Detection**: Uses swap activity, capital flows, and wallet participation
- **Multi-DEX Monitoring**: Raydium V4/CLMM, Orca Whirlpool, Meteora, PumpSwap, Pump.fun
- **Real-Time Processing**: WebSocket streaming with rolling window analytics (5s/15s/60s)
- **Risk Management**: 8 safety gates before any trade execution
- **Momentum-Based Exits**: Exits on flow reversal or momentum decay
- **Replay System**: Backtest with historical event logs
- **Paper Trading**: Safe testing mode without real transactions

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         TWO-PHASE DETECTION                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   Phase 1 (FREE)              Phase 2 (RPC Credits)                     │
│   ┌─────────────────┐         ┌─────────────────┐                       │
│   │  Raw Log Parse  │  ─────▶ │ RPC Verification │ ─────▶ Token Universe│
│   │  (WebSocket)    │  5+swaps│ (Hot Tokens Only)│                      │
│   │  Track ALL      │  /30s   │ ~90% credit save │                      │
│   └─────────────────┘         └─────────────────┘                       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  Token Universe │───▶│    Analytics     │───▶│ Momentum Scorer │
│   (Registry)    │    │  (5s/15s/60s)    │    │   (z-scores)    │
└─────────────────┘    └──────────────────┘    └────────┬────────┘
                                                        │
                       ┌──────────────────┐    ┌────────▼────────┐
                       │ Execution Engine │◀───│   Risk Gates    │
                       │   (Jupiter)      │    │   (8 checks)    │
                       └────────┬─────────┘    └─────────────────┘
                                │
                       ┌────────▼─────────┐
                       │Position Manager  │
                       │  (Exit Logic)    │
                       └──────────────────┘
```

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp config.example.env .env
```

Edit `.env` with:
- Your Helius RPC endpoint (free tier works!)
- Wallet private key (Base58 encoded) - optional for observation mode
- Trading parameters

### 3. Build & Run

```bash
# Build
npm run build

# Run (paper trading mode by default)
npm start

# Development mode (with auto-reload)
npm run dev
```

## 🎯 Two-Phase Detection

The bot uses a **Two-Phase Detection** system optimized for Helius Free Plan:

### Phase 1: Free Log Parsing (No RPC Credits)
- Parses raw WebSocket logs to track ALL swap activity
- Counts swaps per token in real-time
- **No Helius credits consumed**

### Phase 2: RPC Verification (Credits - Hot Tokens Only)
- Triggered when a token gets **5+ swaps in 30 seconds**
- Verifies token is a real SPL mint via RPC
- Fetches accurate transaction data for momentum scoring
- **~90% reduction in RPC usage**

### Benefits
| Aspect | Before | After |
|--------|--------|-------|
| RPC Calls | Every swap (~300/min) | Only hot tokens (~25/min) |
| Credit Usage | ~100% | ~10% |
| Market Visibility | Limited by rate limits | ALL activity in real-time |
| Detection Speed | Delayed by rate limits | Instant for Phase 1 |

### Configuration
```env
# Hot token detection thresholds
HOT_TOKEN_THRESHOLD=5        # Swaps to trigger Phase 2
HOT_TOKEN_WINDOW_MS=30000    # Time window (30 seconds)
```

## 📊 Supported DEXs

| DEX | Program ID | Notes |
|-----|------------|-------|
| Raydium V4 | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | Standard AMM pools |
| Raydium CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | Concentrated liquidity |
| Orca Whirlpool | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | Concentrated liquidity |
| Meteora | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | DLMM pools |
| PumpSwap | `pswapRwCM9XkqRitvwZwYnBMu8aHq5W4zT2oM4VaSyg` | Pump.fun graduated tokens |
| Pump.fun | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | Bonding curve (early detection) |

## ⚙️ Configuration

### RPC Configuration
```env
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
SOLANA_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

**Recommended**: [Helius](https://helius.dev) - Free tier works with Two-Phase Detection!

### Paper Trading Mode
```env
PAPER_TRADING=true  # Set to false for live trading
```

### Wallet
```env
WALLET_PRIVATE_KEY=your_base58_private_key
```

⚠️ **Security**: Use a dedicated trading wallet with limited funds. Never use your main wallet.

### Trading Parameters
```env
TRADE_SIZE_SOL=0.1           # SOL per trade
MAX_SLIPPAGE_BPS=300         # 3% max slippage
PRIORITY_FEE_LAMPORTS=100000 # Priority fee
```

### Momentum Thresholds
```env
ENTRY_THRESHOLD=2.5          # Z-score to enter
EXIT_THRESHOLD=0.5           # Z-score to exit
CONFIRMATION_SECONDS=3       # Time above threshold before entry
```

### Risk Parameters
```env
MIN_LIQUIDITY_SOL=10         # Minimum pool liquidity
MAX_POSITION_PCT_OF_POOL=1   # Max trade as % of pool
MIN_UNIQUE_WALLETS=5         # Minimum unique buyers
MAX_WALLET_CONCENTRATION_PCT=50  # Max single-wallet dominance
MAX_HOLD_TIME_MS=300000      # 5 minute max hold
MAX_CONCURRENT_POSITIONS=3   # Max simultaneous positions
```

## 📈 Momentum Scoring

The bot calculates a momentum score using z-scores of key metrics:

```
score = 0.20 × zscore(swap_count_15s) +
        0.35 × zscore(net_inflow_15s) +
        0.25 × zscore(unique_buyers_60s) +
        0.20 × zscore(price_change_60s)
```

A token enters when:
1. Score exceeds `ENTRY_THRESHOLD` (default: 2.5)
2. Stays above threshold for `CONFIRMATION_SECONDS` (default: 3s)
3. All 8 risk gates pass

## 🛡️ Risk Gates

Before ANY entry, the following gates must pass:

| # | Gate | Description |
|---|------|-------------|
| 1 | Minimum Liquidity | Pool has sufficient SOL depth |
| 2 | Wallet Diversity | Multiple unique participants |
| 3 | Buyer Concentration | No single-wallet dominance (>50%) |
| 4 | Buy/Sell Imbalance | Healthy ratio (1.0 - 20.0) |
| 5 | Position Size | Trade won't move market excessively |
| 6 | Wash Trading | No suspicious patterns detected |
| 7 | Momentum Confirmation | Sustained above threshold |
| 8 | Sell Simulation | Exit route exists |

## 🚪 Exit Logic

Positions are closed when ANY of these triggers:

- **Flow Reversal**: Negative net inflow for 5+ seconds
- **Momentum Decay**: Score below exit threshold for 3+ checks
- **Max Hold Time**: Time limit reached (default 5 minutes)

## 📁 Project Structure

```
src/
├── index.ts                 # Entry point
├── bot.ts                   # Main orchestrator
├── config/config.ts         # Configuration
├── types/index.ts           # Type definitions
├── listener/
│   ├── event-listener.ts    # WebSocket + Two-Phase Detection
│   ├── hot-token-tracker.ts # Phase 1 tracking
│   ├── helius-parser.ts     # Transaction parsing
│   ├── token-verifier.ts    # SPL mint verification
│   └── parsers/             # DEX-specific log parsers
├── universe/
│   ├── token-universe.ts    # Token registry
│   └── token-state.ts       # Per-token state
├── analytics/
│   ├── analytics-engine.ts  # Metric computation
│   └── rolling-window.ts    # Sliding windows
├── scoring/
│   └── momentum-scorer.ts   # Z-score calculation
├── risk/
│   └── risk-gates.ts        # Safety checks
├── execution/
│   ├── execution-engine.ts  # Transaction handling
│   └── jupiter-client.ts    # Jupiter API
├── positions/
│   └── position-manager.ts  # Position lifecycle
├── logging/
│   ├── logger.ts            # Logging system
│   └── metrics.ts           # Metrics tracking
├── replay/
│   └── replay-harness.ts    # Backtesting
└── test/
    ├── validate-tx.ts       # Transaction validator
    └── simulate-momentum.ts # Momentum simulation
```

## 📝 Logging

All events are logged to:
- **Console**: Human-readable format with emojis
- **`logs/bot.log`**: Structured JSON (verbose)
- **`logs/events_YYYY-MM-DD.jsonl`**: Replay-compatible event stream

### Status Report Example
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 STATUS | Uptime: 5m | Swaps/min: 42 | Active tokens: 8
🔍 PHASE 1 (FREE): Tracking 312 tokens | Hot: 28
📈 Waiting for momentum score ≥ 2.5 (sustained 3s)
⏳ No trades yet - waiting for high-momentum opportunities
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## 🔄 Replay/Backtesting

Replay historical events through the signal engine:

```bash
npm run replay ./logs/events_2026-01-15.jsonl
```

This will:
- Process all historical swap events
- Run through the same momentum detection
- Simulate entries and exits
- Generate performance metrics

## 🧪 Development

```bash
# Run in development mode
npm run dev

# Build for production
npm run build

# Validate a transaction
npm run validate:tx <signature>

# Run tests
npm test

# Lint code
npm run lint
```

## ⚠️ Important Notes

### What This Bot Does
- ✅ Detects momentum from on-chain swap activity
- ✅ Uses multiple time windows (5s/15s/60s) for analysis
- ✅ Applies strict risk management
- ✅ Optimizes for low-cost RPC usage (Helius Free Plan compatible)

### What This Bot Does NOT Do
- ❌ Snipe new pool launches
- ❌ Use off-chain signals (Twitter, Discord, Telegram)
- ❌ Copy trade wallets
- ❌ Predict price direction
- ❌ Use fixed take-profit rules
- ❌ Front-run other traders

### Operational Recommendations
- 🖥️ Run on a stable server (VPS recommended)
- 📊 Monitor logs for errors
- 💵 Start with small position sizes
- 🔌 Use Helius for reliable RPC
- ⛽ Keep sufficient SOL for fees (~0.1 SOL buffer)

## ⚖️ Risk Disclaimer

This bot trades real assets on Solana mainnet. Trading cryptocurrency carries significant risk. You could lose your entire investment. This software is provided as-is with no guarantees.

**USE AT YOUR OWN RISK.**

## 📄 License

MIT

---

Built with ❤️ for the Solana ecosystem.
