/**
 * PumpSwap (pump.fun DEX) swap log parser
 * Parses swap events from PumpSwap program logs.
 * 
 * PumpSwap is the AMM used by pump.fun for graduated tokens.
 * Program ID: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 * 
 * KEY: Uses IDL-based decoding of "Program data:" for REAL swap data!
 * BuyEvent and SellEvent give us exact SOL amounts (quote_amount_in/out).
 */

import Decimal from 'decimal.js';
import { SwapEvent, SwapDirection, DEXSource } from '../../types';
import { isValidTokenMint, isKnownProgram } from './known-addresses';
import { parsePumpSwapSwapsFromLogs } from '../pumpswap-idl-parser';

// PumpSwap log patterns
const SWAP_INSTRUCTION_PATTERN = /Program log: Instruction: (Swap|Buy|Sell)/i;
const BUY_PATTERN = /Program log: Instruction: Buy/i;
const SELL_PATTERN = /Program log: Instruction: Sell/i;

// Known PumpSwap infrastructure addresses
const PUMPSWAP_INFRASTRUCTURE = new Set([
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',  // PumpSwap program
  'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',  // Protocol fee
  'FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9', // Flash protocol
  'proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u', // Pool authority
]);

// Known infrastructure prefixes
const INFRASTRUCTURE_PREFIXES = [
  'pfee',
  'FLASH', 
  'pump',
  'pro',  // Often pool authorities
];

/**
 * Check if an address is infrastructure
 */
function isInfrastructure(address: string): boolean {
  if (PUMPSWAP_INFRASTRUCTURE.has(address)) {
    return true;
  }
  
  for (const prefix of INFRASTRUCTURE_PREFIXES) {
    if (address.startsWith(prefix)) {
      return true;
    }
  }
  
  if (isKnownProgram(address)) {
    return true;
  }
  
  return false;
}

/**
 * Check if an address is a likely real token mint
 * 
 * CRITICAL: All pump.fun/pumpswap tokens end with "pump" - this is by design!
 * This filters out 95%+ of false positives (pool addresses, authorities, etc.)
 */
function isLikelyTokenMint(address: string): boolean {
  if (!isValidTokenMint(address)) {
    return false;
  }
  
  if (isInfrastructure(address)) {
    return false;
  }
  
  // CRITICAL: PumpSwap tokens MUST end with "pump"
  // This is the strongest filter against pool/authority addresses
  if (!address.endsWith('pump')) {
    return false;
  }
  
  return true;
}

/**
 * Parse PumpSwap-specific log format (internal helper)
 */
function parsePumpSwapLogsInternal(
  logs: string[],
  isBuy: boolean,
  isSell: boolean
): {
  tokenMint: string | null;
  direction: SwapDirection;
  notionalSol: Decimal;
  walletAddress: string | null;
  poolAddress: string | null;
} | null {
  let tokenMint: string | null = null;
  let direction = isBuy ? SwapDirection.BUY : (isSell ? SwapDirection.SELL : SwapDirection.BUY);
  let notionalSol = new Decimal(0);
  let walletAddress: string | null = null;
  let poolAddress: string | null = null;
  
  const potentialTokenMints: string[] = [];
  const potentialWallets: string[] = [];
  const amounts: Decimal[] = [];
  
  for (let i = 0; i < logs.length; i++) {
    const logLine = logs[i];
    
    // Skip logs from other programs
    if (logLine.includes('Program') && logLine.includes('invoke') && 
        !logLine.includes('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')) {
      continue;
    }
    
    // Look for "mint" keyword - strong signal for token mint
    if (logLine.toLowerCase().includes('mint') && !logLine.toLowerCase().includes('amount')) {
      const mintMatch = logLine.match(/([1-9A-HJ-NP-Za-km-z]{43,44})/);
      if (mintMatch && isLikelyTokenMint(mintMatch[1])) {
        potentialTokenMints.unshift(mintMatch[1]);
      }
    }
    
    // Look for user/signer patterns
    if (logLine.toLowerCase().includes('user') || 
        logLine.toLowerCase().includes('signer') ||
        logLine.toLowerCase().includes('owner')) {
      const walletMatch = logLine.match(/([1-9A-HJ-NP-Za-km-z]{43,44})/);
      if (walletMatch && !isInfrastructure(walletMatch[1])) {
        potentialWallets.push(walletMatch[1]);
      }
    }
    
    // Look for SOL amount patterns
    const solAmountMatch = logLine.match(/sol_?amount[:\s]+(\d+)/i);
    if (solAmountMatch) {
      amounts.push(new Decimal(solAmountMatch[1]));
    }
    
    const lamportsMatch = logLine.match(/lamports[:\s]+(\d+)/i);
    if (lamportsMatch) {
      amounts.push(new Decimal(lamportsMatch[1]));
    }
    
    // Look for pool address
    if (logLine.toLowerCase().includes('pool')) {
      const poolMatch = logLine.match(/([1-9A-HJ-NP-Za-km-z]{43,44})/);
      if (poolMatch) {
        poolAddress = poolMatch[1];
      }
    }
  }
  
  // Fallback: scan for valid addresses if we didn't find explicit ones
  if (potentialTokenMints.length === 0 || potentialWallets.length === 0) {
    for (const logLine of logs) {
      const addressMatches = logLine.match(/([1-9A-HJ-NP-Za-km-z]{43,44})/g);
      if (addressMatches) {
        for (const addr of addressMatches) {
          if (isLikelyTokenMint(addr)) {
            if (potentialTokenMints.length === 0 || !potentialTokenMints.includes(addr)) {
              potentialTokenMints.push(addr);
            }
          }
          if (!isInfrastructure(addr) && !potentialTokenMints.includes(addr)) {
            if (!potentialWallets.includes(addr)) {
              potentialWallets.push(addr);
            }
          }
        }
      }
    }
  }
  
  // Select best candidates
  for (const addr of potentialTokenMints) {
    if (isLikelyTokenMint(addr)) {
      tokenMint = addr;
      break;
    }
  }
  
  for (const addr of potentialWallets) {
    if (!isInfrastructure(addr) && addr !== tokenMint) {
      walletAddress = addr;
      break;
    }
  }
  
  // Calculate notional
  if (amounts.length > 0) {
    for (const amount of amounts) {
      if (amount.gt(1e6) && amount.lt(1e11)) {
        const solValue = amount.div(1e9);
        if (solValue.gt(notionalSol) && solValue.lt(100)) {
          notionalSol = solValue;
        }
      }
    }
  }
  
  return {
    tokenMint,
    direction,
    notionalSol,
    walletAddress,
    poolAddress,
  };
}

