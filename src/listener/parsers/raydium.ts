/**
 * Raydium swap log parser
 * Parses swap events from Raydium V4 and CLMM program logs.
 */

import Decimal from 'decimal.js';
import { SwapEvent, SwapDirection, DEXSource, SOL_MINT } from '../../types';
import { isValidTokenMint } from './known-addresses';

// Raydium log patterns
const SWAP_LOG_PATTERN = /ray_log: (.+)/;
const SWAP_INSTRUCTION_PATTERN = /Program log: Instruction: Swap/i;

/**
 * Parse Raydium swap logs into SwapEvent objects.
 * 
 * Raydium V4 emits base64-encoded ray_log data containing:
 * - Input token amount
 * - Output token amount
 * - Pool info
 * 
 * This is a simplified parser - production would decode the full structure.
 */
export function parseRaydiumSwap(
  signature: string,
  slot: number,
  logs: string[],
  source: DEXSource
): SwapEvent[] {
  const events: SwapEvent[] = [];
  
  // Check if this is a swap transaction
  const hasSwapInstruction = logs.some(log => SWAP_INSTRUCTION_PATTERN.test(log));
  if (!hasSwapInstruction) {
    return events;
  }
  
  // Look for ray_log entries
  let tokenMint: string | null = null;
  let direction: SwapDirection = SwapDirection.BUY;
  let notionalSol = new Decimal(0);
  let walletAddress: string | null = null;
  let poolAddress: string | null = null;
  
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    
    // Extract ray_log data
    const rayLogMatch = log.match(SWAP_LOG_PATTERN);
    if (rayLogMatch) {
      try {
        const decoded = parseRayLogData(rayLogMatch[1]);
        if (decoded) {
          tokenMint = decoded.tokenMint;
          direction = decoded.direction;
          notionalSol = decoded.notionalSol;
          poolAddress = decoded.poolAddress;
        }
      } catch {
        // Continue trying other logs
      }
    }
    
    // Try to extract wallet from invoke logs
    // Pattern: "Program ... invoke [N]" followed by account keys
    if (log.includes('invoke [1]') && i + 1 < logs.length) {
      // The invoking account is typically logged nearby
      const nextLog = logs[i + 1];
      const accountMatch = nextLog.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
      if (accountMatch && !walletAddress) {
        walletAddress = accountMatch[1];
      }
    }
  }
  
  // If we couldn't parse structured data, try heuristic extraction
  if (!tokenMint) {
    const extracted = extractFromLogsHeuristic(logs, signature);
    if (extracted) {
      tokenMint = extracted.tokenMint;
      direction = extracted.direction;
      notionalSol = extracted.notionalSol;
      walletAddress = extracted.walletAddress || walletAddress;
    }
  }
  
  // Create event if we have minimum required data
  if (tokenMint && notionalSol.gt(0)) {
    events.push({
      signature,
      slot,
      timestamp: Date.now(), // Would ideally come from block time
      tokenMint,
      direction,
      notionalSol,
      walletAddress: walletAddress || 'unknown',
      dexSource: source,
      poolAddress: poolAddress || undefined,
    });
  }
  
  return events;
}

/**
 * Parse base64-encoded ray_log data
 */
function parseRayLogData(base64Data: string): {
  tokenMint: string;
  direction: SwapDirection;
  notionalSol: Decimal;
  poolAddress: string;
} | null {
  try {
    // Decode base64
    const buffer = Buffer.from(base64Data, 'base64');
    
    // Raydium ray_log structure (simplified):
    // Bytes 0-7: discriminator
    // Bytes 8-15: input amount (u64)
    // Bytes 16-23: output amount (u64)
    // Bytes 24+: various pool/token data
    
    if (buffer.length < 24) {
      return null;
    }
    
    // Read amounts as little-endian u64
    const inputAmount = buffer.readBigUInt64LE(8);
    const outputAmount = buffer.readBigUInt64LE(16);
    
    // Determine direction based on which side is SOL
    // This is heuristic - real implementation would check account keys
    const inputLamports = new Decimal(inputAmount.toString());
    const outputLamports = new Decimal(outputAmount.toString());
    
    // Assume SOL is the larger amount in lamports (9 decimals)
    // Token is smaller (usually 6-9 decimals but smaller raw value)
    let direction: SwapDirection;
    let notionalSol: Decimal;
    
    if (inputLamports.gt(outputLamports.mul(1000))) {
      // Input is much larger -> likely SOL input -> BUY token
      direction = SwapDirection.BUY;
      notionalSol = inputLamports.div(1e9); // Convert lamports to SOL
    } else {
      // Output is larger -> likely SOL output -> SELL token
      direction = SwapDirection.SELL;
      notionalSol = outputLamports.div(1e9);
    }
    
    // Extract token mint (would need account keys in real impl)
    // For now, generate a placeholder that will be overwritten
    const tokenMint = 'unknown';
    
    return {
      tokenMint,
      direction,
      notionalSol,
      poolAddress: 'unknown',
    };
  } catch {
    return null;
  }
}

/**
 * Heuristic extraction from log strings
 * Fallback when structured parsing fails
 */
function extractFromLogsHeuristic(logs: string[], signature: string): {
  tokenMint: string;
  direction: SwapDirection;
  notionalSol: Decimal;
  walletAddress: string | null;
} | null {
  let tokenMint: string | null = null;
  let direction = SwapDirection.BUY;
  let notionalSol = new Decimal(0);
  let walletAddress: string | null = null;
  
  // Look for mint addresses in logs
  const mintPattern = /([1-9A-HJ-NP-Za-km-z]{32,44})/g;
  const allMints: string[] = [];
  
  for (const log of logs) {
    const matches = log.match(mintPattern);
    if (matches) {
      allMints.push(...matches);
    }
    
    // Look for amount patterns
    const amountMatch = log.match(/amount[:\s]+(\d+)/i);
    if (amountMatch) {
      const amount = new Decimal(amountMatch[1]);
      // Assume lamports if large number
      if (amount.gt(1e6)) {
        notionalSol = amount.div(1e9);
      }
    }
    
    // Look for transfer patterns to determine direction
    if (log.toLowerCase().includes('transfer') && log.includes(SOL_MINT)) {
      // SOL is being transferred
      if (log.includes('source') || log.includes('from')) {
        direction = SwapDirection.BUY; // SOL leaving wallet = buying token
      } else {
        direction = SwapDirection.SELL; // SOL entering wallet = selling token
      }
    }
  }
  
  // Find the most likely token mint using the known addresses filter
  for (const mint of allMints) {
    if (isValidTokenMint(mint)) {
      tokenMint = mint;
      break;
    }
  }
  
  // Set default notional if we couldn't extract
  if (notionalSol.isZero()) {
    notionalSol = new Decimal(0.01); // Minimum placeholder
  }
  
  if (tokenMint) {
    return {
      tokenMint,
      direction,
      notionalSol,
      walletAddress,
    };
  }
  
  return null;
}

/**
 * Parse account keys from transaction to get accurate wallet address
 * This would be called with transaction data from RPC
 */
export function extractWalletFromAccounts(
  accountKeys: string[],
  programId: string
): string | null {
  // The first non-program account is typically the signer/wallet
  for (const key of accountKeys) {
    if (key !== programId && 
        key !== SOL_MINT &&
        !key.startsWith('1111') && // System program
        !key.startsWith('Token')) {
      return key;
    }
  }
  return null;
}
