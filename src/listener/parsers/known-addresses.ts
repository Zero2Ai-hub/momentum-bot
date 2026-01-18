/**
 * Known Solana addresses that should NOT be treated as tokens.
 * These are program IDs, system accounts, and other non-token addresses.
 */

export const KNOWN_PROGRAM_IDS = new Set([
  // System Programs
  '11111111111111111111111111111111',                     // System Program
  'ComputeBudget111111111111111111111111111111',          // Compute Budget Program
  'BPFLoader1111111111111111111111111111111111',          // BPF Loader
  'BPFLoader2111111111111111111111111111111111',          // BPF Loader 2
  'BPFLoaderUpgradeab1e11111111111111111111111',          // BPF Upgradeable Loader
  
  // Token Programs
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',         // Token Program
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',         // Token-2022 Program
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',        // Associated Token Program
  
  // DEX Programs (these are programs, not tokens)
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',        // Raydium V4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',        // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',        // Raydium CP-Swap (CPMM)
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',         // Orca Whirlpool
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',         // Meteora
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',        // Orca Token Swap V2
  'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1',        // Orca Token Swap V1
  'pswapRwCM9XkqRitvwZwYnBMu8aHq5W4zT2oM4VaSyg',         // PumpSwap (pump.fun DEX)
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',         // Pump.fun Bonding Curve
  
  // Pump.fun Infrastructure (fee accounts that appear as tokens/wallets)
  'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',         // Pump.fun protocol fee
  'FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9',        // Flash loan protocol
  
  // Other Common Programs
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',         // Memo Program
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',          // Memo Program V1
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',         // Jupiter V6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',         // Jupiter V4
  'JUP3c2Uh3WA4Ng34tw6kPd2G4C5BB21Xo36Je1s32Ph',         // Jupiter V3
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',         // Serum DEX V3
  '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',        // Serum DEX V2
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',         // Phoenix
  'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb',         // OpenBook
  
  // Staking & Governance
  'Stake11111111111111111111111111111111111111',          // Stake Program
  'Vote111111111111111111111111111111111111111',           // Vote Program
  'Config1111111111111111111111111111111111111',          // Config Program
  
  // SPL Programs
  'namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX',         // Name Service
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',         // Metaplex Token Metadata
  'p1exdMJcjVao65QdewkaZRUnU6VPSXhus9n2GzWfh98',         // Metaplex
  'cndy3Z4yapfJBmL3ShUp5exZKqR3z33thTzeNMm2gRZ',         // Candy Machine V2
  'CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR',        // Candy Machine V3
  
  // Marinade
  'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD',         // Marinade Finance
  
  // Lending
  'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo',         // Solend
  'Port7uDYB3wk6GJAw4KT1WpTeMtSu9bTcChBHkX2LfR',         // Port Finance
  
  // Raydium Additional
  'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS',         // Raydium Route
  '5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h',        // Raydium Authority
  
  // SOL Mint (wrapped SOL)
  'So11111111111111111111111111111111111111112',          // Wrapped SOL
  
  // USDC & USDT (we want to see tokens traded FOR these, not these themselves)
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',        // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',        // USDT
  
  // DEX Infrastructure Wallets (appear as "wallet" in fake swaps)
  // These are pool authorities, fee accounts, vaults that parsers wrongly extract
  'proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u',         // Orca Whirlpool infrastructure
]);

/**
 * Check if an address is a known program (not a token)
 */
export function isKnownProgram(address: string): boolean {
  return KNOWN_PROGRAM_IDS.has(address);
}

/**
 * Check if an address looks like a system/infrastructure address
 * These have patterns like repeated characters or known prefixes
 */
