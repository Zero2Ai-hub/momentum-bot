/**
 * Configuration management for the trading bot.
 * Loads from environment variables with sensible defaults.
 */

import dotenv from 'dotenv';
import Decimal from 'decimal.js';
import { BotConfig } from '../types';

// Load environment variables
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function optionalNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseFloat(value) : defaultValue;
}

export function loadConfig(): BotConfig {
  return {
    // RPC Configuration
    rpcUrl: optionalEnv('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
    wsUrl: optionalEnv('SOLANA_WS_URL', 'wss://api.mainnet-beta.solana.com'),
    
    // Paper Trading Mode - MUST be false for real execution
    paperTrading: optionalEnv('PAPER_TRADING', 'true').toLowerCase() === 'true',
    
    // Wallet - Required for actual trading
    walletPrivateKey: optionalEnv('WALLET_PRIVATE_KEY', ''),
    
    // Jupiter API
    jupiterApiUrl: optionalEnv('JUPITER_API_URL', 'https://quote-api.jup.ag/v6'),
    
    // Trading Parameters
    // Default 0.1 SOL (~$20-25 at typical prices)
    tradeSizeSol: new Decimal(optionalNumber('TRADE_SIZE_SOL', 0.1)),
    maxSlippageBps: optionalNumber('MAX_SLIPPAGE_BPS', 300), // 3%
    priorityFeeLamports: optionalNumber('PRIORITY_FEE_LAMPORTS', 100_000),
    
    // Momentum Thresholds
    // Entry threshold: combined z-score must exceed this
    entryThreshold: optionalNumber('ENTRY_THRESHOLD', 2.5),
    // Exit threshold: below this triggers exit
    exitThreshold: optionalNumber('EXIT_THRESHOLD', 0.5),
    // Must stay above entry threshold for this many seconds
    confirmationSeconds: optionalNumber('CONFIRMATION_SECONDS', 3),
    
    // Risk Parameters
    minLiquiditySol: new Decimal(optionalNumber('MIN_LIQUIDITY_SOL', 10)),
    maxPositionPctOfPool: optionalNumber('MAX_POSITION_PCT_OF_POOL', 1), // 1%
    minUniqueWallets: optionalNumber('MIN_UNIQUE_WALLETS', 5),
    maxWalletConcentrationPct: optionalNumber('MAX_WALLET_CONCENTRATION_PCT', 50),
    maxHoldTimeMs: optionalNumber('MAX_HOLD_TIME_MS', 300_000), // 5 minutes
    maxConcurrentPositions: optionalNumber('MAX_CONCURRENT_POSITIONS', 3),
    
    // Scoring Weights (should sum to 1.0 for interpretability)
    weights: {
      swapCount: optionalNumber('WEIGHT_SWAP_COUNT', 0.2),
      netInflow: optionalNumber('WEIGHT_NET_INFLOW', 0.35),
      uniqueBuyers: optionalNumber('WEIGHT_UNIQUE_BUYERS', 0.25),
      priceChange: optionalNumber('WEIGHT_PRICE_CHANGE', 0.2),
    },
    
    // Token Universe Management
    tokenInactivityTimeoutMs: optionalNumber('TOKEN_INACTIVITY_TIMEOUT_MS', 120_000), // 2 minutes
    
    // Logging
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
    logDir: optionalEnv('LOG_DIR', './logs'),
  };
}

// Singleton config instance
let configInstance: BotConfig | null = null;

export function getConfig(): BotConfig {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}

// For testing - allows resetting config
export function resetConfig(): void {
  configInstance = null;
}

/**
 * Validate configuration values
 */
export function validateConfig(config: BotConfig): string[] {
  const errors: string[] = [];
  
  if (config.tradeSizeSol.lte(0)) {
    errors.push('Trade size must be positive');
  }
  
  if (config.maxSlippageBps < 0 || config.maxSlippageBps > 5000) {
    errors.push('Max slippage must be between 0 and 5000 bps (50%)');
  }
  
  if (config.entryThreshold <= config.exitThreshold) {
    errors.push('Entry threshold must be greater than exit threshold');
  }
  
  if (config.minLiquiditySol.lte(0)) {
    errors.push('Minimum liquidity must be positive');
  }
  
  if (config.maxPositionPctOfPool <= 0 || config.maxPositionPctOfPool > 10) {
    errors.push('Max position percent of pool must be between 0 and 10%');
  }
  
  const weightSum = 
    config.weights.swapCount + 
    config.weights.netInflow + 
    config.weights.uniqueBuyers + 
    config.weights.priceChange;
  
  if (Math.abs(weightSum - 1.0) > 0.01) {
    errors.push(`Scoring weights should sum to 1.0, got ${weightSum}`);
  }
  
  return errors;
}
