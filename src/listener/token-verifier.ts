/**
 * Token Verification Service
 * Verifies that addresses are real SPL token mints using Solana RPC.
 * 
 * FIX: Added fast blocklist for known program IDs and system accounts.
 * Now blocks emission until verification completes.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getConfig } from '../config/config';
import { log } from '../logging/logger';

// Cache for verified tokens (true = valid token mint, false = not a token)
const tokenCache = new Map<string, boolean>();

// Cache for pending verifications (to avoid duplicate RPC calls)
const pendingVerifications = new Map<string, Promise<boolean>>();

// RPC connection for token verification
let connection: Connection | null = null;

// Rate limiting for RPC calls
let lastRpcCall = 0;
const MIN_RPC_INTERVAL_MS = 50; // Max 20 calls/second

// Token Program IDs
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// FAST BLOCKLIST: Known program IDs and system accounts that are NEVER token mints
const BLOCKLIST = new Set([
  // System programs
  '11111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  
  // Token programs (these are PROGRAMS, not mints)
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Program
  
  // Memo program
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  
  // DEX programs
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium V4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // Pump.fun
  'pswapRwCM9XkqRitvwZwYnBMu8aHq5W4zT2oM4VaSyg', // PumpSwap
  
  // Serum/OpenBook
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',
  '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
  
  // Jupiter
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
  
  // wSOL (base currency, not a "traded token")
  'So11111111111111111111111111111111111111112',
]);

/**
 * Initialize the token verifier
 */
export async function initializeTokenVerifier(): Promise<void> {
  const config = getConfig();
  connection = new Connection(config.rpcUrl, 'confirmed');
  log.info('Token verifier initialized (RPC-based with blocklist)');
}

/**
 * Fast check against blocklist - returns true if address should be rejected
 */
function isBlocklisted(address: string): boolean {
  return BLOCKLIST.has(address);
}

/**
 * Validate base58 address format
 */
function isValidBase58Address(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if an address is a valid SPL token mint using RPC
 * Returns true ONLY if the address is a valid token mint account (82 bytes, owned by Token Program)
 */
async function verifyTokenViaRpc(tokenMint: string): Promise<boolean> {
  // Fast blocklist check
  if (isBlocklisted(tokenMint)) {
    log.debug('Blocklisted address rejected', { token: tokenMint.slice(0, 16) });
    return false;
  }
  
  // Validate base58
  if (!isValidBase58Address(tokenMint)) {
    return false;
  }
  
  if (!connection) {
    return false; // Can't verify without connection
  }
  
  try {
    // Rate limiting
    const now = Date.now();
    if (now - lastRpcCall < MIN_RPC_INTERVAL_MS) {
      await new Promise(resolve => setTimeout(resolve, MIN_RPC_INTERVAL_MS));
    }
    lastRpcCall = Date.now();
    
    const pubkey = new PublicKey(tokenMint);
    
    // Get account info with timeout
    const accountInfo = await Promise.race([
      connection.getAccountInfo(pubkey),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]) as Awaited<ReturnType<typeof connection.getAccountInfo>>;
    
    if (!accountInfo) {
      // Account doesn't exist - not a valid token
      return false;
    }
    
    // Check if it's owned by the Token Program (SPL Token or Token-2022)
    const owner = accountInfo.owner.toBase58();
    const isTokenProgram = owner === TOKEN_PROGRAM_ID || owner === TOKEN_2022_PROGRAM_ID;
    
    if (!isTokenProgram) {
      // Not owned by token program - not a token mint
      return false;
    }
    
    // Token mint accounts:
    // - SPL Token (legacy): exactly 82 bytes
    // - Token-2022: 82 bytes base + extensions (can be much larger)
    // Token accounts (ATAs):
    // - SPL Token: 165 bytes
    // - Token-2022: 165 bytes base + extensions
    
    const dataLen = accountInfo.data.length;
    
    // Standard SPL Token mint
    if (owner === TOKEN_PROGRAM_ID && dataLen === 82) {
      return true;
    }
    
    // Token-2022 mint: 82+ bytes (has extensions)
    // Token-2022 ATAs are 165+ bytes, so mints are >= 82 and != 165
    if (owner === TOKEN_2022_PROGRAM_ID && dataLen >= 82 && dataLen !== 165) {
      return true;
    }
    
    // 165 bytes = token account (ATA), not a mint
    return false;
    
  } catch (error) {
    // Invalid address or RPC error
    log.debug('Token verification failed', { 
      token: tokenMint.slice(0, 16), 
      error: (error as Error).message 
    });
    return false;
  }
}

/**
 * Check if an address is a valid tradeable token (ASYNC - blocks until verified)
 * This is the main entry point - it will wait for RPC verification.
 */
export async function isValidTradeableToken(tokenMint: string): Promise<boolean> {
  // Fast blocklist rejection
  if (isBlocklisted(tokenMint)) {
    tokenCache.set(tokenMint, false);
    return false;
  }
  
  // Check cache first
  if (tokenCache.has(tokenMint)) {
    return tokenCache.get(tokenMint)!;
  }
  
  // Check if verification is already in progress - await it
  if (pendingVerifications.has(tokenMint)) {
    return pendingVerifications.get(tokenMint)!;
  }
  
  // Verify via RPC (blocks until complete)
  const verificationPromise = verifyTokenViaRpc(tokenMint).then(isValid => {
    tokenCache.set(tokenMint, isValid);
    pendingVerifications.delete(tokenMint);
    
    if (!isValid) {
      log.debug('Filtered non-token address', { token: tokenMint.slice(0, 16) });
    }
    
    return isValid;
  }).catch(() => {
    pendingVerifications.delete(tokenMint);
    tokenCache.set(tokenMint, false); // On error, reject
    return false;
  });
  
  pendingVerifications.set(tokenMint, verificationPromise);
  return verificationPromise;
}

/**
 * Synchronous check - only uses cache and blocklist, doesn't make RPC calls
 * Returns: true (verified token), false (verified NOT a token), undefined (unknown)
 */
export function isVerifiedToken(tokenMint: string): boolean | undefined {
  // Fast blocklist check
  if (isBlocklisted(tokenMint)) {
    return false;
  }
  
  if (tokenCache.has(tokenMint)) {
    return tokenCache.get(tokenMint);
  }
  return undefined; // Unknown - needs async verification
}

/**
 * Queue a token for background verification (non-blocking)
 */
export function queueTokenVerification(tokenMint: string): void {
  if (tokenCache.has(tokenMint) || isBlocklisted(tokenMint)) {
    return; // Already verified or blocklisted
  }
  
  if (pendingVerifications.has(tokenMint)) {
    return; // Already being verified
  }
  
  // Queue verification in background
  isValidTradeableToken(tokenMint).catch(() => {});
}

/**
 * Get verification statistics
 */
export function getVerifierStats(): {
  cachedTokens: number;
  validTokens: number;
  invalidTokens: number;
  pendingVerifications: number;
} {
  let validCount = 0;
  let invalidCount = 0;
  
  for (const isValid of tokenCache.values()) {
    if (isValid) validCount++;
    else invalidCount++;
  }
  
  return {
    cachedTokens: tokenCache.size,
    validTokens: validCount,
    invalidTokens: invalidCount,
    pendingVerifications: pendingVerifications.size,
  };
}

/**
 * Clear the verification cache (useful for testing)
 */
export function clearVerificationCache(): void {
  tokenCache.clear();
}
