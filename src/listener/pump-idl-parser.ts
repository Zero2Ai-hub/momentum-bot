/**
 * Pump.fun IDL-based Event Parser
 * 
 * Decodes TradeEvent directly from "Program data:" logs using the pump.fun IDL.
 * This gives us EXACT swap data: mint, sol_amount, is_buy, user, timestamp.
 * 
 * NO GUESSING - NO ESTIMATION - REAL DATA!
 */

import { PublicKey } from '@solana/web3.js';
import { SwapEvent, SwapDirection, DEXSource } from '../types';
import { log } from '../logging/logger';
import Decimal from 'decimal.js';
import * as bs58 from 'bs58';

// TradeEvent discriminator from pump_fun_idl.json
// [189, 219, 127, 211, 78, 230, 97, 238]
const TRADE_EVENT_DISCRIMINATOR = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);

// CreateEvent discriminator (for filtering out create events)
const CREATE_EVENT_DISCRIMINATOR = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);

// Discriminator size
const DISCRIMINATOR_SIZE = 8;
const PUBKEY_SIZE = 32;
const U64_SIZE = 8;
const I64_SIZE = 8;
const BOOL_SIZE = 1;

/**
 * TradeEvent structure from pump.fun IDL:
 * - mint: pubkey (32 bytes)
 * - sol_amount: u64 (8 bytes)
 * - token_amount: u64 (8 bytes)
 * - is_buy: bool (1 byte)
 * - user: pubkey (32 bytes)
 * - timestamp: i64 (8 bytes)
 * - virtual_sol_reserves: u64 (8 bytes)
 * - virtual_token_reserves: u64 (8 bytes)
 * - real_sol_reserves: u64 (8 bytes)
 * - real_token_reserves: u64 (8 bytes)
 * - fee_recipient: pubkey (32 bytes)
 * - fee_basis_points: u64 (8 bytes)
 */
export interface PumpTradeEvent {
  mint: string;
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: string;
  timestamp: bigint;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  feeRecipient: string;
  feeBasisPoints: bigint;
}

/**
 * Decode a TradeEvent from raw bytes
 */