/**
 * Parse PumpSwap logs into SwapEvent objects.
 * 
 * TWO APPROACHES (in order of preference):
 * 1. IDL-based decoding: Decode BuyEvent/SellEvent from "Program data:" for EXACT SOL amounts
 * 2. Heuristic fallback: Pattern matching on log strings
 */
export function parsePumpSwapLogs(
  signature: string,
  slot: number,
  logs: string[]
): SwapEvent[] {
  // APPROACH 1: Try IDL-based decoding first (EXACT SOL AMOUNTS!)
  // This decodes BuyEvent/SellEvent directly from "Program data:" logs
  const idlEvents = parsePumpSwapSwapsFromLogs(logs, signature, slot);
  
  if (idlEvents.length > 0) {
    // Validate and return IDL-decoded events
    const validEvents: SwapEvent[] = [];
    for (const event of idlEvents) {
      // Sanity check
      if (event.tokenMint && 
          event.tokenMint.endsWith('pump') &&
          event.notionalSol.gt(0) &&
          event.notionalSol.lt(1000)) {
        validEvents.push(event);
      }
    }
    
    if (validEvents.length > 0) {
      return validEvents;
    }
  }
  
  // APPROACH 2: Fall back to heuristic parsing
  // Check if this is a swap transaction
  const hasSwapInstruction = logs.some(logLine => SWAP_INSTRUCTION_PATTERN.test(logLine));
  if (!hasSwapInstruction) {
    return [];
  }
  
  // Determine direction from instruction type
  const isBuy = logs.some(logLine => BUY_PATTERN.test(logLine));
  const isSell = logs.some(logLine => SELL_PATTERN.test(logLine));
  
  // Parse the swap data from logs using heuristics
  const parsed = parsePumpSwapLogsInternal(logs, isBuy, isSell);
  
  // STRICT: Only emit if we have valid data
  if (parsed && 
      parsed.tokenMint && 
      parsed.walletAddress &&
      parsed.walletAddress !== 'unknown' &&
      parsed.walletAddress !== parsed.tokenMint &&
      !isInfrastructure(parsed.walletAddress) &&
      parsed.notionalSol.gt(0) &&
      parsed.notionalSol.lt(1000)) {
    return [{
      signature,
      slot,
      timestamp: Date.now(),
      tokenMint: parsed.tokenMint,
      direction: parsed.direction,
      notionalSol: parsed.notionalSol,
      walletAddress: parsed.walletAddress,
      dexSource: DEXSource.PUMPSWAP,
      poolAddress: parsed.poolAddress || undefined,
    }];
  }
  
  return [];
}

// Backwards compatibility alias
export const parsePumpSwap = parsePumpSwapLogs;
