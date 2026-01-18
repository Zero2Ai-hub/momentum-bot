/**
 * Execution Engine
 * Handles transaction building, submission, and confirmation.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionConfirmationStrategy,
  BlockhashWithExpiryBlockHeight,
} from '@solana/web3.js';
import bs58 from 'bs58';
import Decimal from 'decimal.js';
import { 
  ExecutionResult, 
  OrderSide, 
  SwapQuote, 
  SOL_MINT,
  LogEventType 
} from '../types';
import { getConfig } from '../config/config';
import { logEvent, log } from '../logging/logger';
import { JupiterClient } from './jupiter-client';

/**
 * ExecutionEngine manages the full lifecycle of swap transactions:
 * - Quote fetching
 * - Transaction building
 * - Signing
 * - Submission with retry
 * - Confirmation
 */
export class ExecutionEngine {
  private connection: Connection;
  private jupiterClient: JupiterClient;
  private wallet: Keypair | null = null;
  private config = getConfig();
  
  private maxRetries = 3;
  private retryDelayMs = 1000;
  
  constructor(connection: Connection) {
    this.connection = connection;
    this.jupiterClient = new JupiterClient(connection);
  }
  
  /**
   * Initialize wallet from private key
   */
  initializeWallet(): boolean {
    const privateKey = this.config.walletPrivateKey;
    
    if (!privateKey) {
      log.warn('No wallet private key configured - execution disabled');
      return false;
    }
    
    try {
      const decoded = bs58.decode(privateKey);
      this.wallet = Keypair.fromSecretKey(decoded);
      log.info(`Wallet initialized: ${this.wallet.publicKey.toBase58().slice(0, 8)}...`);
      return true;
    } catch (error) {
      log.error('Failed to initialize wallet', error as Error);
      return false;
    }
  }
  
  /**
   * Get Jupiter client (for risk gates)
   */
  getJupiterClient(): JupiterClient {
    return this.jupiterClient;
  }
  
  /**
   * Get wallet public key
   */
  getWalletPublicKey(): PublicKey | null {
    return this.wallet?.publicKey || null;
  }
  
  /**
   * Execute a buy order (SOL -> Token)
   */
  async executeBuy(
    tokenMint: string,
    solAmount: Decimal
  ): Promise<ExecutionResult> {
    return this.executeSwap(OrderSide.BUY, tokenMint, solAmount);
  }
  
  /**
   * Execute a sell order (Token -> SOL)
   */
  async executeSell(
    tokenMint: string,
    tokenAmount: Decimal
  ): Promise<ExecutionResult> {
    return this.executeSwap(OrderSide.SELL, tokenMint, tokenAmount);
  }
  
/**
 * Execute a swap with full retry and confirmation logic
 */
  private async executeSwap(
    side: OrderSide,
    tokenMint: string,
    amount: Decimal
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    
    // Paper trading mode - simulate without real execution
    if (this.config.paperTrading) {
      return this.simulatePaperTrade(side, tokenMint, amount, startTime);
    }
    
    if (!this.wallet) {
      return {
        success: false,
        inputAmount: amount,
        error: 'Wallet not initialized',
        retryCount: 0,
        executionTimeMs: Date.now() - startTime,
      };
    }
    
    logEvent(LogEventType.ORDER_SUBMITTED, {
      side,
      tokenMint,
      amount: amount.toString(),
      wallet: this.wallet.publicKey.toBase58(),
      paperTrading: false,
    });
    
    let lastError: string | null = null;
    let retryCount = 0;
    
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      retryCount = attempt;
      
      try {
        // Step 1: Get fresh quote
        const quote = side === OrderSide.BUY
          ? await this.jupiterClient.getBuyQuote(tokenMint, amount)
          : await this.jupiterClient.getSellQuote(tokenMint, amount);
        
        if (!quote) {
          lastError = 'Failed to get quote';
          continue;
        }
        
        // Step 2: Check if quote is still valid
        if (Date.now() > quote.expiresAt) {
          lastError = 'Quote expired';
          continue;
        }
        
        // Step 3: Build transaction
        const transaction = await this.jupiterClient.buildSwapTransaction(
          quote,
          this.wallet.publicKey,
          this.config.priorityFeeLamports
        );
        
        if (!transaction) {
          lastError = 'Failed to build transaction';
          continue;
        }
        
        // Step 4: Get fresh blockhash and sign
        const blockhash = await this.connection.getLatestBlockhash('confirmed');
        transaction.message.recentBlockhash = blockhash.blockhash;
        transaction.sign([this.wallet]);
        
        // Step 5: Submit transaction
        const signature = await this.submitTransaction(transaction, blockhash);
        
        if (!signature) {
          lastError = 'Transaction submission failed';
          continue;
        }
        
        // Step 6: Confirm transaction
        const confirmation = await this.confirmTransaction(signature, blockhash);
        
        if (!confirmation.confirmed) {
          lastError = confirmation.error || 'Transaction not confirmed';
          continue;
        }
        
        // Success!
        const executionTimeMs = Date.now() - startTime;
        
        // Calculate actual slippage
        const expectedOut = quote.expectedOutputAmount;
        const actualOut = expectedOut; // Would need to parse tx for actual
        const slippageBps = expectedOut.gt(0)
          ? expectedOut.minus(actualOut).div(expectedOut).mul(10000).toNumber()
          : 0;
        
        logEvent(LogEventType.ORDER_CONFIRMED, {
          signature,
          side,
          tokenMint,
          inputAmount: quote.inputAmount.toString(),
          outputAmount: actualOut.toString(),
          slippageBps,
          executionTimeMs,
        });
        
        log.trade(`${side} confirmed`, {
          token: tokenMint.slice(0, 8),
          signature: signature.slice(0, 16),
          executionTimeMs,
        });
        
        return {
          success: true,
          signature,
          confirmedSlot: confirmation.slot,
          inputAmount: quote.inputAmount,
          actualOutputAmount: actualOut,
          expectedOutputAmount: quote.expectedOutputAmount,
          slippageBps,
          retryCount,
          executionTimeMs,
        };
        
      } catch (error) {
        lastError = (error as Error).message;
        log.warn(`Swap attempt ${attempt + 1} failed: ${lastError}`);
        
        if (attempt < this.maxRetries - 1) {
          await this.sleep(this.retryDelayMs * Math.pow(2, attempt));
        }
      }
    }
    
