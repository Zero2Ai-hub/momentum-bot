/**
 * PumpSwap IDL Parser - Parse GRADUATED pump.fun tokens traded on PumpSwap AMM
 * 
 * PumpSwap Program ID: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 * 
 * When a pump.fun token graduates (~$69K market cap), it migrates to PumpSwap AMM.
 * This parser decodes the BuyEvent and SellEvent from PumpSwap transactions to get:
 * - Real SOL amounts (quote_amount_in / quote_amount_out)
 * - Token amounts (base_amount_out / base_amount_in)
 * - Direction (BUY vs SELL)
 * - Timestamp
 * 
 * NOTE: The event data does NOT include user (wallet) or mint. 
 * These come from the instruction accounts.
 */

import Decimal from 'decimal.js';
import { SwapEvent, SwapDirection, DEXSource } from '../types';
import { log } from '../logging/logger';

// PumpSwap Program ID
export const PUMPSWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

// Event discriminators from IDL (8 bytes)
const BUY_EVENT_DISCRIMINATOR = Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]);
const SELL_EVENT_DISCRIMINATOR = Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]);

// Instruction discriminators
const BUY_INSTRUCTION_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_INSTRUCTION_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

const DISCRIMINATOR_SIZE = 8;

// Minimum notional to count as real trade (filters dust)
const MIN_NOTIONAL_SOL = 0.05;

/**
 * PumpSwap BuyEvent structure:
 * - timestamp: i64
 * - base_amount_out: u64 (token received)
 * - max_quote_amount_in: u64
 * - user_base_token_reserves: u64
 * - user_quote_token_reserves: u64
 * - pool_base_token_reserves: u64
 * - pool_quote_token_reserves: u64
 * - quote_amount_in: u64 (SOL spent)
 * - lp_fee_basis_points: u64
 * - lp_fee: u64
 * - protocol_fee_basis_points: u64
 * - protocol_fee: u64
 * - quote_amount_in_with_lp_fee: u64
 * - user_quote_amount_in: u64
 */
interface PumpSwapBuyEvent {
  timestamp: bigint;
  baseAmountOut: bigint;     // Token received
  quoteAmountIn: bigint;     // SOL spent
  poolBaseReserves: bigint;
  poolQuoteReserves: bigint;
}

/**
 * PumpSwap SellEvent structure:
 * - timestamp: i64
 * - base_amount_in: u64 (token sold)
 * - min_quote_amount_out: u64
 * - user_base_token_reserves: u64
 * - user_quote_token_reserves: u64
 * - pool_base_token_reserves: u64
 * - pool_quote_token_reserves: u64
 * - quote_amount_out: u64 (SOL received)
 * - lp_fee_basis_points: u64
 * - lp_fee: u64
 * - protocol_fee_basis_points: u64
 * - protocol_fee: u64
 * - quote_amount_out_with_lp_fee: u64
 * - user_quote_amount_out: u64
 */
interface PumpSwapSellEvent {
  timestamp: bigint;
  baseAmountIn: bigint;      // Token sold
  quoteAmountOut: bigint;    // SOL received
  poolBaseReserves: bigint;
  poolQuoteReserves: bigint;
}

/**
 * Parsed PumpSwap swap data
 */
export interface PumpSwapEvent {
  direction: SwapDirection;
  solAmount: bigint;         // In lamports
  tokenAmount: bigint;
  timestamp: bigint;
  poolBaseReserves: bigint;
  poolQuoteReserves: bigint;
}

/**
 * Decode a BuyEvent from raw bytes
 */
