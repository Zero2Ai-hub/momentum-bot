/**
 * Helius Transaction Parser
 * Uses Helius enhanced transaction API to get properly parsed swap data
 * including the actual token mints (not garbage addresses).
 */

import { Connection } from '@solana/web3.js';
import { SwapEvent, SwapDirection, DEXSource } from '../types';
import { getConfig } from '../config/config';
import { log } from '../logging/logger';
import Decimal from 'decimal.js';

// Cache of recently parsed transactions to avoid duplicate parsing
const parsedSignatures = new Set<string>();
const MAX_CACHE_SIZE = 5000;

/**
 * Parse a transaction using Helius enhanced API to extract swap details
 */
export async function parseTransactionWithHelius(
  connection: Connection,
  signature: string,
  slot: number
): Promise<SwapEvent | null> {
  // Skip if already parsed
  if (parsedSignatures.has(signature)) {
    return null;
  }
  
  try {
    // Get parsed transaction from Helius
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
    
    if (!tx || !tx.meta || tx.meta.err) {
      return null;
    }
    
    // Look for token transfers in the transaction
    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];
    
    // Find token mints involved (exclude SOL)
    const tokenMints = new Set<string>();
    
    for (const balance of [...preBalances, ...postBalances]) {
      if (balance.mint && balance.mint !== 'So11111111111111111111111111111111111111112') {
        tokenMints.add(balance.mint);
      }
    }
    
    if (tokenMints.size === 0) {
      return null; // No tokens involved
    }
    
    // Get the main token mint (first non-SOL token)
    const tokenMint = Array.from(tokenMints)[0];
    
    // Calculate SOL change to determine direction and notional
    let notionalSol = new Decimal(0);
    let direction = SwapDirection.BUY;
    
    // Look at SOL balance changes
    const accountKeys = tx.transaction.message.accountKeys;
    const preSOL = tx.meta.preBalances;
    const postSOL = tx.meta.postBalances;
    
    if (preSOL && postSOL && preSOL.length > 0) {
      // First account is usually the signer/wallet
      const solChange = postSOL[0] - preSOL[0];
      
      if (solChange < 0) {
        // SOL decreased = bought token
        direction = SwapDirection.BUY;
        notionalSol = new Decimal(Math.abs(solChange)).div(1e9);
      } else if (solChange > 0) {
        // SOL increased = sold token  
        direction = SwapDirection.SELL;
        notionalSol = new Decimal(solChange).div(1e9);
      }
    }
    
    // Get wallet address (first signer)
    let walletAddress = 'unknown';
    for (const key of accountKeys) {
      if ('pubkey' in key && key.signer) {
        walletAddress = key.pubkey.toBase58();
        break;
      }
    }
    
    // Determine DEX source from program IDs
    let dexSource = DEXSource.UNKNOWN;
    const programIds = tx.transaction.message.accountKeys
      .map(k => {
        if ('pubkey' in k) return k.pubkey.toBase58();
        if (typeof k === 'string') return k;
        return String(k);
      });
    
    if (programIds.some(p => p.includes('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'))) {
      dexSource = DEXSource.RAYDIUM_V4;
    } else if (programIds.some(p => p.includes('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'))) {
      dexSource = DEXSource.RAYDIUM_CLMM;
    } else if (programIds.some(p => p.includes('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'))) {
      dexSource = DEXSource.ORCA_WHIRLPOOL;
    } else if (programIds.some(p => p.includes('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'))) {
      dexSource = DEXSource.METEORA;
    } else if (programIds.some(p => p.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'))) {
      dexSource = DEXSource.PUMPFUN;
    } else if (programIds.some(p => p.includes('pswapRwCM9XkqRitvwZwYnBMu8aHq5W4zT2oM4VaSyg'))) {
      dexSource = DEXSource.PUMPSWAP;
    }
    
    // Cache this signature
    parsedSignatures.add(signature);
    if (parsedSignatures.size > MAX_CACHE_SIZE) {
      // Clear oldest entries
      const toDelete = Array.from(parsedSignatures).slice(0, MAX_CACHE_SIZE / 2);
      toDelete.forEach(s => parsedSignatures.delete(s));
    }
    
    // Only return if we have meaningful data
    if (notionalSol.gt(0) && tokenMint) {
      return {
        signature,
        slot,
        timestamp: tx.blockTime ? tx.blockTime * 1000 : Date.now(),
        tokenMint,
        direction,
        notionalSol,
        walletAddress,
        dexSource,
      };
    }
    
    return null;
    
  } catch (error) {
    log.debug('Failed to parse transaction', { 
      signature: signature.slice(0, 16), 
      error: (error as Error).message 
    });
    return null;
  }
}

/**
 * Extract token mint from parsed instruction if available
 */
export function extractTokenFromParsedInstruction(instruction: any): string | null {
  try {
    // SPL Token instructions have parsed info with mint
    if (instruction.parsed?.info?.mint) {
      return instruction.parsed.info.mint;
    }
    
    // Some instructions have tokenMint directly
    if (instruction.parsed?.info?.tokenMint) {
      return instruction.parsed.info.tokenMint;
    }
    
    return null;
  } catch {
    return null;
  }
}
