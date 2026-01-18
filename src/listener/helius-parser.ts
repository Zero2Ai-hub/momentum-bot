/**
 * Helius Transaction Parser
 * Uses Helius enhanced transaction API to get properly parsed swap data.
 * 
 * FIX: Uses signer's net token delta to identify the traded token,
 * not the first mint in the balance list.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { SwapEvent, SwapDirection, DEXSource } from '../types';
import { log } from '../logging/logger';
import Decimal from 'decimal.js';

// Cache of recently parsed transactions to avoid duplicate parsing
const parsedSignatures = new Set<string>();
const MAX_CACHE_SIZE = 5000;

// wSOL mint - treat as base currency, not a token
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Stablecoins to exclude (treat as base)
const BASE_MINTS = new Set([
  WSOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

// Notional bounds (SOL)
const MIN_NOTIONAL_SOL = 0.0001; // 0.0001 SOL minimum
const MAX_NOTIONAL_SOL = 10000;  // 10000 SOL maximum (sanity check)

// Debug mode
const DEBUG = process.env.DEBUG === '1';

interface TokenDelta {
  mint: string;
  delta: number; // post - pre (in token units, normalized by decimals)
  decimals: number;
}

/**
 * Parse a transaction using Helius enhanced API to extract swap details
 * 
 * ALGORITHM:
 * 1. Find the signer (fee payer)
 * 2. Build per-mint deltas ONLY for balances owned by the signer
 * 3. Exclude wSOL/USDC/USDT (base currencies)
 * 4. Select the mint with the largest absolute delta
 * 5. Direction = delta > 0 ? BUY : SELL
 * 6. Notional SOL = signer's SOL balance change (minus fees)
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
    
    const accountKeys = tx.transaction.message.accountKeys;
    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];
    const preSOL = tx.meta.preBalances;
    const postSOL = tx.meta.postBalances;
    const fee = tx.meta.fee || 0;
    
    // STEP 1: Find the signer (first account with signer=true)
    let signerPubkey: string | null = null;
    let signerIndex = -1;
    
    for (let i = 0; i < accountKeys.length; i++) {
      const key = accountKeys[i];
      if ('pubkey' in key && key.signer) {
        signerPubkey = key.pubkey.toBase58();
        signerIndex = i;
        break;
      }
    }
    
    if (!signerPubkey || signerIndex < 0) {
      return null; // No signer found
    }
    
    // STEP 2: Build per-mint deltas for signer-owned token accounts
    const mintDeltas = new Map<string, TokenDelta>();
    
    // Build lookup for pre-balances
    const preBalanceMap = new Map<number, { mint: string; amount: number; decimals: number; owner: string }>();
    for (const bal of preBalances) {
      if (bal.owner === signerPubkey) {
        preBalanceMap.set(bal.accountIndex, {
          mint: bal.mint,
          amount: parseFloat(bal.uiTokenAmount.uiAmountString || '0'),
          decimals: bal.uiTokenAmount.decimals,
          owner: bal.owner,
        });
      }
    }
    
    // Build lookup for post-balances
    const postBalanceMap = new Map<number, { mint: string; amount: number; decimals: number; owner: string }>();
    for (const bal of postBalances) {
      if (bal.owner === signerPubkey) {
        postBalanceMap.set(bal.accountIndex, {
          mint: bal.mint,
          amount: parseFloat(bal.uiTokenAmount.uiAmountString || '0'),
          decimals: bal.uiTokenAmount.decimals,
          owner: bal.owner,
        });
      }
    }
    
    // Collect all account indices with signer-owned balances
    const accountIndices = new Set([...preBalanceMap.keys(), ...postBalanceMap.keys()]);
    
    for (const idx of accountIndices) {
      const pre = preBalanceMap.get(idx);
      const post = postBalanceMap.get(idx);
      
      // Determine mint (could be in pre, post, or both)
      const mint = pre?.mint || post?.mint;
      if (!mint) continue;
      
      // Skip base currencies
      if (BASE_MINTS.has(mint)) continue;
      
      const preAmount = pre?.amount || 0;
      const postAmount = post?.amount || 0;
      const decimals = pre?.decimals || post?.decimals || 0;
      
      const delta = postAmount - preAmount;
      
      // Aggregate deltas by mint (in case signer has multiple accounts for same mint)
      if (mintDeltas.has(mint)) {
        const existing = mintDeltas.get(mint)!;
        existing.delta += delta;
      } else {
        mintDeltas.set(mint, { mint, delta, decimals });
      }
    }
    
    // STEP 3: Select mint with largest absolute delta
    let selectedMint: string | null = null;
    let selectedDelta = 0;
    
    for (const [mint, info] of mintDeltas) {
      if (Math.abs(info.delta) > Math.abs(selectedDelta)) {
        selectedMint = mint;
        selectedDelta = info.delta;
      }
    }
    
    if (!selectedMint || selectedDelta === 0) {
      if (DEBUG) {
        log.debug('No signer-owned token delta found', { signature: signature.slice(0, 16), signer: signerPubkey.slice(0, 8) });
      }
      return null; // No swap detected
    }
    
    // STEP 4: Determine direction
    const direction = selectedDelta > 0 ? SwapDirection.BUY : SwapDirection.SELL;
    
    // STEP 5: Compute SOL notional from signer's balance change
    let notionalSol = new Decimal(0);
    
    if (preSOL && postSOL && signerIndex < preSOL.length) {
      const preSolLamports = preSOL[signerIndex];
      const postSolLamports = postSOL[signerIndex];
      const rawChange = postSolLamports - preSolLamports;
      
      if (direction === SwapDirection.BUY) {
        // BUY: signer spent SOL (pre > post after accounting for fees)
        // solSpent = (pre - post) - fee (fee is already deducted from post)
        const solSpentLamports = preSolLamports - postSolLamports - fee;
        
        // Sanity: if delta > 0 (bought tokens) but solSpent <= 0, invalid parse
        if (solSpentLamports <= 0) {
          if (DEBUG) {
            log.debug('Invalid BUY: non-positive SOL spent', { 
              signature: signature.slice(0, 16), 
              solSpent: solSpentLamports / 1e9,
              tokenDelta: selectedDelta 
            });
          }
          return null;
        }
        notionalSol = new Decimal(solSpentLamports).div(1e9);
      } else {
        // SELL: signer received SOL (post > pre)
        // solReceived = post - pre (fee already included in balance changes)
        const solReceivedLamports = postSolLamports - preSolLamports;
        
        // For sells, negative raw change after fee means no SOL received - might be a different base
        // Allow through if positive
        if (solReceivedLamports > 0) {
          notionalSol = new Decimal(solReceivedLamports).div(1e9);
        } else {
          // SELL but no SOL received - could be token-to-token swap
          // Use absolute token delta as proxy (less accurate but better than nothing)
          notionalSol = new Decimal(0.001); // Minimum placeholder
        }
      }
    }
    
    // STEP 6: Sanity filter on notional
    const notionalNum = notionalSol.toNumber();
    if (notionalNum < MIN_NOTIONAL_SOL || notionalNum > MAX_NOTIONAL_SOL) {
      if (DEBUG) {
        log.debug('Notional out of bounds', { 
          signature: signature.slice(0, 16), 
          notional: notionalNum,
          min: MIN_NOTIONAL_SOL,
          max: MAX_NOTIONAL_SOL 
        });
      }
      return null;
    }
    
    // Determine DEX source from program IDs
    let dexSource = DEXSource.UNKNOWN;
    const programIds = accountKeys.map(k => {
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
    
    // DEBUG output
    if (DEBUG) {
      log.info('PARSE_DEBUG', {
        signature: signature.slice(0, 16),
        signer: signerPubkey.slice(0, 12),
        candidateMints: Array.from(mintDeltas.entries()).map(([m, d]) => ({
          mint: m.slice(0, 12),
          delta: d.delta.toFixed(6),
        })),
        selectedMint: selectedMint.slice(0, 12),
        selectedDelta: selectedDelta.toFixed(6),
        direction,
        notionalSol: notionalSol.toString(),
      });
    }
    
    // Cache this signature
    parsedSignatures.add(signature);
    if (parsedSignatures.size > MAX_CACHE_SIZE) {
      const toDelete = Array.from(parsedSignatures).slice(0, MAX_CACHE_SIZE / 2);
      toDelete.forEach(s => parsedSignatures.delete(s));
    }
    
    return {
      signature,
      slot,
      timestamp: tx.blockTime ? tx.blockTime * 1000 : Date.now(),
      tokenMint: selectedMint,
      direction,
      notionalSol,
      walletAddress: signerPubkey,
      dexSource,
    };
    
  } catch (error) {
    log.debug('Failed to parse transaction', { 
      signature: signature.slice(0, 16), 
      error: (error as Error).message 
    });
    return null;
  }
}
