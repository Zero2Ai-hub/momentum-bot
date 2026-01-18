/**
 * Token Universe - In-memory registry of active tokens.
 * Manages lifecycle of token state objects with automatic expiry.
 */

import EventEmitter from 'eventemitter3';
import { SwapEvent, LogEventType } from '../types';
import { TokenState } from './token-state';
import { getConfig } from '../config/config';
import { logEvent, log } from '../logging/logger';

interface TokenUniverseEvents {
  'token:entered': (tokenMint: string, state: TokenState) => void;
  'token:exited': (tokenMint: string) => void;
  'token:swap': (tokenMint: string, event: SwapEvent, state: TokenState) => void;
}

/**
 * TokenUniverse maintains the set of active tokens being tracked.
 * Tokens enter when their first swap is observed and exit after inactivity.
 */
export class TokenUniverse extends EventEmitter<TokenUniverseEvents> {
  private tokens = new Map<string, TokenState>();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private inactivityTimeoutMs: number;
  
  constructor() {
    super();
    this.inactivityTimeoutMs = getConfig().tokenInactivityTimeoutMs;
  }
  
  /**
   * Start the cleanup timer
   */
  start(): void {
    // Run cleanup every 10 seconds
    this.cleanupInterval = setInterval(() => this.cleanup(), 10_000);
    log.info('Token universe started', { inactivityTimeoutMs: this.inactivityTimeoutMs });
  }
  
  /**
   * Stop the cleanup timer
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
  
  /**
   * Process a swap event - creates or updates token state
   */
  processSwap(event: SwapEvent): TokenState {
    let state = this.tokens.get(event.tokenMint);
    
    if (!state) {
      // New token - create state (no console logging - too verbose)
      state = new TokenState(event.tokenMint, event);
      this.tokens.set(event.tokenMint, state);
      this.emit('token:entered', event.tokenMint, state);
    } else {
      // Existing token - update state
      state.processSwap(event);
    }
    
    // Emit swap event for scoring engine
    this.emit('token:swap', event.tokenMint, event, state);
    
    return state;
  }
  
  /**
   * Get token state by mint address
   */
  getToken(tokenMint: string): TokenState | undefined {
    return this.tokens.get(tokenMint);
  }
  
  /**
   * Check if token is being tracked
   */
  hasToken(tokenMint: string): boolean {
    return this.tokens.has(tokenMint);
  }
  
  /**
   * Get all active tokens
   */
  getAllTokens(): TokenState[] {
    return Array.from(this.tokens.values());
  }
  
  /**
   * Get active token count
   */
  get size(): number {
    return this.tokens.size;
  }
  
  /**
   * Manually remove a token (for testing or forced cleanup)
   */
  removeToken(tokenMint: string): boolean {
    const existed = this.tokens.delete(tokenMint);
    if (existed) {
      this.emit('token:exited', tokenMint);
    }
    return existed;
  }
  
  /**
   * Remove inactive tokens
   */
  private cleanup(): void {
    const now = Date.now();
    const toRemove: string[] = [];
    
    for (const [mint, state] of this.tokens) {
      // Tick windows to expire old events
      state.tick();
      
      // Check for inactivity
      if (state.isInactiveSince(this.inactivityTimeoutMs)) {
        toRemove.push(mint);
      }
    }
    
    for (const mint of toRemove) {
      const state = this.tokens.get(mint)!;
      
      // Only log to events file, not console
      logEvent(LogEventType.TOKEN_EXITED_UNIVERSE, {
        tokenMint: mint,
        totalSwaps: state.allTimeSwapCount,
        lifetimeMs: now - state.firstSeenTimestamp,
      });
      
      this.tokens.delete(mint);
      this.emit('token:exited', mint);
    }
  }
  
  /**
   * Get universe statistics
   */
  getStats(): {
    totalTokens: number;
    totalSwapsTracked: number;
    oldestTokenAge: number;
    newestTokenAge: number;
  } {
    const now = Date.now();
    let totalSwaps = 0;
    let oldest = now;
    let newest = 0;
    
    for (const state of this.tokens.values()) {
      totalSwaps += state.allTimeSwapCount;
      if (state.firstSeenTimestamp < oldest) oldest = state.firstSeenTimestamp;
      if (state.firstSeenTimestamp > newest) newest = state.firstSeenTimestamp;
    }
    
    return {
      totalTokens: this.tokens.size,
      totalSwapsTracked: totalSwaps,
      oldestTokenAge: this.tokens.size > 0 ? now - oldest : 0,
      newestTokenAge: this.tokens.size > 0 ? now - newest : 0,
    };
  }
}

// Singleton instance
let universeInstance: TokenUniverse | null = null;

export function getTokenUniverse(): TokenUniverse {
  if (!universeInstance) {
    universeInstance = new TokenUniverse();
  }
  return universeInstance;
}

export function resetTokenUniverse(): void {
  if (universeInstance) {
    universeInstance.stop();
    universeInstance = null;
  }
}
