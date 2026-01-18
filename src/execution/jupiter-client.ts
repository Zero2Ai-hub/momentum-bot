/**
 * Jupiter Aggregator API Client
 * Handles quote fetching and swap transaction building.
 */

import Decimal from 'decimal.js';
import { Connection, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { SwapQuote, SOL_MINT } from '../types';
import { getConfig } from '../config/config';
import { log } from '../logging/logger';

interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
}

interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
}

/**
 * JupiterClient interfaces with Jupiter aggregator API
 * for optimal routing across Solana DEXs.
 */
export class JupiterClient {
  private apiUrl: string;
  private connection: Connection;
  private maxRetries = 3;
  private retryDelayMs = 500;
  
  constructor(connection: Connection) {
    this.apiUrl = getConfig().jupiterApiUrl;
    this.connection = connection;
  }
  
  /**
   * Get a swap quote from Jupiter
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: Decimal,
    slippageBps?: number
  ): Promise<SwapQuote | null> {
    const config = getConfig();
    const slippage = slippageBps ?? config.maxSlippageBps;
    
    // Convert amount to lamports/smallest unit
    const amountStr = amount.floor().toString();
    
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amountStr,
      slippageBps: slippage.toString(),
      onlyDirectRoutes: 'false',
      asLegacyTransaction: 'false',
    });
    
    try {
      const response = await this.fetchWithRetry(
        `${this.apiUrl}/quote?${params.toString()}`
      );
      
      if (!response.ok) {
        const errorText = await response.text();
        log.warn(`Jupiter quote failed: ${response.status} ${errorText}`);
        return null;
      }
      
      const data = await response.json() as JupiterQuoteResponse;
      
      // Calculate price impact in bps
      const priceImpactBps = Math.round(parseFloat(data.priceImpactPct) * 100);
      
      return {
        inputMint: data.inputMint,
        outputMint: data.outputMint,
        inputAmount: new Decimal(data.inAmount),
        expectedOutputAmount: new Decimal(data.outAmount),
        minimumOutputAmount: new Decimal(data.otherAmountThreshold),
        priceImpactBps,
        route: JSON.stringify(data.routePlan),
        expiresAt: Date.now() + 30_000, // 30 second validity
      };
      
    } catch (error) {
      // Don't spam errors for network issues - this is expected during high load
      log.debug(`Jupiter quote unavailable: ${(error as Error).message}`);
      return null;
    }
  }
  
  /**
   * Build swap transaction from quote
   */
  async buildSwapTransaction(
    quote: SwapQuote,
    userPublicKey: PublicKey,
    priorityFeeLamports?: number
  ): Promise<VersionedTransaction | null> {
    const config = getConfig();
    const priorityFee = priorityFeeLamports ?? config.priorityFeeLamports;
    
    try {
      // Reconstruct the quote response for Jupiter
      const routePlan = JSON.parse(quote.route);
      
      const quoteResponse = {
        inputMint: quote.inputMint,
        inAmount: quote.inputAmount.toString(),
        outputMint: quote.outputMint,
        outAmount: quote.expectedOutputAmount.toString(),
        otherAmountThreshold: quote.minimumOutputAmount.toString(),
        swapMode: 'ExactIn',
        slippageBps: config.maxSlippageBps,
        priceImpactPct: (quote.priceImpactBps / 100).toString(),
        routePlan,
      };
      
      const response = await this.fetchWithRetry(`${this.apiUrl}/swap`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: userPublicKey.toBase58(),
          wrapAndUnwrapSol: true,
          computeUnitPriceMicroLamports: Math.floor(priorityFee / 200000), // Convert to microlamports per CU
          dynamicComputeUnitLimit: true,
        }),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        log.warn(`Jupiter swap build failed: ${response.status} ${errorText}`);
        return null;
      }
      
      const data = await response.json() as JupiterSwapResponse;
      
      // Deserialize the transaction
      const swapTransactionBuf = Buffer.from(data.swapTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
      
      return transaction;
      
    } catch (error) {
      log.error('Jupiter swap build error', error as Error);
      return null;
    }
  }
  
  /**
   * Get quote for buying tokens with SOL
   */
  async getBuyQuote(
    tokenMint: string,
    solAmount: Decimal
  ): Promise<SwapQuote | null> {
    // Convert SOL to lamports
    const lamports = solAmount.mul(1e9);
    return this.getQuote(SOL_MINT, tokenMint, lamports);
  }
  
  /**
   * Get quote for selling tokens for SOL
   */
  async getSellQuote(
    tokenMint: string,
    tokenAmount: Decimal
  ): Promise<SwapQuote | null> {
    return this.getQuote(tokenMint, SOL_MINT, tokenAmount);
  }
  
  /**
   * Fetch with retry logic
   */
  private async fetchWithRetry(
    url: string,
    options?: RequestInit
  ): Promise<Response> {
    let lastError: Error | null = null;
    
    for (let i = 0; i < this.maxRetries; i++) {
      try {
        const response = await fetch(url, {
          ...options,
          signal: AbortSignal.timeout(10_000), // 10 second timeout
        });
        
        // Retry on 429 (rate limit) or 5xx errors
        if (response.status === 429 || response.status >= 500) {
          const delay = this.retryDelayMs * Math.pow(2, i);
          log.debug(`Jupiter API ${response.status}, retrying in ${delay}ms`);
          await this.sleep(delay);
          continue;
        }
        
        return response;
        
      } catch (error) {
        lastError = error as Error;
        
        if (i < this.maxRetries - 1) {
          const delay = this.retryDelayMs * Math.pow(2, i);
          log.debug(`Jupiter API error, retrying in ${delay}ms: ${lastError.message}`);
          await this.sleep(delay);
        }
      }
    }
    
    throw lastError || new Error('Jupiter API request failed');
  }
  
  /**
   * Check if a route exists for a token pair
   */
  async hasRoute(inputMint: string, outputMint: string): Promise<boolean> {
    const quote = await this.getQuote(
      inputMint, 
      outputMint, 
      new Decimal(1000000) // Test with small amount
    );
    return quote !== null;
  }
  
  /**
   * Get token price in SOL
   */
  async getTokenPriceInSol(tokenMint: string): Promise<Decimal | null> {
    // Get quote for 1 SOL worth of tokens
    const quote = await this.getQuote(
      SOL_MINT,
      tokenMint,
      new Decimal(1e9) // 1 SOL in lamports
    );
    
    if (!quote) return null;
    
    // Price = SOL input / token output
    return quote.inputAmount.div(quote.expectedOutputAmount);
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