export function isSystemAddress(address: string): boolean {
  // Known program in our list
  if (KNOWN_PROGRAM_IDS.has(address)) {
    return true;
  }
  
  // System program pattern (all 1s)
  if (/^1{20,}$/.test(address)) {
    return true;
  }
  
  // Addresses ending in many 1s (common for system addresses)
  if (/1{8,}$/.test(address)) {
    return true;
  }
  
  // Addresses with "111111" anywhere (system program derivatives)
  if (address.includes('111111')) {
    return true;
  }
  
  return false;
}

/**
 * Check if an address looks like binary garbage decoded as base58
 */
function isBinaryGarbage(address: string): boolean {
  // 1. Check for runs of 'A' (represents zero bytes)
  if (/AAA/.test(address)) {
    return true;
  }
  
  // 2. Check for runs of '1' (represents zero bytes)
  if (/1111/.test(address)) {
    return true;
  }
  
  // 3. Must have reasonable character diversity (real addresses are ~random)
  const uniqueChars = new Set(address).size;
  if (uniqueChars < 15) {
    return true;
  }
  
  // 4. Must not have more than 25% of any single character
  const charCounts = new Map<string, number>();
  for (const char of address) {
    charCounts.set(char, (charCounts.get(char) || 0) + 1);
  }
  const maxCount = Math.max(...charCounts.values());
  if (maxCount / address.length > 0.25) {
    return true;
  }
  
  // 5. Invalid base58 characters (0, O, I, l)
  if (/[0OIl]/.test(address)) {
    return true;
  }
  
  // 6. Binary garbage patterns - lowercase followed by many uppercase
  if (/[a-z]{3}[A-Z]{5,}/.test(address) || /[A-Z]{5,}[a-z]{3,}[A-Z]{5,}/.test(address)) {
    return true;
  }
  
  return false;
}

// Prefixes that indicate pool/AMM/protocol addresses, NOT tokens
// These are CASE-SENSITIVE matched first, then lowercase matched
const NON_TOKEN_PREFIXES = [
  // AMM/Pool prefixes
  'pAMM',    // AMM pool addresses
  'pool',    // Pool addresses
  'vault',   // Vault addresses
  'swap',    // Swap program accounts
  'Swap',
  
  // DEX-specific
  'orca',    // Orca pool accounts
  'whirl',   // Whirlpool accounts
  'clmm',    // CLMM pool accounts
  'raydium', // Raydium accounts
  'meteora', // Meteora accounts
  'pump',    // Pump.fun infrastructure
  'Pump',
  'pswap',   // PumpSwap
  
  // Infrastructure prefixes that appear in logs
  'SoL',     // SOL-related addresses (note: case-sensitive)
  'Sol',     // SOL variants
  'SOL',     // SOL all caps
  'mine',    // Mining/miner addresses
  'Mine',
  'MINE',
  
  // Protocol prefixes (these look like tokens but are protocol accounts)
  'ALPHA',   // ALPHA protocol accounts
  'TITAN',   // TITAN protocol
  'T1TAN',   // TITAN variant
  'BETA',    // BETA protocol
  'GAMA',    // GAMA protocol
  'DELTA',   // DELTA protocol
  'ZERO',    // ZERO protocol
  'ZER0',    // ZERO variant
  
  // Validator/staking prefixes
  'stake',   // Staking accounts
  'Stake',
  'valid',   // Validator accounts
  'Valid',
  
  // Fee/authority prefixes
  'fee',     // Fee accounts
  'Fee',
  'auth',    // Authority accounts
  'Auth',
  'pro',     // Protocol accounts (like proVF4p...)
  'Pro',
  
  // Other infrastructure
  'cfg',     // Config accounts
  'Cfg',
  'sys',     // System accounts
  'Sys',
  'SYS',
  'pda',     // PDA accounts
  'PDA',
];

