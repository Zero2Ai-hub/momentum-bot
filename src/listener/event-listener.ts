/**
 * On-chain Event Listener
 * Subscribes to Solana WebSocket streams and ingests swap events.
 * 
 * TWO-PHASE DETECTION:
 * Phase 1 (FREE): Parse raw logs to track swap count per token
 * Phase 2 (RPC): Only verify & emit for "hot" tokens with 5+ swaps in 30s
 * 
 * This solves:
 * 1. Credit usage - Only use RPC for hot tokens (~90% savings)
 * 2. Rate limit blindness - Phase 1 sees ALL activity in real-time
 */

import { Connection, PublicKey } from '@solana/web3.js';
import EventEmitter from 'eventemitter3';
import Decimal from 'decimal.js';
import { SwapEvent, SwapDirection, DEXSource, DEX_PROGRAM_IDS, LogEventType } from '../types';
import { getConfig } from '../config/config';
import { logEvent, log } from '../logging/logger';
import { validateSwapEvent, isValidTokenMint } from './parsers/known-addresses';
import { isValidTradeableToken, initializeTokenVerifier } from './token-verifier';
import { parseTransactionWithHelius } from './helius-parser';
import { getHotTokenTracker, HotTokenTracker } from './hot-token-tracker';
import { parseRaydiumSwap } from './parsers/raydium';
import { parsePumpFunSwap } from './parsers/pumpfun';
import { parsePumpSwapLogs } from './parsers/pumpswap';

interface EventListenerEvents {
  'swap': (event: SwapEvent) => void;
  'connected': () => void;
  'disconnected': () => void;
  'error': (error: Error) => void;
}

interface SubscriptionHandle {
  programId: string;
  subscriptionId: number;
}

/**
 * EventListener manages WebSocket connections to Solana and
 * parses swap events from DEX program logs.
 * 
 * Uses TWO-PHASE DETECTION:
 * - Phase 1: Raw log parsing (FREE) - tracks all swaps
 * - Phase 2: RPC verification (CREDITS) - only for hot tokens
 */
export class EventListener extends EventEmitter<EventListenerEvents> {
  private connection: Connection | null = null;
  private wsConnection: Connection | null = null;
  private subscriptions: SubscriptionHandle[] = [];
  private isRunning = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelayMs = 1000;
  
  // Deduplication - track recent signatures
  private recentSignatures = new Set<string>();
  private signatureCleanupInterval: NodeJS.Timeout | null = null;
  private readonly maxSignatures = 10000;
  
  // Two-phase detection
  private hotTokenTracker: HotTokenTracker;
  private pendingHotTokenVerifications = new Set<string>();
  
  // Track signatures per hot token for RPC verification
  private hotTokenSignatures = new Map<string, Set<string>>();
  
  constructor() {
    super();
    this.hotTokenTracker = getHotTokenTracker();
  }
  
  /**
   * Start the event listener
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      log.warn('Event listener already running');
      return;
    }
    
    const config = getConfig();
    this.isRunning = true;
    
    // Initialize token verifier
    await initializeTokenVerifier();
    
    // Start hot token tracker (Phase 1)
    this.hotTokenTracker.start();
    this.hotTokenTracker.onHotToken((tokenMint) => this.handleHotToken(tokenMint));
    
    // Create HTTP connection for queries
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    
    // Create WebSocket connection for streaming
    await this.connectWebSocket();
    
    // Start signature cleanup timer
    this.signatureCleanupInterval = setInterval(() => {
      this.cleanupSignatures();
    }, 30_000);
    
    log.info('Event listener started (Two-Phase Detection enabled)');
  }
  
  /**
   * Stop the event listener
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    
    // Unsubscribe from all
    await this.unsubscribeAll();
    
    // Stop hot token tracker
    this.hotTokenTracker.stop();
    
    // Stop cleanup timer
    if (this.signatureCleanupInterval) {
      clearInterval(this.signatureCleanupInterval);
      this.signatureCleanupInterval = null;
    }
    
    this.recentSignatures.clear();
    this.hotTokenSignatures.clear();
    this.pendingHotTokenVerifications.clear();
    log.info('Event listener stopped');
  }
  
  /**
   * Connect to WebSocket and subscribe to DEX programs
   */
  private async connectWebSocket(): Promise<void> {
    const config = getConfig();
    
    try {
      this.wsConnection = new Connection(config.rpcUrl, {
        commitment: 'confirmed',
        wsEndpoint: config.wsUrl,
      });
      
      // Subscribe to each DEX program
      await this.subscribeToProgram(DEX_PROGRAM_IDS.RAYDIUM_V4, DEXSource.RAYDIUM_V4);
      await this.subscribeToProgram(DEX_PROGRAM_IDS.RAYDIUM_CLMM, DEXSource.RAYDIUM_CLMM);
      await this.subscribeToProgram(DEX_PROGRAM_IDS.ORCA_WHIRLPOOL, DEXSource.ORCA_WHIRLPOOL);
      await this.subscribeToProgram(DEX_PROGRAM_IDS.METEORA, DEXSource.METEORA);
      await this.subscribeToProgram(DEX_PROGRAM_IDS.PUMPSWAP, DEXSource.PUMPSWAP);
      await this.subscribeToProgram(DEX_PROGRAM_IDS.PUMPFUN, DEXSource.PUMPFUN);
      
      this.reconnectAttempts = 0;
      this.emit('connected');
      log.info('WebSocket connected and subscribed to DEX programs');
      
    } catch (error) {
      log.error('WebSocket connection failed', error as Error);
      this.emit('error', error as Error);
      await this.handleReconnect();
    }
  }
  