    // All retries failed
    const executionTimeMs = Date.now() - startTime;
    
    logEvent(LogEventType.ORDER_FAILED, {
      side,
      tokenMint,
      amount: amount.toString(),
      error: lastError,
      retryCount,
    });
    
    return {
      success: false,
      inputAmount: amount,
      error: lastError || 'Unknown error',
      retryCount,
      executionTimeMs,
    };
  }
  
  /**
   * Submit transaction with retry logic
   */
  private async submitTransaction(
    transaction: VersionedTransaction,
    blockhash: BlockhashWithExpiryBlockHeight
  ): Promise<string | null> {
    const serialized = transaction.serialize();
    
    try {
      // Use sendRawTransaction for better control
      const signature = await this.connection.sendRawTransaction(serialized, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 2,
      });
      
      log.debug(`Transaction submitted: ${signature.slice(0, 16)}...`);
      return signature;
      
    } catch (error) {
      log.error('Transaction submission error', error as Error);
      return null;
    }
  }
  
  /**
   * Confirm transaction with timeout
   */
  private async confirmTransaction(
    signature: string,
    blockhash: BlockhashWithExpiryBlockHeight
  ): Promise<{ confirmed: boolean; slot?: number; error?: string }> {
    const timeoutMs = 30_000; // 30 second timeout
    const startTime = Date.now();
    
    try {
      const strategy: TransactionConfirmationStrategy = {
        signature,
        blockhash: blockhash.blockhash,
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
      };
      
      const result = await this.connection.confirmTransaction(strategy, 'confirmed');
      
      if (result.value.err) {
        return {
          confirmed: false,
          error: `Transaction error: ${JSON.stringify(result.value.err)}`,
        };
      }
      
      return {
        confirmed: true,
        slot: result.context.slot,
      };
      
    } catch (error) {
      // Check if transaction actually landed
      const elapsed = Date.now() - startTime;
      
      if (elapsed >= timeoutMs) {
        // Timeout - check if tx exists
        try {
          const status = await this.connection.getSignatureStatus(signature);
          if (status.value?.confirmationStatus === 'confirmed' ||
              status.value?.confirmationStatus === 'finalized') {
            return { confirmed: true, slot: status.context.slot };
          }
        } catch {
          // Ignore
        }
      }
      
      return {
        confirmed: false,
        error: (error as Error).message,
      };
    }
  }
  
  /**
   * Get SOL balance
   */
  async getSolBalance(): Promise<Decimal> {
    if (!this.wallet) return new Decimal(0);
    
    try {
      const balance = await this.connection.getBalance(this.wallet.publicKey);
      return new Decimal(balance).div(1e9);
    } catch (error) {
      log.error('Failed to get SOL balance', error as Error);
      return new Decimal(0);
    }
  }
  
  /**
   * Get token balance
   */
  async getTokenBalance(tokenMint: string): Promise<Decimal> {
    if (!this.wallet) return new Decimal(0);
    
    try {
      const mintPubkey = new PublicKey(tokenMint);
      const accounts = await this.connection.getTokenAccountsByOwner(
        this.wallet.publicKey,
        { mint: mintPubkey }
      );
      
      if (accounts.value.length === 0) {
        return new Decimal(0);
      }
      
      // Sum all token accounts (usually just one)
      let total = new Decimal(0);
      for (const account of accounts.value) {
        const data = account.account.data;
        // Token account data: first 32 bytes mint, next 32 bytes owner, 
        // next 8 bytes amount (u64 little endian)
        const amount = data.readBigUInt64LE(64);
        total = total.plus(amount.toString());
      }
      
      return total;
      
    } catch (error) {
      log.error('Failed to get token balance', error as Error);
      return new Decimal(0);
    }
  }
  
  /**
   * Check if we have enough balance for a trade
   */
  async canAffordTrade(solAmount: Decimal): Promise<boolean> {
    const balance = await this.getSolBalance();
    // Keep buffer for fees
    const minBalance = solAmount.plus(0.01); // 0.01 SOL buffer
    return balance.gte(minBalance);
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Simulate a trade in paper trading mode.
   * Logs what WOULD have been executed without sending transactions.
   */
  private async simulatePaperTrade(
    side: OrderSide,
    tokenMint: string,
    amount: Decimal,
    startTime: number
  ): Promise<ExecutionResult> {
    log.info('═══════════════════════════════════════════════════════════════');
    log.info('              🧾 PAPER TRADE (Simulation Only)');
    log.info('═══════════════════════════════════════════════════════════════');
    
    // Get a real quote to show what would have happened
    try {
      const quote = side === OrderSide.BUY
        ? await this.jupiterClient.getBuyQuote(tokenMint, amount)
        : await this.jupiterClient.getSellQuote(tokenMint, amount);
      
      if (!quote) {
        log.warn('[PAPER] No route available for swap');
        return {
          success: false,
          inputAmount: amount,
          error: '[PAPER] No route available',
          retryCount: 0,
          executionTimeMs: Date.now() - startTime,
        };
      }
      
      // Log detailed simulation info
      log.info(`[PAPER] Side:            ${side}`);
      log.info(`[PAPER] Token:           ${tokenMint}`);
      log.info(`[PAPER] Input:           ${quote.inputAmount.div(1e9).toFixed(6)} SOL`);
      log.info(`[PAPER] Expected Output: ${quote.expectedOutputAmount.toString()} tokens`);
      log.info(`[PAPER] Min Output:      ${quote.minimumOutputAmount.toString()} tokens`);
      log.info(`[PAPER] Price Impact:    ${quote.priceImpactBps} bps (${(quote.priceImpactBps / 100).toFixed(2)}%)`);
      log.info(`[PAPER] Slippage:        ${this.config.maxSlippageBps} bps`);
      log.info(`[PAPER] Route:           ${this.summarizeRoute(quote.route)}`);
      log.info('───────────────────────────────────────────────────────────────');
      log.info('[PAPER] Transaction would be submitted to network');
      log.info('[PAPER] ⚠️  NO REAL TRANSACTION SENT - Paper trading mode');
      log.info('═══════════════════════════════════════════════════════════════');
      
      // Simulate successful execution
      const simulatedSlippage = Math.floor(Math.random() * 50); // Random 0-50 bps
      const simulatedOutput = quote.expectedOutputAmount.mul(1 - simulatedSlippage / 10000);
      
      logEvent(LogEventType.ORDER_CONFIRMED, {
        paperTrading: true,
        side,
        tokenMint,
        inputAmount: quote.inputAmount.toString(),
        outputAmount: simulatedOutput.toString(),
        slippageBps: simulatedSlippage,
        priceImpactBps: quote.priceImpactBps,
      });
      
      return {
        success: true,
        signature: `PAPER_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        confirmedSlot: 0,
        inputAmount: side === OrderSide.BUY ? amount : quote.inputAmount,
        actualOutputAmount: simulatedOutput,
        expectedOutputAmount: quote.expectedOutputAmount,
        slippageBps: simulatedSlippage,
        retryCount: 0,
        executionTimeMs: Date.now() - startTime,
      };
      
    } catch (error) {
      log.error('[PAPER] Simulation failed', error as Error);
      return {
        success: false,
        inputAmount: amount,
        error: `[PAPER] ${(error as Error).message}`,
        retryCount: 0,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }
  
  /**
   * Summarize route for logging
   */
  private summarizeRoute(routeJson: string): string {
    try {
      const route = JSON.parse(routeJson);
      if (Array.isArray(route) && route.length > 0) {
        return route.map((r: any) => r.swapInfo?.label || 'Unknown').join(' → ');
      }
      return 'Direct';
    } catch {
      return 'Unknown';
    }
  }
}
