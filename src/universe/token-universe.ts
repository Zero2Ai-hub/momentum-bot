/**
 * Token Universe - In-memory registry of active tokens.
 * Manages lifecycle of token state objects with automatic expiry.
 * 
 * FIX: Added mint validation as second safety net before universe entry.
 * ENHANCED: Now accepts Phase 1 hotness stats for data-budget-aware scoring.
 */

import EventEmitter from 'eventemitter3';
import { SwapEvent, LogEventType } from '../types';
import { TokenState, Phase1HotnessStats } from './token-state';
import { getConfig } from '../config/config';
import { logEvent, log } from '../logging/logger';
import { isVerifiedToken, isValidTradeableToken } from '../listener/token-verifier';

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
  
  // Set of mints that failed verification (don't re-verify)
  private rejectedMints = new Set<string>();
  
  // P1-7: Track mints that have exited to prevent duplicate exit events
  private exitedMints = new Set<string>();
  
  // Cache of pending Phase 1 stats (attached when token enters universe)
  private pendingPhase1Stats = new Map<string, Phase1HotnessStats>();
  
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
   * 
   * FIX (P0): Validates mint before allowing entry into universe.
   * This is a second safety net in case upstream emits an invalid mint.
   */
  async processSwap(event: SwapEvent): Promise<TokenState | null> {
    const { tokenMint } = event;
    
    // ═══════════════════════════════════════════════════════════════
    // FIX: VALIDATE MINT BEFORE UNIVERSE ENTRY
    // ═══════════════════════════════════════════════════════════════
    
    // Fast rejection for previously rejected mints
    if (this.rejectedMints.has(tokenMint)) {
      return null;
    }
    
    // Check if token is already in universe (already validated)
    let state = this.tokens.get(tokenMint);
    
    if (!state) {
      // NEW TOKEN: Must validate before entry
      
      // First check sync cache
      const cachedResult = isVerifiedToken(tokenMint);
      
      // Log cache result for pump tokens
      if (tokenMint.endsWith('pump')) {
        log.info(`🔍 Universe cache check: ${tokenMint.slice(0, 20)}... result=${cachedResult}`);
      }
      
      if (cachedResult === false) {
        this.rejectedMints.add(tokenMint);
        return null;
      }
      
      // If not in cache, do async verification
      if (cachedResult === undefined) {
        log.info(`⏳ Universe verifying NEW token: ${tokenMint.slice(0, 20)}...`);
        
        const isValid = await isValidTradeableToken(tokenMint);
        if (!isValid) {
          this.rejectedMints.add(tokenMint);
          log.info(`❌ Universe REJECTED: ${tokenMint.slice(0, 20)}... (not valid SPL mint)`);
          return null;
        }
      }
      
      // VALIDATED: Create new token state
      state = new TokenState(tokenMint, event);
      this.tokens.set(tokenMint, state);
      
      // P1-7: Clear exit flag for re-entry (clean lifecycle)
      this.exitedMints.delete(tokenMint);
      
      // FIX: Attach pending Phase 1 stats if available (they were cached before token entered)
      const pendingStats = this.pendingPhase1Stats.get(tokenMint);
      if (pendingStats) {
        state.setPhase1Stats(pendingStats);
        this.pendingPhase1Stats.delete(tokenMint);
        log.info(`✅ Token ENTERED universe: ${tokenMint.slice(0, 20)}... WITH PHASE 1 STATS: swaps=${pendingStats.swapsInWindow}`);
      } else {
        log.info(`✅ Token ENTERED universe: ${tokenMint.slice(0, 20)}... (no Phase 1 stats)`);
      }
      
      this.emit('token:entered', tokenMint, state);
    } else {
      // Existing token - update state
      state.processSwap(event);
    }
    
    // Emit swap event for scoring engine
    this.emit('token:swap', tokenMint, event, state);
    
    return state;
  }
  
  /**
   * Synchronous process swap - for backwards compatibility
   * Only processes if token is already verified in cache
   */
  processSwapSync(event: SwapEvent): TokenState | null {
    const { tokenMint } = event;
    
    // Fast rejection
    if (this.rejectedMints.has(tokenMint)) {
      return null;
    }
    
    // Check if already in universe
    let state = this.tokens.get(tokenMint);
    
    if (!state) {
      // Check sync cache only
      const cachedResult = isVerifiedToken(tokenMint);
      
      if (cachedResult === false) {
        this.rejectedMints.add(tokenMint);
        return null;
      }
      
      if (cachedResult !== true) {
        // Not verified yet - don't allow entry synchronously
        // The async version should be used instead
        return null;
      }
      
      // Verified: Create new token state
      state = new TokenState(tokenMint, event);
      this.tokens.set(tokenMint, state);
      
      // P1-7: Clear exit flag for re-entry (clean lifecycle)
      this.exitedMints.delete(tokenMint);
      
      this.emit('token:entered', tokenMint, state);
    } else {
      state.processSwap(event);
    }
    
    this.emit('token:swap', tokenMint, event, state);
    return state;
  }
  
  /**
   * Get token state by mint address
   */
  getToken(tokenMint: string): TokenState | undefined {
    return this.tokens.get(tokenMint);
  }
  
  /**
   * Set Phase 1 hotness stats on a token (for data-budget-aware scoring)
   * Call this when a token transitions to "hot" in Phase 1
   * 
   * FIX: If token isn't in universe yet, cache the stats for later attachment
   */
  setPhase1Stats(tokenMint: string, stats: Phase1HotnessStats): void {
    const state = this.tokens.get(tokenMint);
    if (state) {
      state.setPhase1Stats(stats);
      log.info(`📊 Phase 1 stats ATTACHED: ${tokenMint.slice(0, 20)}... swaps=${stats.swapsInWindow} buyRatio=${(stats.buyRatio * 100).toFixed(0)}%`);
    } else {
      // Token not in universe yet - cache for later attachment
      this.pendingPhase1Stats.set(tokenMint, stats);
      log.info(`📊 Phase 1 stats CACHED: ${tokenMint.slice(0, 20)}... swaps=${stats.swapsInWindow} (token not in universe yet)`);
    }
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
   * P1-7: Idempotent - only emits exit event once per lifecycle
   */
  removeToken(tokenMint: string): boolean {
    const existed = this.tokens.delete(tokenMint);
    if (existed && !this.exitedMints.has(tokenMint)) {
      this.exitedMints.add(tokenMint);
      this.emit('token:exited', tokenMint);
    }
    return existed;
  }
  
  /**
   * Remove inactive tokens
   * P1-7: Idempotent exits - each mint only emits one exit event per lifecycle
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
      const state = this.tokens.get(mint);
      if (!state) continue;
      
      // P1-7: Only emit exit event if not already exited
      if (!this.exitedMints.has(mint)) {
        this.exitedMints.add(mint);
        
        logEvent(LogEventType.TOKEN_EXITED_UNIVERSE, {
          tokenMint: mint,
          totalSwaps: state.allTimeSwapCount,
          lifetimeMs: now - state.firstSeenTimestamp,
        });
        
        this.emit('token:exited', mint);
      }
      
      this.tokens.delete(mint);
    }
    
    // Cleanup caches periodically
    if (this.rejectedMints.size > 10000) {
      const arr = Array.from(this.rejectedMints);
      this.rejectedMints = new Set(arr.slice(-5000));
    }
    
    // Cleanup exited mints cache (older than 5 minutes can be re-entered)
    if (this.exitedMints.size > 5000) {
      const arr = Array.from(this.exitedMints);
      this.exitedMints = new Set(arr.slice(-2500));
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
    rejectedMintsCount: number;
    exitedMintsCount: number;
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
      rejectedMintsCount: this.rejectedMints.size,
      exitedMintsCount: this.exitedMints.size,
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