// Known non-token addresses that bypass prefix check
// These are specific addresses that appear frequently as false positives
const KNOWN_NON_TOKENS = new Set([
  // Known pool/infrastructure addresses from logs
  'DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH',  // Appears frequently
  'SV2EYYJyRz2YhfXwXnhNAevDEui5Q6yrfyo13WtupPF',   // PumpSwap pool authority
  'FE7fSucz1kaEY6maPhx3xLnqfniRiAVoZmgkfAUhGNF5',  // Infrastructure
  'FJZ1Hc6LkqfpaoRttNqyBAV5YkMcbAXeffHcg2UFbsNz',  // Infrastructure
  'HomwFqVpHxManrjiV6gGty6Dz5gu1TUFnazJv3F1iWjk', // Infrastructure
  'ALPHAQmeA7bjrVuccPsYPiCvsi428SNwte66Srvs4pHA', // ALPHA protocol
]);

/**
 * Check if an address looks like a valid token mint
 * (not a known program and has valid format)
 */
export function isValidTokenMint(address: string): boolean {
  // Solana addresses are 32 bytes = exactly 43-44 characters in base58
  // Anything shorter is garbage from parsers
  if (address.length < 43 || address.length > 44) {
    return false;
  }
  
  // Must not be "unknown"
  if (address === 'unknown') {
    return false;
  }
  
  // Check against known non-token addresses
  if (KNOWN_NON_TOKENS.has(address)) {
    return false;
  }
  
  // Must not be a system/infrastructure address
  if (isSystemAddress(address)) {
    return false;
  }
  
  // Must not be binary garbage
  if (isBinaryGarbage(address)) {
    return false;
  }
  
  // Must not start with known non-token prefixes (pools, vaults, etc.)
  // First check case-sensitive prefixes
  for (const prefix of NON_TOKEN_PREFIXES) {
    if (address.startsWith(prefix)) {
      return false;
    }
  }
  
  // Also check lowercase version for safety
  const lowerAddr = address.toLowerCase();
  for (const prefix of NON_TOKEN_PREFIXES) {
    if (lowerAddr.startsWith(prefix.toLowerCase())) {
      return false;
    }
  }
  
  return true;
}

/**
 * Check if a wallet address is valid for a real user trade
 */
export function isValidWalletAddress(address: string): boolean {
  // Solana addresses are 32 bytes = exactly 43-44 characters in base58
  if (address.length < 43 || address.length > 44) {
    return false;
  }
  
  // Must not be "unknown"
  if (address === 'unknown') {
    return false;
  }
  
  // Must not be a system/program address
  if (isSystemAddress(address)) {
    return false;
  }
  
  // Must not be binary garbage
  if (isBinaryGarbage(address)) {
    return false;
  }
  
  return true;
}

/**
 * Validate a complete swap event
 * Returns { valid: boolean, reason?: string }
 */
export function validateSwapEvent(
  tokenMint: string, 
  walletAddress: string,
  notionalSol?: number
): { valid: boolean; reason?: string } {
  // Rule 1: Token mint must be valid
  if (!isValidTokenMint(tokenMint)) {
    return { valid: false, reason: 'invalid_token_mint' };
  }
  
  // Rule 2: Wallet must be valid (not a system program)
  if (!isValidWalletAddress(walletAddress)) {
    return { valid: false, reason: 'invalid_wallet' };
  }
  
  // Rule 3: CRITICAL - If wallet == tokenMint, it's a parser bug
  // Real swaps have different addresses for wallet and token
  if (walletAddress === tokenMint) {
    return { valid: false, reason: 'wallet_equals_token' };
  }
  
  // Rule 4: If wallet is a known program, it's infrastructure, not a real trade
  if (isKnownProgram(walletAddress)) {
    return { valid: false, reason: 'wallet_is_program' };
  }
  
  // Rule 5: Sanity check on notional value
  // A single swap > 1000 SOL is almost certainly fake/parsed wrong
  // Real memecoin trades are typically 0.01 - 10 SOL
  if (notionalSol !== undefined && notionalSol > 1000) {
    return { valid: false, reason: 'notional_too_large' };
  }
  
  return { valid: true };
}
