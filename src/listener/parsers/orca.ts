/**
 * Orca Whirlpool swap log parser
 * Parses swap events from Orca Whirlpool program logs.
 */

import Decimal from 'decimal.js';
import { SwapEvent, SwapDirection, DEXSource, SOL_MINT } from '../../types';
import { isValidTokenMint } from './known-addresses';

// Orca Whirlpool log patterns
const SWAP_INSTRUCTION_PATTERN = /Program log: Instruction: Swap/i;
const TWO_HOP_PATTERN = /Program log: Instruction: TwoHopSwap/i;

/**
 * Parse Orca Whirlpool swap logs into SwapEvent objects.
 * 
 * Orca Whirlpools emit logs with swap details including:
 * - Token amounts
 * - Price impact
 * - Tick changes
 */
export function parseOrcaSwap(
  signature: string,
  slot: number,
  logs: string[]
): SwapEvent[] {
  const events: SwapEvent[] = [];
  
  // Check if this is a swap transaction
  const hasSwapInstruction = logs.some(log => 
    SWAP_INSTRUCTION_PATTERN.test(log) || TWO_HOP_PATTERN.test(log)
  );
  
  if (!hasSwapInstruction) {
    return events;
  }
  
  // Parse the swap data from logs
  const parsed = parseWhirlpoolLogs(logs);
  
  if (parsed && parsed.tokenMint && parsed.notionalSol.gt(0)) {
    events.push({
      signature,
      slot,
      timestamp: Date.now(),
      tokenMint: parsed.tokenMint,
      direction: parsed.direction,
      notionalSol: parsed.notionalSol,
      walletAddress: parsed.walletAddress || 'unknown',
      dexSource: DEXSource.ORCA_WHIRLPOOL,
      poolAddress: parsed.poolAddress || undefined,
      priceImpactBps: parsed.priceImpactBps,
    });
  }
  
  return events;
}

/**
 * Parse Whirlpool-specific log format
 */
function parseWhirlpoolLogs(logs: string[]): {
  tokenMint: string | null;
  direction: SwapDirection;
  notionalSol: Decimal;
  walletAddress: string | null;
  poolAddress: string | null;
  priceImpactBps: number | undefined;
} | null {
  let tokenMint: string | null = null;
  let direction = SwapDirection.BUY;
  let notionalSol = new Decimal(0);
  let walletAddress: string | null = null;
  let poolAddress: string | null = null;
  let priceImpactBps: number | undefined;
  
  // Collect all potential addresses and amounts
  const addresses: string[] = [];
  const amounts: Decimal[] = [];
  
  for (const log of logs) {
    // Extract addresses (Solana base58 format)
    const addressMatches = log.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/g);
    if (addressMatches) {
      addresses.push(...addressMatches);
    }
    
    // Look for amount logs
    // Orca often logs: "Program log: amount_a: X, amount_b: Y"
    const amountAMatch = log.match(/amount_?a[:\s]+(\d+)/i);
    const amountBMatch = log.match(/amount_?b[:\s]+(\d+)/i);
    
    if (amountAMatch) {
      amounts.push(new Decimal(amountAMatch[1]));
    }
    if (amountBMatch) {
      amounts.push(new Decimal(amountBMatch[1]));
    }
    
    // Generic amount pattern
    const genericAmountMatch = log.match(/amount[:\s]+(\d+)/i);
    if (genericAmountMatch && !amountAMatch && !amountBMatch) {
      amounts.push(new Decimal(genericAmountMatch[1]));
    }
    
    // Look for direction indicators
    if (log.toLowerCase().includes('a_to_b')) {
      // Token A to Token B
      direction = SwapDirection.BUY;
    } else if (log.toLowerCase().includes('b_to_a')) {
      direction = SwapDirection.SELL;
    }
    
    // Look for sqrt_price or tick changes (indicates swap executed)
    const sqrtPriceMatch = log.match(/sqrt_price[:\s]+(\d+)/i);
    if (sqrtPriceMatch) {
      // Swap definitely executed
    }
    
    // Extract price impact if logged
    const impactMatch = log.match(/price_?impact[:\s]+(\d+)/i);
    if (impactMatch) {
      priceImpactBps = parseInt(impactMatch[1]);
    }
  }
  
  // Filter addresses to find likely token mint using known addresses filter
  for (const addr of addresses) {
    // Skip if it's not a valid token mint candidate
    if (!isValidTokenMint(addr)) {
      continue;
    }
    
    // First valid address could be wallet
    if (!walletAddress) {
      walletAddress = addr;
      continue;
    }
    
    // Second could be pool
    if (!poolAddress) {
      poolAddress = addr;
      continue;
    }
    
    // Third could be token mint
    if (!tokenMint) {
      tokenMint = addr;
    }
  }
  
  // Calculate notional from amounts
  if (amounts.length >= 2) {
    // Assume the larger amount is SOL (in lamports)
    const sortedAmounts = amounts.sort((a, b) => b.minus(a).toNumber());
    const potentialSolAmount = sortedAmounts[0];
    
    // Convert if it looks like lamports (> 1M)
    if (potentialSolAmount.gt(1e6)) {
      notionalSol = potentialSolAmount.div(1e9);
    } else {
      notionalSol = potentialSolAmount;
    }
  } else if (amounts.length === 1) {
    const amount = amounts[0];
    if (amount.gt(1e6)) {
      notionalSol = amount.div(1e9);
    } else {
      notionalSol = amount;
    }
  }
  
  // Set minimum notional if we couldn't extract
  if (notionalSol.isZero()) {
    notionalSol = new Decimal(0.001);
  }
  
  return {
    tokenMint,
    direction,
    notionalSol,
    walletAddress,
    poolAddress,
    priceImpactBps,
  };
}

/**
 * Decode Orca Whirlpool instruction data
 * Used when we have access to raw instruction data
 */
export function decodeWhirlpoolSwapInstruction(data: Buffer): {
  amountIn: bigint;
  amountOutMin: bigint;
  sqrtPriceLimit: bigint;
  aToB: boolean;
} | null {
  try {
    // Whirlpool swap instruction layout:
    // 0: discriminator (8 bytes)
    // 8: amount (u64)
    // 16: other_amount_threshold (u64)  
    // 24: sqrt_price_limit (u128)
    // 40: amount_specified_is_input (bool)
    // 41: a_to_b (bool)
    
    if (data.length < 42) {
      return null;
    }
    
    const amountIn = data.readBigUInt64LE(8);
    const amountOutMin = data.readBigUInt64LE(16);
    // sqrt_price_limit is u128, read as two u64s
    const sqrtPriceLimitLow = data.readBigUInt64LE(24);
    const sqrtPriceLimitHigh = data.readBigUInt64LE(32);
    const sqrtPriceLimit = sqrtPriceLimitLow + (sqrtPriceLimitHigh << BigInt(64));
    const aToB = data[41] === 1;
    
    return {
      amountIn,
      amountOutMin,
      sqrtPriceLimit,
      aToB,
    };
  } catch {
    return null;
  }
}
