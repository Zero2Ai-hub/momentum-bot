/**
 * Transaction Validation Script
 * 
 * Usage: npm run validate:tx <signature>
 * 
 * Validates that the parser correctly extracts:
 * - Signer address
 * - Token mint (based on signer's net delta)
 * - Direction (BUY/SELL)
 * - Notional SOL
 * - Whether the mint passes RPC verification
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { config } from 'dotenv';
import Decimal from 'decimal.js';

config(); // Load .env

const RPC_URL = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || process.env.RPC_URL || '';

// Token Program IDs
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// wSOL and stables to exclude
const BASE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

interface ValidationResult {
  signature: string;
  signer: string | null;
  signerIndex: number;
  selectedMint: string | null;
  tokenDelta: number;
  direction: 'BUY' | 'SELL' | null;
  notionalSol: number;
  mintValidationPassed: boolean | null;
  candidateMints: { mint: string; delta: number }[];
  error?: string;
}

async function verifyMint(connection: Connection, mint: string): Promise<boolean> {
  try {
    const pubkey = new PublicKey(mint);
    const accountInfo = await connection.getAccountInfo(pubkey);
    
    if (!accountInfo) return false;
    
    const owner = accountInfo.owner.toBase58();
    const dataLen = accountInfo.data.length;
    
    // Standard SPL Token mint: exactly 82 bytes
    if (owner === TOKEN_PROGRAM_ID && dataLen === 82) {
      return true;
    }
    
    // Token-2022 mint: 82+ bytes (has extensions), not 165 (ATA)
    if (owner === TOKEN_2022_PROGRAM_ID && dataLen >= 82 && dataLen !== 165) {
      return true;
    }
    
    return false;
  } catch {
    return false;
  }
}

async function validateTransaction(connection: Connection, signature: string): Promise<ValidationResult> {
  const result: ValidationResult = {
    signature,
    signer: null,
    signerIndex: -1,
    selectedMint: null,
    tokenDelta: 0,
    direction: null,
    notionalSol: 0,
    mintValidationPassed: null,
    candidateMints: [],
  };
  
  try {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
    
    if (!tx || !tx.meta || tx.meta.err) {
      result.error = tx?.meta?.err ? `TX failed: ${JSON.stringify(tx.meta.err)}` : 'TX not found';
      return result;
    }
    
    const accountKeys = tx.transaction.message.accountKeys;
    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];
    const preSOL = tx.meta.preBalances;
    const postSOL = tx.meta.postBalances;
    const fee = tx.meta.fee || 0;
    
    // Find signer
    for (let i = 0; i < accountKeys.length; i++) {
      const key = accountKeys[i];
      if ('pubkey' in key && key.signer) {
        result.signer = key.pubkey.toBase58();
        result.signerIndex = i;
        break;
      }
    }
    
    if (!result.signer) {
      result.error = 'No signer found';
      return result;
    }
    
    // Build per-mint deltas for signer
    const mintDeltas = new Map<string, number>();
    
    const preBalanceMap = new Map<number, { mint: string; amount: number }>();
    for (const bal of preBalances) {
      if (bal.owner === result.signer) {
        preBalanceMap.set(bal.accountIndex, {
          mint: bal.mint,
          amount: parseFloat(bal.uiTokenAmount.uiAmountString || '0'),
        });
      }
    }
    
    const postBalanceMap = new Map<number, { mint: string; amount: number }>();
    for (const bal of postBalances) {
      if (bal.owner === result.signer) {
        postBalanceMap.set(bal.accountIndex, {
          mint: bal.mint,
          amount: parseFloat(bal.uiTokenAmount.uiAmountString || '0'),
        });
      }
    }
    
    const accountIndices = new Set([...preBalanceMap.keys(), ...postBalanceMap.keys()]);
    
    for (const idx of accountIndices) {
      const pre = preBalanceMap.get(idx);
      const post = postBalanceMap.get(idx);
      const mint = pre?.mint || post?.mint;
      
      if (!mint || BASE_MINTS.has(mint)) continue;
      
      const preAmount = pre?.amount || 0;
      const postAmount = post?.amount || 0;
      const delta = postAmount - preAmount;
      
      if (mintDeltas.has(mint)) {
        mintDeltas.set(mint, mintDeltas.get(mint)! + delta);
      } else {
        mintDeltas.set(mint, delta);
      }
    }
    
    // Build candidate list
    for (const [mint, delta] of mintDeltas) {
      result.candidateMints.push({ mint, delta });
    }
    
    // Select mint with largest absolute delta
    let selectedMint: string | null = null;
    let selectedDelta = 0;
    
    for (const [mint, delta] of mintDeltas) {
      if (Math.abs(delta) > Math.abs(selectedDelta)) {
        selectedMint = mint;
        selectedDelta = delta;
      }
    }
    
    result.selectedMint = selectedMint;
    result.tokenDelta = selectedDelta;
    
    if (selectedMint && selectedDelta !== 0) {
      result.direction = selectedDelta > 0 ? 'BUY' : 'SELL';
      
      // Compute SOL notional
      if (preSOL && postSOL && result.signerIndex < preSOL.length) {
        const preSolLamports = preSOL[result.signerIndex];
        const postSolLamports = postSOL[result.signerIndex];
        
        if (result.direction === 'BUY') {
          const solSpent = (preSolLamports - postSolLamports - fee) / 1e9;
          result.notionalSol = Math.max(0, solSpent);
        } else {
          const solReceived = (postSolLamports - preSolLamports) / 1e9;
          result.notionalSol = Math.max(0, solReceived);
        }
      }
      
      // Verify mint
      result.mintValidationPassed = await verifyMint(connection, selectedMint);
    }
    
    return result;
    
  } catch (error) {
    result.error = (error as Error).message;
    return result;
  }
}

async function main() {
  const signatures = process.argv.slice(2);
  
  if (signatures.length === 0) {
    console.log('Usage: npm run validate:tx <signature1> [signature2] ...');
    console.log('');
    console.log('Example: npm run validate:tx 5K8pQtW...xyz');
    process.exit(1);
  }
  
  if (!RPC_URL) {
    console.error('ERROR: RPC_URL or HELIUS_RPC_URL not set in environment');
    process.exit(1);
  }
  
  console.log(`Connecting to RPC: ${RPC_URL.slice(0, 50)}...`);
  const connection = new Connection(RPC_URL, 'confirmed');
  
  console.log('');
  console.log('=' .repeat(80));
  
  for (const sig of signatures) {
    console.log(`\n📋 VALIDATING: ${sig}`);
    console.log('-'.repeat(80));
    
    const result = await validateTransaction(connection, sig);
    
    if (result.error) {
      console.log(`❌ ERROR: ${result.error}`);
      continue;
    }
    
    console.log(`👤 Signer:           ${result.signer}`);
    console.log(`   (index ${result.signerIndex})`);
    console.log('');
    console.log(`📊 Candidate Mints (signer-owned deltas):`);
    
    if (result.candidateMints.length === 0) {
      console.log('   (none found - no signer-owned token changes)');
    } else {
      for (const { mint, delta } of result.candidateMints) {
        const marker = mint === result.selectedMint ? ' ← SELECTED' : '';
        console.log(`   ${mint.slice(0, 20)}... delta=${delta.toFixed(6)}${marker}`);
      }
    }
    
    console.log('');
    console.log(`🎯 Selected Mint:    ${result.selectedMint || '(none)'}`);
    console.log(`📈 Token Delta:      ${result.tokenDelta.toFixed(6)}`);
    console.log(`↔️  Direction:        ${result.direction || '(unknown)'}`);
    console.log(`💰 Notional SOL:     ${result.notionalSol.toFixed(6)}`);
    console.log(`✅ Mint Verified:    ${result.mintValidationPassed === null ? '(skipped)' : result.mintValidationPassed ? 'YES' : 'NO'}`);
    
    console.log('');
    
    // Summary
    if (result.mintValidationPassed === false) {
      console.log('⚠️  WARNING: Selected mint failed RPC verification (not a real SPL token mint)');
    } else if (result.mintValidationPassed === true && result.selectedMint) {
      console.log('✅ PASS: Valid swap event detected');
    } else {
      console.log('⚪ No valid swap detected in this transaction');
    }
    
    console.log('=' .repeat(80));
  }
}

main().catch(console.error);
