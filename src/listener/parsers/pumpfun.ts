/**
 * Pump.fun Bonding Curve swap log parser
 * Parses swap events from the pump.fun bonding curve program.
 * 
 * This is where tokens are traded BEFORE they graduate to PumpSwap/Raydium.
 * Program ID: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 * 
 * Bonding curve mechanics:
 * - Price increases as more tokens are bought
 * - Once market cap reaches ~$69k, token "graduates" to Raydium
 * - Early detection here can catch tokens before they moon
 */

import Decimal from 'decimal.js';
import { SwapEvent, SwapDirection, DEXSource } from '../../types';
import { isValidTokenMint, isKnownProgram } from './known-addresses';

// Pump.fun bonding curve log patterns
const BUY_PATTERN = /Program log: Instruction: Buy/i;
const SELL_PATTERN = /Program log: Instruction: Sell/i;
const SWAP_PATTERN = /Program log: Instruction: (Buy|Sell)/i;

// Known Pump.fun infrastructure prefixes - these are NOT tokens
const PUMPFUN_INFRASTRUCTURE_PREFIXES = [
  'pfee',   // Protocol fee accounts
  'FLASH',  // Flash loan accounts
  'pump',   // Pump program accounts
];

// Known Pump.fun infrastructure addresses (full addresses)
const PUMPFUN_INFRASTRUCTURE = new Set([
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // Pump.fun program
  'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',  // Protocol fee
  'FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9', // Flash protocol
  'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1', // Pump fee recipient
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM', // Another fee account
]);

/**
 * Check if an address looks like Pump.fun infrastructure
 */
function isPumpfunInfrastructure(address: string): boolean {
  // Check known addresses
  if (PUMPFUN_INFRASTRUCTURE.has(address)) {
    return true;
  }
  
  // Check known prefixes
  for (const prefix of PUMPFUN_INFRASTRUCTURE_PREFIXES) {
    if (address.startsWith(prefix)) {
      return true;
    }
  }
  
  // Check if it's a known program
  if (isKnownProgram(address)) {
    return true;
  }
  
  return false;
}

/**
 * Validate that an address is a likely real token mint
 * More strict than isValidTokenMint - specifically for Pump.fun
 * 
 * CRITICAL: ALL pump.fun tokens end with "pump" - this is by design!
 * This is the strongest heuristic we have to filter out pool addresses.
 */
function isLikelyTokenMint(address: string): boolean {
  // Must pass basic validation
  if (!isValidTokenMint(address)) {
    return false;
  }
  
  // Must not be Pump.fun infrastructure
  if (isPumpfunInfrastructure(address)) {
    return false;
  }
  
  // CRITICAL: Pump.fun tokens MUST end with "pump"
  // This filters out 95%+ of false positives (pool addresses, authorities, etc.)
  if (!address.endsWith('pump')) {
    return false;
  }
  
  return true;
}

/**
 * Parse Pump.fun bonding curve logs into SwapEvent objects.
 * 
 * Pump.fun emits logs with:
 * - Token mint address
 * - SOL amount
 * - Token amount
 * - Bonding curve state
 */
export function parsePumpFunSwap(
  signature: string,
  slot: number,
  logs: string[]
): SwapEvent[] {
  const events: SwapEvent[] = [];
  
  // Check if this is a buy/sell transaction
  const hasSwapInstruction = logs.some(log => SWAP_PATTERN.test(log));
  if (!hasSwapInstruction) {
    return events;
  }
  
  // Determine direction from instruction type
  const isBuy = logs.some(log => BUY_PATTERN.test(log));
  const isSell = logs.some(log => SELL_PATTERN.test(log));
  
  // Parse the swap data from logs
  const parsed = parsePumpFunLogs(logs, isBuy, isSell);
  
  // STRICT: Only emit event if we have VALID data
  if (parsed && 
      parsed.tokenMint && 
      parsed.walletAddress &&
      parsed.walletAddress !== 'unknown' &&
      parsed.walletAddress !== parsed.tokenMint &&  // Wallet can't be same as token
      !isPumpfunInfrastructure(parsed.walletAddress) &&  // Wallet can't be infrastructure
      parsed.notionalSol.gt(0) &&
      parsed.notionalSol.lt(1000)) {  // Sanity check: < 1000 SOL per trade
    events.push({
      signature,
      slot,
      timestamp: Date.now(),
      tokenMint: parsed.tokenMint,
      direction: parsed.direction,
      notionalSol: parsed.notionalSol,
      walletAddress: parsed.walletAddress,
      dexSource: DEXSource.PUMPFUN,
      poolAddress: parsed.bondingCurve || undefined,
    });
  }
  
  return events;
}

/**
 * Parse Pump.fun-specific log format
 */
