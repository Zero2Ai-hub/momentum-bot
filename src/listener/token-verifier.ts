/**
 * Token Verification Service
 * Verifies that addresses are real SPL tokens using Solana RPC.
 * This prevents tracking pool addresses, ATAs, and other non-token addresses.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getConfig } from '../config/config';
import { log } from '../logging/logger';

// Cache for verified tokens (true = valid token, false = not a token)
const tokenCache = new Map<string, boolean>();

// Cache for pending verifications (to avoid duplicate RPC calls)
const pendingVerifications = new Map<string, Promise<boolean>>();

// RPC connection for token verification
let connection: Connection | null = null;

// Rate limiting for RPC calls
let lastRpcCall = 0;
const MIN_RPC_INTERVAL_MS = 100; // Max 10 calls/second

/**
 * Initialize the token verifier
 */
export async function initializeTokenVerifier(): Promise<void> {
  const config = getConfig();
  connection = new Connection(config.rpcUrl, 'confirmed');
  log.info('Token verifier initialized (using RPC verification)');
}

/**
 * Check if an address is a valid SPL token mint using RPC
 * Returns true if the address is a valid token mint account
 */
async function verifyTokenViaRpc(tokenMint: string): Promise<boolean> {
  if (!connection) {
    return true; // Can't verify, allow through
  }
  
  try {
    // Rate limiting
    const now = Date.now();
    if (now - lastRpcCall < MIN_RPC_INTERVAL_MS) {
      await new Promise(resolve => setTimeout(resolve, MIN_RPC_INTERVAL_MS));
    }
    lastRpcCall = Date.now();
    
    const pubkey = new PublicKey(tokenMint);
    
    // Get account info
    const accountInfo = await connection.getAccountInfo(pubkey);
    
    if (!accountInfo) {
      // Account doesn't exist - not a valid token
      return false;
    }
    
    // Check if it's owned by the Token Program (SPL Token or Token-2022)
    const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    
    const owner = accountInfo.owner.toBase58();
    const isTokenProgram = owner === TOKEN_PROGRAM_ID || owner === TOKEN_2022_PROGRAM_ID;
    
    if (!isTokenProgram) {
      // Not owned by token program - not a token mint
      return false;
    }
    
    // Token mint accounts are exactly 82 bytes
    // Token accounts (ATAs) are 165 bytes
    // This distinguishes mints from token accounts
    if (accountInfo.data.length === 82) {
      return true; // Valid token mint!
    }
    
    // 165 bytes = token account (ATA), not a mint
    if (accountInfo.data.length === 165) {
      return false;
    }
    
    // Other sizes - unknown, be conservative
    return false;
    
  } catch (error) {
    // Invalid address or RPC error - assume not valid
    log.debug('Token verification failed', { 
      token: tokenMint.slice(0, 16), 
      error: (error as Error).message 
    });
    return false;
  }
}

/**
 * Check if an address is a valid tradeable token
 * Uses cached results when available, otherwise queries RPC
 */
export async function isValidTradeableToken(tokenMint: string): Promise<boolean> {
  // Check cache first
  if (tokenCache.has(tokenMint)) {
    return tokenCache.get(tokenMint)!;
  }
  
  // Check if verification is already in progress
  if (pendingVerifications.has(tokenMint)) {
    return pendingVerifications.get(tokenMint)!;
  }
  
  // Verify via RPC
  const verificationPromise = verifyTokenViaRpc(tokenMint).then(isValid => {
    tokenCache.set(tokenMint, isValid);
    pendingVerifications.delete(tokenMint);
    
    if (!isValid) {
      log.debug('Filtered non-token address via RPC', { token: tokenMint.slice(0, 16) });
    }
    
    return isValid;
  }).catch(() => {
    pendingVerifications.delete(tokenMint);
    return true; // On error, allow through (be permissive)
  });
  
  pendingVerifications.set(tokenMint, verificationPromise);
  return verificationPromise;
}

/**
 * Synchronous check - only uses cache, doesn't make RPC calls
 * Returns: true (verified token), false (verified NOT a token), undefined (unknown)
 */
export function isVerifiedToken(tokenMint: string): boolean | undefined {
  if (tokenCache.has(tokenMint)) {
    return tokenCache.get(tokenMint);
  }
  return undefined; // Unknown - needs async verification
}

/**
 * Queue a token for background verification
 * This doesn't block - just schedules the verification
 */
export function queueTokenVerification(tokenMint: string): void {
  if (tokenCache.has(tokenMint)) {
    return; // Already verified
  }
  
  if (pendingVerifications.has(tokenMint)) {
    return; // Already being verified
  }
  
  // Queue verification in background
  isValidTradeableToken(tokenMint).catch(() => {
    // Silently handle errors
  });
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