function decodeBuyEvent(data: Buffer): PumpSwapBuyEvent | null {
  try {
    // Check discriminator
    if (data.length < DISCRIMINATOR_SIZE) return null;
    const discriminator = data.subarray(0, DISCRIMINATOR_SIZE);
    if (!discriminator.equals(BUY_EVENT_DISCRIMINATOR)) return null;

    // Parse fields (starting after discriminator)
    let offset = DISCRIMINATOR_SIZE;
    
    const timestamp = data.readBigInt64LE(offset); offset += 8;
    const baseAmountOut = data.readBigUInt64LE(offset); offset += 8;
    /* skip max_quote_amount_in */ offset += 8;
    /* skip user_base_token_reserves */ offset += 8;
    /* skip user_quote_token_reserves */ offset += 8;
    const poolBaseReserves = data.readBigUInt64LE(offset); offset += 8;
    const poolQuoteReserves = data.readBigUInt64LE(offset); offset += 8;
    const quoteAmountIn = data.readBigUInt64LE(offset); offset += 8;

    return {
      timestamp,
      baseAmountOut,
      quoteAmountIn,
      poolBaseReserves,
      poolQuoteReserves,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Decode a SellEvent from raw bytes
 */
function decodeSellEvent(data: Buffer): PumpSwapSellEvent | null {
  try {
    // Check discriminator
    if (data.length < DISCRIMINATOR_SIZE) return null;
    const discriminator = data.subarray(0, DISCRIMINATOR_SIZE);
    if (!discriminator.equals(SELL_EVENT_DISCRIMINATOR)) return null;

    // Parse fields (starting after discriminator)
    let offset = DISCRIMINATOR_SIZE;
    
    const timestamp = data.readBigInt64LE(offset); offset += 8;
    const baseAmountIn = data.readBigUInt64LE(offset); offset += 8;
    /* skip min_quote_amount_out */ offset += 8;
    /* skip user_base_token_reserves */ offset += 8;
    /* skip user_quote_token_reserves */ offset += 8;
    const poolBaseReserves = data.readBigUInt64LE(offset); offset += 8;
    const poolQuoteReserves = data.readBigUInt64LE(offset); offset += 8;
    const quoteAmountOut = data.readBigUInt64LE(offset); offset += 8;

    return {
      timestamp,
      baseAmountIn,
      quoteAmountOut,
      poolBaseReserves,
      poolQuoteReserves,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Parse PumpSwap events from transaction logs
 * Returns parsed event data (direction, SOL amount, etc.)
 * 
 * NOTE: The token mint and user wallet must be extracted from instruction accounts separately.
 */
export function parsePumpSwapEventFromLogs(logs: string[]): PumpSwapEvent | null {
  for (const logLine of logs) {
    if (!logLine.includes('Program data:')) continue;
    
    try {
      const parts = logLine.split('Program data:');
      if (parts.length < 2) continue;
      
      const base64Data = parts[1].trim();
      const decodedData = Buffer.from(base64Data, 'base64');

      // Try BuyEvent first
      const buyEvent = decodeBuyEvent(decodedData);
      if (buyEvent) {
        return {
          direction: SwapDirection.BUY,
          solAmount: buyEvent.quoteAmountIn,
          tokenAmount: buyEvent.baseAmountOut,
          timestamp: buyEvent.timestamp,
          poolBaseReserves: buyEvent.poolBaseReserves,
          poolQuoteReserves: buyEvent.poolQuoteReserves,
        };
      }

      // Try SellEvent
      const sellEvent = decodeSellEvent(decodedData);
      if (sellEvent) {
        return {
          direction: SwapDirection.SELL,
          solAmount: sellEvent.quoteAmountOut,
          tokenAmount: sellEvent.baseAmountIn,
          timestamp: sellEvent.timestamp,
          poolBaseReserves: sellEvent.poolBaseReserves,
          poolQuoteReserves: sellEvent.poolQuoteReserves,
        };
      }
    } catch (error) {
      continue;
    }
  }
  
  return null;
}

/**
 * Check if logs contain a PumpSwap swap event
 */
export function logsContainPumpSwapEvent(logs: string[]): boolean {
  for (const logLine of logs) {
    if (!logLine.includes('Program data:')) continue;
    
    try {
      const parts = logLine.split('Program data:');
      if (parts.length < 2) continue;
      
      const base64Data = parts[1].trim();
      const decodedData = Buffer.from(base64Data, 'base64');

      if (decodedData.length >= DISCRIMINATOR_SIZE) {
        const discriminator = decodedData.subarray(0, DISCRIMINATOR_SIZE);
        if (discriminator.equals(BUY_EVENT_DISCRIMINATOR) || 
            discriminator.equals(SELL_EVENT_DISCRIMINATOR)) {
          return true;
        }
      }
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Convert PumpSwap event to SwapEvent
 * Requires tokenMint and wallet from instruction accounts
 */
export function pumpSwapEventToSwapEvent(
  event: PumpSwapEvent,
  tokenMint: string,
  wallet: string,
  signature: string,
  slot: number
): SwapEvent {
  // Convert lamports to SOL
  const solAmountDecimal = new Decimal(event.solAmount.toString()).div(1e9);

  return {
    signature,
    slot,
    timestamp: Number(event.timestamp) * 1000, // Convert to milliseconds
    tokenMint,
    direction: event.direction,
    notionalSol: solAmountDecimal,
    walletAddress: wallet,
    dexSource: DEXSource.PUMPSWAP,
  };
}

/**
 * Parse PumpSwap swaps from logs with real data
 * 
 * This function:
 * 1. Decodes the BuyEvent/SellEvent from Program data
 * 2. Extracts token mint and wallet from logs (account patterns)
 * 
 * For full accuracy, the transaction's instruction accounts should be used,
 * but we can often extract the mint from log patterns.
 */
export function parsePumpSwapSwapsFromLogs(
  logs: string[],
  signature: string,
  slot: number
): SwapEvent[] {
  const events: SwapEvent[] = [];
  
  // Try to parse the swap event
  const swapEvent = parsePumpSwapEventFromLogs(logs);
  if (!swapEvent) return events;

  // Convert SOL amount to decimal for filtering
  const solAmountDecimal = new Decimal(swapEvent.solAmount.toString()).div(1e9);
  
  // Filter dust trades
  if (solAmountDecimal.lt(MIN_NOTIONAL_SOL)) {
    return events;
  }

  // Try to extract token mint from logs
  // PumpSwap tokens still end with "pump" since they graduated from pump.fun
  let tokenMint: string | null = null;
  let wallet: string | null = null;

  // Scan logs for addresses
  const addressPattern = /([1-9A-HJ-NP-Za-km-z]{43,44})/g;
  
  for (const logLine of logs) {
    // Look for pump token mint (ends with "pump")
    const matches = logLine.match(addressPattern);
    if (matches) {
      for (const addr of matches) {
        if (addr.endsWith('pump') && !tokenMint) {
          tokenMint = addr;
        }
        // First non-pump address that's not a known program could be wallet
        // This is a heuristic - for accurate data, use getParsedTransaction
      }
    }
    
    // Look for signer/user patterns
    if (logLine.toLowerCase().includes('signer') || 
        logLine.toLowerCase().includes('user')) {
      const userMatch = logLine.match(addressPattern);
      if (userMatch && userMatch[0] && !userMatch[0].endsWith('pump')) {
        wallet = userMatch[0];
      }
    }
  }

  // If we found a token mint, emit the event
  if (tokenMint) {
    events.push({
      signature,
      slot,
      timestamp: Number(swapEvent.timestamp) * 1000,
      tokenMint,
      direction: swapEvent.direction,
      notionalSol: solAmountDecimal,
      walletAddress: wallet || 'unknown', // Fallback if we can't extract wallet
      dexSource: DEXSource.PUMPSWAP,
    });
  }

  return events;
}

// Debug mode
const DEBUG = process.env.DEBUG === '1';

if (DEBUG) {
  log.info('PumpSwap IDL Parser loaded', {
    programId: PUMPSWAP_PROGRAM_ID,
    buyEventDiscriminator: BUY_EVENT_DISCRIMINATOR.toString('hex'),
    sellEventDiscriminator: SELL_EVENT_DISCRIMINATOR.toString('hex'),
  });
}
