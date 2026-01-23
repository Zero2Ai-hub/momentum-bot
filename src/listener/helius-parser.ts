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

// Rate limiting for getParsedTransaction calls
// Helius Free tier: 10 RPC/sec total - increase to 8/sec for parsing
let lastParseCall = 0;
const MIN_PARSE_INTERVAL_MS = 125; // ~8 calls/second max (was 200ms = 5/sec)
let parseQueue: Promise<any> = Promise.resolve();

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

// Separate rate limiter for lightweight signer extraction (cheaper calls)
let lastSignerCall = 0;
const MIN_SIGNER_INTERVAL_MS = 50; // ~20 calls/second (cheaper than full parse)
let signerQueue: Promise<any> = Promise.resolve();

/**
 * LIGHTWEIGHT: Extract just the signer (fee payer) from a transaction
 * 
 * This is MUCH cheaper than getParsedTransaction because:
 * - Uses getTransaction (not getParsed)
 * - Only extracts accountKeys[0] (fee payer = signer)
 * - No token balance parsing
 * 
 * Per the audit: "decode PumpSwap events + lightweight signer extraction = real data without estimates"
 */
export async function extractSignerFromTransaction(
  connection: Connection,
  signature: string
): Promise<string | null> {
  // Rate-limited RPC call through separate queue
  const signer = await new Promise<string | null>((resolve) => {
    signerQueue = signerQueue.then(async () => {
      const now = Date.now();
      const timeSinceLastCall = now - lastSignerCall;
      if (timeSinceLastCall < MIN_SIGNER_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, MIN_SIGNER_INTERVAL_MS - timeSinceLastCall));
      }
      lastSignerCall = Date.now();
      
      try {
        // Use getTransaction (not getParsedTransaction) - much lighter
        const tx = await connection.getTransaction(signature, {
          maxSupportedTransactionVersion: 0,
        });
        
        if (!tx || !tx.transaction || !tx.transaction.message) {
          resolve(null);
          return;
        }
        
        // Get account keys - fee payer is always first
        const message = tx.transaction.message;
        let signerPubkey: string | null = null;
        
        // Handle both legacy and versioned message formats
        if ('accountKeys' in message && Array.isArray(message.accountKeys)) {
          // Legacy format
          signerPubkey = message.accountKeys[0]?.toString() || null;
        } else if ('staticAccountKeys' in message && Array.isArray(message.staticAccountKeys)) {
          // Versioned format
          signerPubkey = message.staticAccountKeys[0]?.toString() || null;
        }
        
        resolve(signerPubkey);
      } catch (error) {
        if (DEBUG) {
          log.debug(`Signer extraction failed: ${signature.slice(0, 16)}...`);
        }
        resolve(null);
      }
    });
  });
  
  return signer;
}

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
  
  // Rate-limited RPC call through queue
  const tx = await new Promise<any>((resolve) => {
    parseQueue = parseQueue.then(async () => {
      const now = Date.now();
      const timeSinceLastCall = now - lastParseCall;
      if (timeSinceLastCall < MIN_PARSE_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, MIN_PARSE_INTERVAL_MS - timeSinceLastCall));
      }
      lastParseCall = Date.now();
      
      try {
        const result = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
        });
        resolve(result);
      } catch (err) {
        // On 429, wait and retry once
        const errMsg = (err as Error).message || '';
        if (errMsg.includes('429')) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            const result = await connection.getParsedTransaction(signature, {
              maxSupportedTransactionVersion: 0,
            });
            resolve(result);
          } catch {
            resolve(null);
          }
        } else {
          resolve(null);
        }
      }
    });
  });
  
  try {
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
      log.debug(`PARSE_SKIP: No signer found | sig=${signature.slice(0, 16)}`);
      return null; // No signer found
    }
    
    // STEP 2: Build per-mint deltas
    // First try signer-owned accounts, then fall back to ALL accounts
    const mintDeltas = new Map<string, TokenDelta>();
    
    // Build lookup for ALL pre-balances (we'll filter later)
    const preBalanceMap = new Map<number, { mint: string; amount: number; decimals: number; owner: string }>();
    for (const bal of preBalances) {
      preBalanceMap.set(bal.accountIndex, {
        mint: bal.mint,
        amount: parseFloat(bal.uiTokenAmount.uiAmountString || '0'),
        decimals: bal.uiTokenAmount.decimals,
        owner: bal.owner,
      });
    }
    
    // Build lookup for ALL post-balances
    const postBalanceMap = new Map<number, { mint: string; amount: number; decimals: number; owner: string }>();
    for (const bal of postBalances) {
      postBalanceMap.set(bal.accountIndex, {
        mint: bal.mint,
        amount: parseFloat(bal.uiTokenAmount.uiAmountString || '0'),
        decimals: bal.uiTokenAmount.decimals,
        owner: bal.owner,
      });
    }
    
    // FIRST: Try signer-owned balances only
    const signerPreBalances = new Map<number, { mint: string; amount: number; decimals: number; owner: string }>();
    const signerPostBalances = new Map<number, { mint: string; amount: number; decimals: number; owner: string }>();
    for (const [idx, bal] of preBalanceMap) {
      if (bal.owner === signerPubkey) signerPreBalances.set(idx, bal);
    }
    for (const [idx, bal] of postBalanceMap) {
      if (bal.owner === signerPubkey) signerPostBalances.set(idx, bal);
    }
    
    // Try signer-owned balances first
    const signerAccountIndices = new Set([...signerPreBalances.keys(), ...signerPostBalances.keys()]);
    
    for (const idx of signerAccountIndices) {
      const pre = signerPreBalances.get(idx);
      const post = signerPostBalances.get(idx);
      
      const mint = pre?.mint || post?.mint;
      if (!mint) continue;
      if (BASE_MINTS.has(mint)) continue;
      
      const preAmount = pre?.amount || 0;
      const postAmount = post?.amount || 0;
      const decimals = pre?.decimals || post?.decimals || 0;
      const delta = postAmount - preAmount;
      
      if (mintDeltas.has(mint)) {
        const existing = mintDeltas.get(mint)!;
        existing.delta += delta;
      } else {
        mintDeltas.set(mint, { mint, delta, decimals });
      }
    }
    
    // FALLBACK: If no signer deltas found, look at ALL token balance changes
    // This handles cases where tokens flow through pool accounts
    const hasSignerDelta = Array.from(mintDeltas.values()).some(d => Math.abs(d.delta) > 0);
    if (!hasSignerDelta) {
      const allAccountIndices = new Set([...preBalanceMap.keys(), ...postBalanceMap.keys()]);
      
      for (const idx of allAccountIndices) {
        const pre = preBalanceMap.get(idx);
        const post = postBalanceMap.get(idx);
        
        const mint = pre?.mint || post?.mint;
        if (!mint) continue;
        if (BASE_MINTS.has(mint)) continue;
        
        const preAmount = pre?.amount || 0;
        const postAmount = post?.amount || 0;
        const decimals = pre?.decimals || post?.decimals || 0;
        const delta = postAmount - preAmount;
        
        // Only consider non-zero deltas for fallback
        if (Math.abs(delta) > 0.000001) {
          if (mintDeltas.has(mint)) {
            const existing = mintDeltas.get(mint)!;
            existing.delta += delta;
          } else {
            mintDeltas.set(mint, { mint, delta, decimals });
          }
        }
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
    
    // STEP 4-5: Compute direction and SOL notional
    let direction: SwapDirection;
    let notionalSol = new Decimal(0);
    
    // Get SOL change first - we need this for both token-delta and SOL-only methods
    const preSolLamports = (preSOL && signerIndex < preSOL.length) ? preSOL[signerIndex] : 0;
    const postSolLamports = (postSOL && signerIndex < postSOL.length) ? postSOL[signerIndex] : 0;
    const solChangeLamports = postSolLamports - preSolLamports; // positive = received SOL
    
    // If no token delta but we have token accounts in the tx, use SOL delta as proxy
    if (!selectedMint || selectedDelta === 0) {
      // Find any pump.fun token in the balance list (even if delta is 0)
      const pumpMints = Array.from(new Set([...preBalances, ...postBalances]
        .map(b => b.mint)
        .filter(m => m && m.endsWith('pump') && !BASE_MINTS.has(m))
      ));
      
      if (pumpMints.length === 0) {
        // No pump tokens at all - skip
        log.debug(`PARSE_SKIP: No pump token in balance list | sig=${signature.slice(0, 16)} | mints=${preBalances.map((b: any) => b.mint.slice(0, 8)).join(',')}`);
        return null;
      }
      
      // Use the first pump mint found
      selectedMint = pumpMints[0];
      
      // Use SOL change to determine direction
      const solChangeWithoutFee = solChangeLamports + fee; // add back fee for net assessment
      if (Math.abs(solChangeWithoutFee) < 10000) { // < 0.00001 SOL - probably just fee
        log.debug(`PARSE_SKIP: SOL delta too small (${solChangeWithoutFee/1e9}) | sig=${signature.slice(0, 16)} | mint=${selectedMint!.slice(0, 12)}`);
        return null;
      }
      
      // If SOL decreased (negative), signer bought tokens
      // If SOL increased (positive), signer sold tokens
      direction = solChangeWithoutFee < 0 ? SwapDirection.BUY : SwapDirection.SELL;
      notionalSol = new Decimal(Math.abs(solChangeWithoutFee)).div(1e9);
      
      if (DEBUG) {
        log.debug('Using SOL delta fallback', {
          signature: signature.slice(0, 16),
          mint: selectedMint!.slice(0, 16),
          solChange: notionalSol.toString(),
          direction
        });
      }
    } else {
      // Normal case: we have a token delta
      direction = selectedDelta > 0 ? SwapDirection.BUY : SwapDirection.SELL;
      
      if (direction === SwapDirection.BUY) {
        const solSpentLamports = preSolLamports - postSolLamports - fee;
        if (solSpentLamports <= 0) {
          log.debug(`PARSE_SKIP: BUY with non-positive SOL spent (${(solSpentLamports/1e9).toFixed(4)}) | sig=${signature.slice(0, 16)} | tokenDelta=${selectedDelta}`);
          return null;
        }
        notionalSol = new Decimal(solSpentLamports).div(1e9);
      } else {
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
    const programIds: string[] = accountKeys.map((k: any) => {
      if ('pubkey' in k) return k.pubkey.toBase58();
      if (typeof k === 'string') return k;
      return String(k);
    });
    
    if (programIds.some((p: string) => p.includes('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'))) {
      dexSource = DEXSource.RAYDIUM_V4;
    } else if (programIds.some((p: string) => p.includes('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'))) {
      dexSource = DEXSource.RAYDIUM_CLMM;
    } else if (programIds.some((p: string) => p.includes('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'))) {
      dexSource = DEXSource.ORCA_WHIRLPOOL;
    } else if (programIds.some((p: string) => p.includes('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'))) {
      dexSource = DEXSource.METEORA;
    } else if (programIds.some((p: string) => p.includes('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'))) {
      dexSource = DEXSource.PUMPFUN;
    } else if (programIds.some((p: string) => p.includes('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'))) {
      dexSource = DEXSource.PUMPSWAP;
    }
    
    // Final guard - selectedMint must be set by now
    if (!selectedMint) {
      return null;
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