function decodeTradeEvent(data: Buffer): PumpTradeEvent | null {
  try {
    // Check minimum size
    const minSize = DISCRIMINATOR_SIZE + PUBKEY_SIZE + U64_SIZE * 2 + BOOL_SIZE + PUBKEY_SIZE + I64_SIZE + U64_SIZE * 4 + PUBKEY_SIZE + U64_SIZE;
    if (data.length < minSize) {
      return null;
    }

    // Check discriminator
    const discriminator = data.subarray(0, DISCRIMINATOR_SIZE);
    if (!discriminator.equals(TRADE_EVENT_DISCRIMINATOR)) {
      return null;
    }

    let offset = DISCRIMINATOR_SIZE;

    // mint: pubkey (32 bytes)
    const mintBytes = data.subarray(offset, offset + PUBKEY_SIZE);
    const mint = new PublicKey(mintBytes).toBase58();
    offset += PUBKEY_SIZE;

    // sol_amount: u64 (8 bytes, little endian)
    const solAmount = data.readBigUInt64LE(offset);
    offset += U64_SIZE;

    // token_amount: u64 (8 bytes, little endian)
    const tokenAmount = data.readBigUInt64LE(offset);
    offset += U64_SIZE;

    // is_buy: bool (1 byte)
    const isBuy = data[offset] === 1;
    offset += BOOL_SIZE;

    // user: pubkey (32 bytes)
    const userBytes = data.subarray(offset, offset + PUBKEY_SIZE);
    const user = new PublicKey(userBytes).toBase58();
    offset += PUBKEY_SIZE;

    // timestamp: i64 (8 bytes, little endian)
    const timestamp = data.readBigInt64LE(offset);
    offset += I64_SIZE;

    // virtual_sol_reserves: u64
    const virtualSolReserves = data.readBigUInt64LE(offset);
    offset += U64_SIZE;

    // virtual_token_reserves: u64
    const virtualTokenReserves = data.readBigUInt64LE(offset);
    offset += U64_SIZE;

    // real_sol_reserves: u64
    const realSolReserves = data.readBigUInt64LE(offset);
    offset += U64_SIZE;

    // real_token_reserves: u64
    const realTokenReserves = data.readBigUInt64LE(offset);
    offset += U64_SIZE;

    // fee_recipient: pubkey (32 bytes)
    const feeRecipientBytes = data.subarray(offset, offset + PUBKEY_SIZE);
    const feeRecipient = new PublicKey(feeRecipientBytes).toBase58();
    offset += PUBKEY_SIZE;

    // fee_basis_points: u64
    const feeBasisPoints = data.readBigUInt64LE(offset);

    return {
      mint,
      solAmount,
      tokenAmount,
      isBuy,
      user,
      timestamp,
      virtualSolReserves,
      virtualTokenReserves,
      realSolReserves,
      realTokenReserves,
      feeRecipient,
      feeBasisPoints,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Parse TradeEvents from transaction logs
 * Looks for "Program data:" entries and decodes them using the IDL
 */
export function parseTradeEventsFromLogs(logs: string[]): PumpTradeEvent[] {
  const events: PumpTradeEvent[] = [];

  for (const logLine of logs) {
    // Look for "Program data:" entries
    if (logLine.includes('Program data:')) {
      try {
        // Extract base64 encoded data
        const parts = logLine.split('Program data:');
        if (parts.length < 2) continue;
        
        const base64Data = parts[1].trim();
        const decodedData = Buffer.from(base64Data, 'base64');

        // Try to decode as TradeEvent
        const tradeEvent = decodeTradeEvent(decodedData);
        if (tradeEvent) {
          events.push(tradeEvent);
        }
      } catch (error) {
        // Ignore decode errors - not all Program data is TradeEvent
        continue;
      }
    }
  }

  return events;
}

/**
 * Convert PumpTradeEvent to SwapEvent
 */
export function tradeEventToSwapEvent(
  tradeEvent: PumpTradeEvent, 
  signature: string,
  slot: number
): SwapEvent {
  // Convert lamports to SOL
  const solAmountDecimal = new Decimal(tradeEvent.solAmount.toString()).div(1e9);

  return {
    signature,
    slot,
    timestamp: Number(tradeEvent.timestamp) * 1000, // Convert to milliseconds
    tokenMint: tradeEvent.mint,
    direction: tradeEvent.isBuy ? SwapDirection.BUY : SwapDirection.SELL,
    notionalSol: solAmountDecimal,
    walletAddress: tradeEvent.user,
    dexSource: DEXSource.PUMPFUN,
  };
}

// Minimum notional to be considered a real trade (filters dust/dead tokens)
// Trades under 0.05 SOL (~$7.50) are too small to indicate real momentum
// Dead tokens like 5xLB7Sf4DdX... had 0.01-0.02 SOL trades that triggered false HOT
const MIN_NOTIONAL_SOL = 0.05;

/**
 * Parse swap events from pump.fun program logs
 * This is the main entry point for the momentum bot
 * 
 * IMPORTANT: Filters out dust trades (< 0.001 SOL) to avoid
 * false momentum signals from dead tokens with nano-SOL activity
 */
export function parsePumpFunSwapsFromLogs(
  logs: string[],
  signature: string,
  slot: number
): SwapEvent[] {
  const tradeEvents = parseTradeEventsFromLogs(logs);
  
  return tradeEvents
    .map(te => tradeEventToSwapEvent(te, signature, slot))
    .filter(event => {
      // DUST FILTER: Skip nano-SOL trades
      // Tokens like CFXtByBTVSTx... had trades of 0.00000005 SOL
      // These are dead tokens and shouldn't trigger momentum
      const notionalNum = event.notionalSol.toNumber();
      if (notionalNum < MIN_NOTIONAL_SOL) {
        return false;
      }
      return true;
    });
}

/**
 * Check if logs contain a pump.fun TradeEvent
 */
export function logsContainTradeEvent(logs: string[]): boolean {
  for (const logLine of logs) {
    if (logLine.includes('Program data:')) {
      try {
        const parts = logLine.split('Program data:');
        if (parts.length < 2) continue;
        
        const base64Data = parts[1].trim();
        const decodedData = Buffer.from(base64Data, 'base64');

        // Check discriminator
        if (decodedData.length >= DISCRIMINATOR_SIZE) {
          const discriminator = decodedData.subarray(0, DISCRIMINATOR_SIZE);
          if (discriminator.equals(TRADE_EVENT_DISCRIMINATOR)) {
            return true;
          }
        }
      } catch {
        continue;
      }
    }
  }
  return false;
}

// Debug mode
const DEBUG = process.env.DEBUG === '1';

if (DEBUG) {
  log.info('PumpFun IDL Parser loaded', {
    tradeEventDiscriminator: TRADE_EVENT_DISCRIMINATOR.toString('hex')
  });
}