  /**
   * Subscribe to a DEX program's logs
   */
  private async subscribeToProgram(programId: string, source: DEXSource): Promise<void> {
    if (!this.wsConnection) return;
    
    try {
      const pubkey = new PublicKey(programId);
      
      const subscriptionId = this.wsConnection.onLogs(
        pubkey,
        (logs, ctx) => {
          this.handleLogs(logs, ctx.slot, source);
        },
        'confirmed'
      );
      
      this.subscriptions.push({ programId, subscriptionId });
      log.debug(`Subscribed to ${source} (${programId.slice(0, 8)}...)`);
      
    } catch (error) {
      log.error(`Failed to subscribe to ${source}`, error as Error);
    }
  }
  
  /**
   * Handle incoming logs from subscription
   * 
   * TWO-PHASE DETECTION:
   * - Phase 1: Raw log parsing (FREE) - extract token & record activity
   * - Phase 2: RPC verification (CREDITS) - only when token becomes "hot"
   */
  private handleLogs(
    logs: { signature: string; err: any; logs: string[] },
    slot: number,
    source: DEXSource
  ): void {
    // Skip failed transactions
    if (logs.err) return;
    
    // Deduplication check
    if (this.recentSignatures.has(logs.signature)) {
      return;
    }
    this.recentSignatures.add(logs.signature);
    
    // ═══════════════════════════════════════════════════════════════════
    // PHASE 1: FREE LOG PARSING - Extract basic swap data from raw logs
    // ═══════════════════════════════════════════════════════════════════
    const phase1Events = this.parseLogsPhase1(logs.signature, slot, logs.logs, source);
    
    for (const event of phase1Events) {
      // Quick validation before tracking
      if (!isValidTokenMint(event.tokenMint)) {
        continue;
      }
      
      // Record in hot token tracker (FREE)
      this.hotTokenTracker.recordSwap(
        event.tokenMint,
        logs.signature,
        event.isBuy
      );
      
      // Track signature for this token (for Phase 2 verification)
      if (!this.hotTokenSignatures.has(event.tokenMint)) {
        this.hotTokenSignatures.set(event.tokenMint, new Set());
      }
      this.hotTokenSignatures.get(event.tokenMint)!.add(logs.signature);
      
      // Limit stored signatures per token
      const sigs = this.hotTokenSignatures.get(event.tokenMint)!;
      if (sigs.size > 20) {
        const arr = Array.from(sigs);
        this.hotTokenSignatures.set(event.tokenMint, new Set(arr.slice(-10)));
      }
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // PHASE 2 is triggered when token becomes "hot" (see handleHotToken)
    // ═══════════════════════════════════════════════════════════════════
  }
  
  /**
   * Phase 1: Parse raw logs to extract basic swap data (FREE - no RPC)
   */
  private parseLogsPhase1(
    signature: string,
    slot: number,
    logs: string[],
    source: DEXSource
  ): Array<{ tokenMint: string; isBuy: boolean }> {
    const results: Array<{ tokenMint: string; isBuy: boolean }> = [];
    
    try {
      // Try source-specific parsers
      let events: SwapEvent[] = [];
      
      switch (source) {
        case DEXSource.PUMPFUN:
          events = parsePumpFunSwap(signature, slot, logs);
          break;
        case DEXSource.PUMPSWAP:
          events = parsePumpSwapLogs(signature, slot, logs);
          break;
        case DEXSource.RAYDIUM_V4:
        case DEXSource.RAYDIUM_CLMM:
          events = parseRaydiumSwap(signature, slot, logs, source);
          break;
        default:
          // Generic extraction for other DEXs
          events = this.extractGenericSwap(signature, slot, logs, source);
      }
      
      for (const event of events) {
        if (event.tokenMint && event.tokenMint !== 'unknown') {
          results.push({
            tokenMint: event.tokenMint,
            isBuy: event.direction === 'BUY',
          });
        }
      }
    } catch (error) {
      // Phase 1 errors are non-critical - just skip
    }
    
    return results;
  }
  
  /**
   * Generic swap extraction for DEXs without specialized parsers
   */
  private extractGenericSwap(
    signature: string,
    slot: number,
    logs: string[],
    source: DEXSource
  ): SwapEvent[] {
    const events: SwapEvent[] = [];
    
    // Look for swap instruction
    const hasSwap = logs.some(l => 
      l.toLowerCase().includes('swap') || 
      l.toLowerCase().includes('instruction: buy') ||
      l.toLowerCase().includes('instruction: sell')
    );
    
    if (!hasSwap) return events;
    
    // Extract potential token mint addresses
    const mintPattern = /([1-9A-HJ-NP-Za-km-z]{43,44})/g;
    const foundMints: string[] = [];
    
    for (const log of logs) {
      const matches = log.match(mintPattern);
      if (matches) {
        for (const m of matches) {
          if (isValidTokenMint(m) && !foundMints.includes(m)) {
            foundMints.push(m);
          }
        }
      }
    }
    
    // Determine direction
    const isBuy = logs.some(l => 
      l.toLowerCase().includes('buy') || 
      l.toLowerCase().includes('swap') && !l.toLowerCase().includes('sell')
    );
    
    // Return first valid token mint found
    if (foundMints.length > 0) {
      events.push({
        signature,
        slot,
        timestamp: Date.now(),
        tokenMint: foundMints[0],
        direction: isBuy ? SwapDirection.BUY : SwapDirection.SELL,
        notionalSol: new Decimal(0), // Unknown in Phase 1
        walletAddress: 'unknown',
        dexSource: source,
      });
    }
    
    return events;
  }
  
  /**
   * Handle when a token becomes "hot" - trigger Phase 2 RPC verification
   */
  private async handleHotToken(tokenMint: string): Promise<void> {
    // Prevent duplicate verification
    if (this.pendingHotTokenVerifications.has(tokenMint)) {
      return;
    }
    this.pendingHotTokenVerifications.add(tokenMint);
    
    log.info(`🚀 Phase 2: Verifying hot token ${tokenMint}`);
    
    try {
      // Get stored signatures for this candidate token
      const signatures = this.hotTokenSignatures.get(tokenMint);
      if (!signatures || signatures.size === 0) {
        log.debug(`⚠️ No signatures stored for hot token candidate ${tokenMint}`);
        return;
      }
      
      // Strategy: Use signatures to find REAL token mints via getParsedTransaction
      // The candidate mint from Phase 1 might be wrong (pool address, authority, etc.)
      // Phase 2 uses proper Helius parsing to find actual traded tokens
      
      const signatureArr = Array.from(signatures).slice(-5); // Last 5 signatures
      const verifiedMints = new Map<string, number>(); // mint -> count
      
      log.debug(`🔍 Phase 2: Parsing ${signatureArr.length} signatures for candidate ${tokenMint.slice(0, 8)}...`);
      
      for (const sig of signatureArr) {
        const realMint = await this.findRealTokenFromSignature(sig);
        if (realMint) {
          verifiedMints.set(realMint, (verifiedMints.get(realMint) || 0) + 1);
        }
      }
      
      // Find the most common verified mint from these signatures
      let bestMint: string | null = null;
      let bestCount = 0;
      for (const [mint, count] of verifiedMints) {
        if (count > bestCount) {
          bestMint = mint;
          bestCount = count;
        }
      }
      
      if (!bestMint) {
        log.info(`❌ Phase 2: No valid token found in signatures for candidate ${tokenMint.slice(0, 16)}...`);
        return;
      }
      
      log.info(`✅ Phase 2 FOUND REAL TOKEN: ${bestMint} (from ${bestCount}/${signatureArr.length} sigs)`);
      
      // Now emit swap events for this verified mint
      for (const sig of signatureArr) {
        await this.verifyAndEmitSwap(sig, bestMint);
      }
      
    } catch (error) {
      log.error('Phase 2 verification error', error as Error);
    } finally {
      this.pendingHotTokenVerifications.delete(tokenMint);
    }
  }
  
  /**
   * Find the REAL token mint from a signature using RPC parsing
   */
  private async findRealTokenFromSignature(signature: string): Promise<string | null> {
    if (!this.connection) return null;
    
    try {
      const event = await parseTransactionWithHelius(this.connection, signature, 0);
      if (!event || !event.tokenMint || event.tokenMint === 'unknown') {
        return null;
      }
      
      // Verify this is a real SPL mint
      const isValid = await isValidTradeableToken(event.tokenMint);
      if (!isValid) {
        return null;
      }
      
      return event.tokenMint;
    } catch (error) {
      return null;
    }
  }
  
  /**
   * Verify a signature and emit swap event if valid (Phase 2)
   */
  private async verifyAndEmitSwap(signature: string, expectedMint: string): Promise<void> {
    if (!this.connection) return;
    
    try {
      const event = await parseTransactionWithHelius(this.connection, signature, 0);
      
      if (!event) return;
      
      // Accept if the event's token matches the expected mint OR if the expected mint is verified
      // This handles cases where the same signature might involve multiple tokens
      if (event.tokenMint !== expectedMint) {
        return;
      }
      
      // Basic validation
      const validation = validateSwapEvent(
        event.tokenMint,
        event.walletAddress,
        event.notionalSol.toNumber()
      );
      
      if (!validation.valid) return;
      
      // Emit verified swap event
      logEvent(LogEventType.SWAP_DETECTED, {
        signature: event.signature,
        tokenMint: event.tokenMint,
        direction: event.direction,
        notionalSol: event.notionalSol.toString(),
        wallet: event.walletAddress,
        dex: event.dexSource,
        phase: 'hot_token_verified',
      });
      
      this.emit('swap', event);
      
    } catch (error) {
      log.debug('Swap verification failed', { signature: signature.slice(0, 16) });
    }
  }
  
  /**
   * Unsubscribe from all programs
   */
  private async unsubscribeAll(): Promise<void> {
    if (!this.wsConnection) return;
    
    for (const sub of this.subscriptions) {
      try {
        await this.wsConnection.removeOnLogsListener(sub.subscriptionId);
      } catch (error) {
        log.debug(`Error unsubscribing from ${sub.programId}`, { error });
      }
    }
    
    this.subscriptions = [];
  }
  
  /**
   * Handle reconnection with exponential backoff
   */
  private async handleReconnect(): Promise<void> {
    if (!this.isRunning) return;
    
    this.reconnectAttempts++;
    
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      log.error('Max reconnection attempts reached');
      this.emit('error', new Error('Max reconnection attempts reached'));
      return;
    }
    
    const delay = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);
    log.warn(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    this.emit('disconnected');
    
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // Cleanup old subscriptions
    await this.unsubscribeAll();
    
    // Reconnect
    await this.connectWebSocket();
  }
  
