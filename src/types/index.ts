/**
 * Core type definitions for the Solana Momentum Trading Bot
 */

import { PublicKey } from '@solana/web3.js';
import Decimal from 'decimal.js';

// ─────────────────────────────────────────────────────────────
// SWAP EVENT TYPES
// ─────────────────────────────────────────────────────────────

export enum SwapDirection {
  BUY = 'BUY',   // SOL/USDC → Token
  SELL = 'SELL', // Token → SOL/USDC
}

export enum DEXSource {
  RAYDIUM_V4 = 'RAYDIUM_V4',
  RAYDIUM_CLMM = 'RAYDIUM_CLMM',
  ORCA_WHIRLPOOL = 'ORCA_WHIRLPOOL',
  METEORA = 'METEORA',
  PUMPSWAP = 'PUMPSWAP',
  PUMPFUN = 'PUMPFUN',
  UNKNOWN = 'UNKNOWN',
}

export interface SwapEvent {
  signature: string;           // Transaction signature (for dedup)
  slot: number;                // Solana slot
  timestamp: number;           // Unix timestamp (ms)
  tokenMint: string;           // Token mint address
  direction: SwapDirection;    // BUY or SELL
  notionalSol: Decimal;        // Value in SOL terms
  walletAddress: string;       // Trader wallet
  dexSource: DEXSource;        // Which DEX
  poolAddress?: string;        // Pool address if available
  priceImpactBps?: number;     // Price impact if calculable
}

// ─────────────────────────────────────────────────────────────
// ROLLING WINDOW METRICS
// ─────────────────────────────────────────────────────────────

export interface WindowMetrics {
  windowSizeMs: number;
  swapCount: number;
  buyCount: number;
  sellCount: number;
  buyNotional: Decimal;
  sellNotional: Decimal;
  netInflow: Decimal;          // buyNotional - sellNotional
  uniqueBuyers: Set<string>;
  uniqueSellers: Set<string>;
  topBuyerConcentration: number; // % of buy volume from top wallet
  priceChangePercent: number;    // Approximate price change
  firstTimestamp: number;
  lastTimestamp: number;
}

export interface TokenMetrics {
  tokenMint: string;
  windows: {
    '5s': WindowMetrics;
    '15s': WindowMetrics;
    '60s': WindowMetrics;
  };
  allTimeSwapCount: number;
  firstSeenTimestamp: number;
  lastActivityTimestamp: number;
  estimatedPrice: Decimal;      // Latest estimated price in SOL
  estimatedLiquidity: Decimal;  // Estimated pool liquidity
}

// ─────────────────────────────────────────────────────────────
// MOMENTUM SCORING
// ─────────────────────────────────────────────────────────────

export interface MomentumScore {
  tokenMint: string;
  timestamp: number;
  totalScore: number;
  components: {
    swapCountZScore: number;
    netInflowZScore: number;
    uniqueBuyersZScore: number;
    priceChangeZScore: number;
  };
  isAboveEntryThreshold: boolean;
  isAboveExitThreshold: boolean;
  consecutiveAboveEntry: number; // Seconds above entry threshold
}

// ─────────────────────────────────────────────────────────────
// RISK GATE RESULTS
// ─────────────────────────────────────────────────────────────

export interface RiskGateResult {
  passed: boolean;
  gateName: string;
  reason?: string;
  value?: number;
  threshold?: number;
}

export interface RiskAssessment {
  tokenMint: string;
  timestamp: number;
  allGatesPassed: boolean;
  gates: RiskGateResult[];
  overallRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
}

// ─────────────────────────────────────────────────────────────
// EXECUTION TYPES
// ─────────────────────────────────────────────────────────────

export enum OrderSide {
  BUY = 'BUY',
  SELL = 'SELL',
}

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inputAmount: Decimal;
  expectedOutputAmount: Decimal;
  minimumOutputAmount: Decimal;
  priceImpactBps: number;
  route: string;               // Serialized route info
  expiresAt: number;
}

export interface ExecutionResult {
  success: boolean;
  signature?: string;
  confirmedSlot?: number;
  inputAmount: Decimal;
  actualOutputAmount?: Decimal;
  expectedOutputAmount?: Decimal;
  slippageBps?: number;
  error?: string;
  retryCount: number;
  executionTimeMs: number;
}

// ─────────────────────────────────────────────────────────────
// POSITION TYPES
// ─────────────────────────────────────────────────────────────

export enum PositionStatus {
  PENDING_ENTRY = 'PENDING_ENTRY',
  ACTIVE = 'ACTIVE',
  PENDING_EXIT = 'PENDING_EXIT',
  CLOSED = 'CLOSED',
  FAILED = 'FAILED',
}

export enum ExitReason {
  MOMENTUM_DECAY = 'MOMENTUM_DECAY',
  FLOW_REVERSAL = 'FLOW_REVERSAL',
  MAX_HOLD_TIME = 'MAX_HOLD_TIME',
  MANUAL = 'MANUAL',
  ERROR = 'ERROR',
}

export interface Position {
  id: string;
  tokenMint: string;
  status: PositionStatus;
  