function parsePumpFunLogs(
  logs: string[],
  isBuy: boolean,
  isSell: boolean
): {
  tokenMint: string | null;
  direction: SwapDirection;
  notionalSol: Decimal;
  walletAddress: string | null;
  bondingCurve: string | null;
} | null {
  let tokenMint: string | null = null;
  let direction = isBuy ? SwapDirection.BUY : (isSell ? SwapDirection.SELL : SwapDirection.BUY);
  let notionalSol = new Decimal(0);
  let walletAddress: string | null = null;
  let bondingCurve: string | null = null;
  
  // Collect addresses more carefully - categorize them
  const potentialTokenMints: string[] = [];
  const potentialWallets: string[] = [];
  const amounts: Decimal[] = [];
  
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    
    // Skip logs from other programs
    if (log.includes('Program') && log.includes('invoke') && 
        !log.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')) {
      continue;
    }
    
    // Look for "mint" keyword - strong signal for token mint
    if (log.toLowerCase().includes('mint') && !log.toLowerCase().includes('amount')) {
      const mintMatch = log.match(/([1-9A-HJ-NP-Za-km-z]{43,44})/);
      if (mintMatch && isLikelyTokenMint(mintMatch[1])) {
        potentialTokenMints.unshift(mintMatch[1]); // Prioritize explicit mint mentions
      }
    }
    
    // Look for user/buyer/seller patterns - these are wallets
    if (log.toLowerCase().includes('user') || 
        log.toLowerCase().includes('buyer') || 
        log.toLowerCase().includes('seller') ||
        log.toLowerCase().includes('signer')) {
      const walletMatch = log.match(/([1-9A-HJ-NP-Za-km-z]{43,44})/);
      if (walletMatch && !isPumpfunInfrastructure(walletMatch[1])) {
        potentialWallets.push(walletMatch[1]);
      }
    }
    
    // Look for SOL amount patterns - be specific
    const solAmountMatch = log.match(/sol_?amount[:\s]+(\d+)/i);
    if (solAmountMatch) {
      amounts.push(new Decimal(solAmountMatch[1]));
    }
    
    const lamportsMatch = log.match(/lamports[:\s]+(\d+)/i);
    if (lamportsMatch) {
      amounts.push(new Decimal(lamportsMatch[1]));
    }
    
    // Look for bonding curve address specifically
    if (log.toLowerCase().includes('bonding') || log.toLowerCase().includes('curve')) {
      const curveMatch = log.match(/([1-9A-HJ-NP-Za-km-z]{43,44})/);
      if (curveMatch) {
        bondingCurve = curveMatch[1];
      }
    }
  }
  
  // If we didn't find explicit token mint, scan all logs for valid token addresses
  // But be much more selective
  if (potentialTokenMints.length === 0) {
    for (const log of logs) {
      // Only extract from specific log patterns
      const addressMatches = log.match(/([1-9A-HJ-NP-Za-km-z]{43,44})/g);
      if (addressMatches) {
        for (const addr of addressMatches) {
          if (isLikelyTokenMint(addr) && !potentialWallets.includes(addr)) {
            potentialTokenMints.push(addr);
          }
        }
      }
    }
  }
  
  // Similarly for wallets
  if (potentialWallets.length === 0) {
    // Look for the first account after invoke (usually the signer/wallet)
    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      if (log.includes('invoke [1]')) {
        // Check next few logs for wallet
        for (let j = i + 1; j < Math.min(i + 5, logs.length); j++) {
          const nextLog = logs[j];
          const walletMatch = nextLog.match(/([1-9A-HJ-NP-Za-km-z]{43,44})/);
          if (walletMatch && 
              !isPumpfunInfrastructure(walletMatch[1]) &&
              !potentialTokenMints.includes(walletMatch[1])) {
            potentialWallets.push(walletMatch[1]);
            break;
          }
        }
        break;
      }
    }
  }
  
  // Select best candidates
  // Token mint: prefer first one found (most likely to be from "mint" keyword)
  for (const addr of potentialTokenMints) {
    if (isLikelyTokenMint(addr)) {
      tokenMint = addr;
      break;
    }
  }
  
  // Wallet: prefer first valid one
  for (const addr of potentialWallets) {
    if (!isPumpfunInfrastructure(addr) && addr !== tokenMint) {
      walletAddress = addr;
      break;
    }
  }
  
  // Calculate notional from amounts
  if (amounts.length > 0) {
    for (const amount of amounts) {
      // Pump.fun trades are typically 0.001 - 100 SOL
      // If it looks like lamports (> 1M and reasonable SOL amount < 100 SOL)
      if (amount.gt(1e6) && amount.lt(1e11)) {
        const solValue = amount.div(1e9);
        if (solValue.gt(notionalSol) && solValue.lt(100)) {
          notionalSol = solValue;
        }
      }
    }
  }
  
  // Don't set minimum notional - if we can't extract it, don't guess
  // This prevents fake events with 0.001 SOL default
  
  return {
    tokenMint,
    direction,
    notionalSol,
    walletAddress,
    bondingCurve,
  };
}
