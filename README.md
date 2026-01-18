# Solana Momentum Trading Bot

An on-chain momentum trading bot for Solana that detects tokens transitioning from low activity to real momentum using only on-chain signals.

## Features

- **On-Chain Signal Detection**: Uses swap activity, capital flows, and wallet participation
- **DEX Agnostic**: Monitors Raydium, Orca, Meteora simultaneously
- **Real-Time Processing**: WebSocket streaming with rolling window analytics
- **Risk Management**: Multiple safety gates before any trade
- **Momentum-Based Exits**: Exits on flow reversal or momentum decay
- **Replay System**: Backtest with historical event logs

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  Event Listener │───▶│  Token Universe  │───▶│    Analytics    │
│   (WebSocket)   │    │   (Registry)     │    │  (5s/15s/60s)   │
└─────────────────┘    └──────────────────┘    └────────┬────────┘
                                                        │
                       ┌──────────────────┐    ┌────────▼────────┐
                       │  Risk Gates      │◀───│ Momentum Scorer │
                       │  (8 checks)      │    │   (z-scores)    │
                       └────────┬─────────┘    └─────────────────┘
                                │
                       ┌────────▼─────────┐    ┌─────────────────┐
                       │ Execution Engine │───▶│Position Manager │
                       │   (Jupiter)      │    │  (Exit Logic)   │
                       └──────────────────┘    └─────────────────┘
```

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy the example configuration and edit with your settings:

```bash
cp config.example.env .env
```

Edit `.env` with:
- Your RPC endpoints (recommend Helius, Quicknode, or Triton)
- Wallet private key (Base58 encoded)
- Trading parameters

### 3. Build

```bash
npm run build
```

### 4. Run

```bash
# Development mode (with auto-reload)
npm run dev

# Production mode
npm start
```

## Configuration

### RPC Configuration
```env
SOLANA_RPC_URL=https://your-rpc-url.com
SOLANA_WS_URL=wss://your-ws-url.com
```

**Important**: Use a reliable RPC provider with WebSocket support. Free endpoints will likely be rate-limited.

### Wallet
```env
WALLET_PRIVATE_KEY=your_base58_private_key
```

⚠️ **Security**: Use a dedicated trading wallet with limited funds. Never use your main wallet.

### Trading Parameters
```env
TRADE_SIZE_SOL=0.1          # $20-25 per trade
MAX_SLIPPAGE_BPS=300        # 3% max slippage
PRIORITY_FEE_LAMPORTS=100000 # Priority fee for faster execution
```

### Momentum Thresholds
```env
ENTRY_THRESHOLD=2.5         # Z-score threshold to enter
EXIT_THRESHOLD=0.5          # Z-score threshold to exit
CONFIRMATION_SECONDS=3      # Time above threshold before entry
```

### Risk Parameters
```env
MIN_LIQUIDITY_SOL=10        # Minimum pool liquidity
MAX_POSITION_PCT_OF_POOL=1  # Max trade as % of pool
MIN_UNIQUE_WALLETS=5        # Minimum unique buyers
MAX_WALLET_CONCENTRATION_PCT=50  # Max single-wallet dominance
MAX_HOLD_TIME_MS=300000     # 5 minute max hold
MAX_CONCURRENT_POSITIONS=3  # Max simultaneous positions
```

## Momentum Scoring

The bot calculates a momentum score using z-scores of key metrics:

```
score = w1 * zscore(swap_count_15s) +
        w2 * zscore(net_inflow_15s) +
        w3 * zscore(unique_buyers_60s) +
        w4 * zscore(price_change_60s)
```

Default weights:
- Swap Count: 0.2
- Net Inflow: 0.35
- Unique Buyers: 0.25
- Price Change: 0.2

## Risk Gates

Before ANY entry, the following gates must pass:

1. **Minimum Liquidity**: Pool has sufficient depth
2. **Wallet Diversity**: Multiple unique participants
3. **Buyer Concentration**: No single-wallet dominance
4. **Buy/Sell Imbalance**: Healthy ratio (1.0 - 20.0)
5. **Position Size**: Trade won't move market excessively
6. **Wash Trading Detection**: No suspicious patterns
7. **Momentum Confirmation**: Sustained above threshold
8. **Sell Simulation**: Exit route exists

## Exit Logic

Positions are closed when ANY of these triggers:

- **Flow Reversal**: Negative net inflow for 5+ seconds
- **Momentum Decay**: Score below exit threshold for 3+ checks
- **Max Hold Time**: Time limit reached (default 5 minutes)

## Replay/Backtesting

Replay historical events through the signal engine:

```bash
npm run replay ./logs/events_2024-01-15.jsonl
```

This will:
- Process all historical swap events
- Run through the same momentum detection
- Simulate entries and exits
- Generate performance metrics

## Logging

All events are logged to:
- Console (human-readable)
- `logs/bot.log` (structured JSON)
- `logs/events_YYYY-MM-DD.jsonl` (replay format)

## Project Structure

```
src/
├── index.ts                 # Entry point
├── bot.ts                   # Main orchestrator
├── config/config.ts         # Configuration
├── types/index.ts           # Type definitions
├── listener/
│   ├── event-listener.ts    # WebSocket handler
│   └── parsers/             # DEX log parsers
├── universe/
│   ├── token-universe.ts    # Token registry
│   └── token-state.ts       # Per-token state
├── analytics/
│   └── rolling-window.ts    # Sliding windows
├── scoring/
│   └── momentum-scorer.ts   # Score calculation
├── risk/
│   └── risk-gates.ts        # Safety checks
├── execution/
│   ├── execution-engine.ts  # Transaction handling
│   └── jupiter-client.ts    # Jupiter API
├── positions/
│   └── position-manager.ts  # Position lifecycle
├── logging/
│   └── logger.ts            # Logging system
└── replay/
    └── replay-harness.ts    # Backtesting
```

## Important Notes

### What This Bot Does NOT Do
- ❌ Snipe new pool launches
- ❌ Use off-chain signals (Twitter, Discord)
- ❌ Copy trade wallets
- ❌ Predict price direction
- ❌ Use fixed take-profit rules

### Operational Considerations
- Run on a stable server (VPS recommended)
- Monitor logs for errors
- Start with small position sizes
- Use a reliable RPC provider
- Keep sufficient SOL for fees

### Risk Disclaimer
This bot trades real assets on Solana mainnet. Trading cryptocurrency carries significant risk. You could lose your entire investment. This software is provided as-is with no guarantees. Use at your own risk.

## Development

```bash
# Run in development mode
npm run dev

# Build for production
npm run build

# Run tests
npm test

# Lint code
npm run lint
```

## License

MIT