  // Entry details
  entryTimestamp: number;
  entrySignature?: string;
  entryPriceSol: Decimal;
  entrySizeSol: Decimal;
  tokenAmount: Decimal;
  entryMomentumScore: number;
  
  // Exit details
  exitTimestamp?: number;
  exitSignature?: string;
  exitPriceSol?: Decimal;
  exitSizeSol?: Decimal;
  exitReason?: ExitReason;
  exitMomentumScore?: number;
  
  // Performance
  unrealizedPnlSol?: Decimal;
  realizedPnlSol?: Decimal;
  realizedPnlPercent?: number;
  holdTimeMs?: number;
  
  // Risk tracking
  maxMomentumScore: number;
  minMomentumScore: number;
  consecutiveNegativeInflow: number;
}

// ─────────────────────────────────────────────────────────────
// LOGGING TYPES
// ─────────────────────────────────────────────────────────────

export enum LogEventType {
  // Swap events
  SWAP_DETECTED = 'SWAP_DETECTED',
  
  // Token lifecycle
  TOKEN_ENTERED_UNIVERSE = 'TOKEN_ENTERED_UNIVERSE',
  TOKEN_EXITED_UNIVERSE = 'TOKEN_EXITED_UNIVERSE',
  
  // Momentum/scoring
  MOMENTUM_THRESHOLD_CROSSED = 'MOMENTUM_THRESHOLD_CROSSED',
  RISK_GATE_CHECK = 'RISK_GATE_CHECK',
  
  // Trading signals
  ENTRY_SIGNAL = 'ENTRY_SIGNAL',
  EXIT_SIGNAL = 'EXIT_SIGNAL',
  ORDER_SUBMITTED = 'ORDER_SUBMITTED',
  ORDER_CONFIRMED = 'ORDER_CONFIRMED',
  ORDER_FAILED = 'ORDER_FAILED',
  POSITION_OPENED = 'POSITION_OPENED',
  POSITION_CLOSED = 'POSITION_CLOSED',
  
  // Phase 1 observability
  PHASE1_CANDIDATE_SEEN = 'PHASE1_CANDIDATE_SEEN',
  PHASE1_HOT_TRIGGERED = 'PHASE1_HOT_TRIGGERED',
  PHASE1_COOLDOWN_SKIP = 'PHASE1_COOLDOWN_SKIP',
  
  // Phase 2 observability
  PHASE2_STARTED = 'PHASE2_STARTED',
  PHASE2_VERIFIED = 'PHASE2_VERIFIED',
  PHASE2_REJECTED = 'PHASE2_REJECTED',
  PHASE2_NOISE_REJECTED = 'PHASE2_NOISE_REJECTED',
  
  // RPC tracking
  RPC_COUNTERS = 'RPC_COUNTERS',
  
  // Venue resolution
  VENUE_RESOLVE_START = 'VENUE_RESOLVE_START',
  VENUE_RESOLVE_RESULT = 'VENUE_RESOLVE_RESULT',
  
  // Errors
  ERROR = 'ERROR',
}

export interface LogEvent {
  type: LogEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────
// CONFIGURATION TYPES
// ─────────────────────────────────────────────────────────────

export interface BotConfig {
  // RPC
  rpcUrl: string;
  wsUrl: string;
  
  // Paper Trading Mode
  paperTrading: boolean;
  
  // Wallet
  walletPrivateKey: string;
  
  // Jupiter
  jupiterApiUrl: string;
  
  // Trading
  tradeSizeSol: Decimal;
  maxSlippageBps: number;
  priorityFeeLamports: number;
  
  // Momentum
  entryThreshold: number;
  exitThreshold: number;
  confirmationSeconds: number;
  
  // Risk
  minLiquiditySol: Decimal;
  maxPositionPctOfPool: number;
  minUniqueWallets: number;
  maxWalletConcentrationPct: number;
  maxHoldTimeMs: number;
  maxConcurrentPositions: number;
  
  // Scoring weights
  weights: {
    swapCount: number;
    netInflow: number;
    uniqueBuyers: number;
    priceChange: number;
  };
  
  // Universe
  tokenInactivityTimeoutMs: number;
  
  // Two-Phase Detection (credit optimization)
  hotTokenThreshold: number;       // Swaps needed to trigger Phase 2
  hotTokenWindowMs: number;        // Time window for hot token detection
  
  // Venue Resolution (credit optimization for pump-origin tokens)
  preferPumpSwapForPumpMints: boolean; // Check PumpSwap first for pump-origin tokens
  maxRaydiumSignaturesToParse: number; // Limit Raydium parsing (expensive)
  
  // Logging
  logLevel: string;
  logDir: string;
}

// ─────────────────────────────────────────────────────────────
// UTILITY TYPES
// ─────────────────────────────────────────────────────────────

export type WindowSize = '5s' | '15s' | '60s';

export const WINDOW_SIZES: Record<WindowSize, number> = {
  '5s': 5_000,
  '15s': 15_000,
  '60s': 60_000,
};

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Known DEX program IDs
export const DEX_PROGRAM_IDS = {
  RAYDIUM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  METEORA: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  PUMPSWAP: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  PUMPFUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
};