  /**
   * Cleanup old signatures to prevent memory growth
   */
  private cleanupSignatures(): void {
    if (this.recentSignatures.size > this.maxSignatures) {
      const toKeep = Array.from(this.recentSignatures).slice(-this.maxSignatures / 2);
      this.recentSignatures.clear();
      for (const sig of toKeep) {
        this.recentSignatures.add(sig);
      }
      log.debug(`Cleaned up signatures, ${this.recentSignatures.size} remaining`);
    }
  }
  
  /**
   * Get HTTP connection for queries
   */
  getConnection(): Connection | null {
    return this.connection;
  }
  
  /**
   * Get listener statistics
   */
  getStats(): {
    isRunning: boolean;
    subscriptionCount: number;
    recentSignatureCount: number;
    reconnectAttempts: number;
    phase1TrackedTokens: number;
    hotTokens: number;
  } {
    const hotTokenStats = this.hotTokenTracker.getStats();
    return {
      isRunning: this.isRunning,
      subscriptionCount: this.subscriptions.length,
      recentSignatureCount: this.recentSignatures.size,
      reconnectAttempts: this.reconnectAttempts,
      phase1TrackedTokens: hotTokenStats.trackedTokens,
      hotTokens: hotTokenStats.hotTokens,
    };
  }
}

// Singleton instance
let listenerInstance: EventListener | null = null;

export function getEventListener(): EventListener {
  if (!listenerInstance) {
    listenerInstance = new EventListener();
  }
  return listenerInstance;
}

export function resetEventListener(): void {
  if (listenerInstance) {
    listenerInstance.stop();
    listenerInstance = null;
  }
}
