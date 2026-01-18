/**
 * On-chain Event Listener
 * Subscribes to Solana WebSocket streams and ingests swap events.
 */

import { Connection, PublicKey, LogsFilter } from '@solana/web3.js';
import EventEmitter from 'eventemitter3';
import { SwapEvent, DEXSource, DEX_PROGRAM_IDS, LogEventType } from '../types';
import { getConfig } from '../config/config';
import { logEvent, log } from '../logging/logger';
import { parseRaydiumSwap } from './parsers/raydium';
import { parseOrcaSwap } from './parsers/orca';
import { parsePumpSwap } from './parsers/pumpswap';
import { parsePumpFunSwap } from './parsers/pumpfun';
import { validateSwapEvent } from './parsers/known-addresses';
import { isVerifiedToken, queueTokenVerification, initializeTokenVerifier } from './token-verifier';
import { parseTransactionWithHelius } from './helius-parser';

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
  
  constructor() {
    super();
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
    
    // Initialize token verifier (loads Jupiter token list)
    await initializeTokenVerifier();
    
    // Create HTTP connection for queries
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    
    // Create WebSocket connection for streaming
    await this.connectWebSocket();
    
    // Start signature cleanup timer
    this.signatureCleanupInterval = setInterval(() => {
      this.cleanupSignatures();
    }, 30_000);
    
    log.info('Event listener started');
  }
  
  /**
   * Stop the event listener
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    
    // Unsubscribe from all
    await this.unsubscribeAll();
    
    // Stop cleanup timer
    if (this.signatureCleanupInterval) {
      clearInterval(this.signatureCleanupInterval);
      this.signatureCleanupInterval = null;
    }
    
    this.recentSignatures.clear();
    log.info('Event listener stopped');
  }
  
  /**
   * Connect to WebSocket and subscribe to DEX programs
   */
  private async connectWebSocket(): Promise<void> {
    const config = getConfig();
    
    try {
      // Create connection with HTTP URL, WebSocket endpoint in options
      // The Connection class requires http(s) URL as first arg
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
    
    // Use Helius parsed transaction API for reliable token extraction
    this.parseWithHelius(logs.signature, slot, source);
  }
  
  /**
   * Parse transaction using Helius for accurate token mint extraction
   */
  private async parseWithHelius(
    signature: string,
    slot: number,
    source: DEXSource
  ): Promise<void> {
    if (!this.connection) return;
    
    try {
      const event = await parseTransactionWithHelius(this.connection, signature, slot);
      
      if (!event) {
        return; // Not a swap or parsing failed
      }
      
      // Override DEX source if we detected it from logs
      if (event.dexSource === DEXSource.UNKNOWN) {
        event.dexSource = source;
      }
      
      // Validate the swap event
      const validation = validateSwapEvent(
        event.tokenMint,
        event.walletAddress,
        event.notionalSol.toNumber()
      );
      
      if (!validation.valid) {
        return;
      }
      
      // RPC VERIFICATION: Check if token is a real SPL token mint
      const verificationStatus = isVerifiedToken(event.tokenMint);
      
      if (verificationStatus === false) {
        // Token was verified and is NOT a real token - skip it
        return;
      }
      
      if (verificationStatus === undefined) {
        // Queue for verification
        queueTokenVerification(event.tokenMint);
      }
      
      // Log and emit the event
      logEvent(LogEventType.SWAP_DETECTED, {
        signature: event.signature,
        tokenMint: event.tokenMint,
        direction: event.direction,
        notionalSol: event.notionalSol.toString(),
        wallet: event.walletAddress,
        dex: event.dexSource,
      });
      
      this.emit('swap', event);
      
    } catch (error) {
      log.debug('Helius parse error', { signature: signature.slice(0, 16), error: (error as Error).message });
    }
  }
  
  /**
   * Parse logs into swap events based on DEX source
   */
  private parseLogs(
    signature: string,
    slot: number,
    logs: string[],
    source: DEXSource
  ): SwapEvent[] {
    switch (source) {
      case DEXSource.RAYDIUM_V4:
      case DEXSource.RAYDIUM_CLMM:
        return parseRaydiumSwap(signature, slot, logs, source);
      
      case DEXSource.ORCA_WHIRLPOOL:
        return parseOrcaSwap(signature, slot, logs);
      
      case DEXSource.METEORA:
        // Meteora uses similar structure to Raydium
        return parseRaydiumSwap(signature, slot, logs, source);
      
      case DEXSource.PUMPSWAP:
        return parsePumpSwap(signature, slot, logs);
      
      case DEXSource.PUMPFUN:
        return parsePumpFunSwap(signature, slot, logs);
      
      default:
        return [];
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
      // Keep only the most recent half
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
  } {
    return {
      isRunning: this.isRunning,
      subscriptionCount: this.subscriptions.length,
      recentSignatureCount: this.recentSignatures.size,
      reconnectAttempts: this.reconnectAttempts,
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
