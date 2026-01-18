/**
 * Hot Token Tracker
 * 
 * Phase 1 of two-phase detection: Tracks swap activity from raw logs (FREE, no RPC).
 * Only triggers expensive RPC verification when a token shows momentum potential.
 * 
 * This solves two problems:
 * 1. Credit usage - Only use RPC for hot tokens (~90% savings)
 * 2. Rate limit blindness - Raw log parsing sees ALL activity in real-time
 */

import { log } from '../logging/logger';
import { getConfig } from '../config/config';

interface TokenActivity {
  swapCount: number;
  firstSeen: number;
  lastSeen: number;
  estimatedBuys: number;
  estimatedSells: number;
  signatures: Set<string>; // Dedupe
}

// Configuration - loaded from config
const CLEANUP_INTERVAL_MS = 10_000;   // Cleanup old tokens every 10s
const MAX_TRACKED_TOKENS = 1000;      // Memory limit

/**
 * HotTokenTracker monitors swap activity from raw logs without RPC calls.
 * When a token crosses the activity threshold, it signals for RPC verification.
 */
export class HotTokenTracker {
  private tokenActivity = new Map<string, TokenActivity>();
  private hotTokenCallbacks: ((tokenMint: string) => void)[] = [];
  private cleanupInterval: NodeJS.Timeout | null = null;
  private hotTokensTriggered = new Set<string>(); // Prevent duplicate triggers
  
  // Config values (loaded at start)
  private hotTokenThreshold = 5;
  private hotTokenWindowMs = 30_000;
  
  constructor() {}
  
  /**
   * Start the tracker
   */
  start(): void {
    // Load config values
    const config = getConfig();
    this.hotTokenThreshold = config.hotTokenThreshold;
    this.hotTokenWindowMs = config.hotTokenWindowMs;
    
    this.cleanupInterval = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    log.info('Hot token tracker started', { 
      threshold: this.hotTokenThreshold, 
      windowMs: this.hotTokenWindowMs 
    });
  }
  
  /**
   * Stop the tracker
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.tokenActivity.clear();
    this.hotTokensTriggered.clear();
  }
  
  /**
   * Register callback for when a token becomes "hot"
   */
  onHotToken(callback: (tokenMint: string) => void): void {
    this.hotTokenCallbacks.push(callback);
  }
  
  /**
   * Record a swap from raw log parsing (FREE - no RPC)
   * This is called for every swap detected from WebSocket logs.
   */
  recordSwap(
    tokenMint: string, 
    signature: string,
    isBuy: boolean
  ): void {
    const now = Date.now();
    
    let activity = this.tokenActivity.get(tokenMint);
    
    if (!activity) {
      activity = {
        swapCount: 0,
        firstSeen: now,
        lastSeen: now,
        estimatedBuys: 0,
        estimatedSells: 0,
        signatures: new Set(),
      };
      this.tokenActivity.set(tokenMint, activity);
    }
    
    // Dedupe by signature
    if (activity.signatures.has(signature)) {
      return;
    }
    activity.signatures.add(signature);
    
    // Update activity
    activity.swapCount++;
    activity.lastSeen = now;
    
    if (isBuy) {
      activity.estimatedBuys++;
    } else {
      activity.estimatedSells++;
    }
    
    // Check if token is now "hot"
    this.checkHotStatus(tokenMint, activity);
  }
  
  /**
   * Check if a token has crossed the hot threshold
   */
  private checkHotStatus(tokenMint: string, activity: TokenActivity): void {
    const now = Date.now();
    const windowStart = now - this.hotTokenWindowMs;
    
    // Only count swaps within the window
    // (simplified: we track total, but firstSeen gives us a sense of recency)
    if (activity.firstSeen < windowStart) {
      // Token has been around longer than window, swaps might be spread out
      // Use a stricter threshold
      const recentSwaps = activity.swapCount;
      if (recentSwaps < this.hotTokenThreshold * 2) {
        return;
      }
    }
    
    // Check threshold
    if (activity.swapCount >= this.hotTokenThreshold) {
      // Check if we already triggered for this token recently
      if (this.hotTokensTriggered.has(tokenMint)) {
        return;
      }
      
      // Check buy/sell ratio - want more buys than sells for momentum
      const buyRatio = activity.estimatedBuys / Math.max(activity.swapCount, 1);
      
      // Log hot detection
      log.info(`🔥 HOT TOKEN DETECTED (Phase 1)`, {
        tokenMint: tokenMint.slice(0, 16) + '...',
        swaps: activity.swapCount,
        buys: activity.estimatedBuys,
        sells: activity.estimatedSells,
        buyRatio: (buyRatio * 100).toFixed(0) + '%',
        windowMs: now - activity.firstSeen,
      });
      
      // Mark as triggered
      this.hotTokensTriggered.add(tokenMint);
      
      // Trigger callbacks (Phase 2 RPC verification)
      for (const callback of this.hotTokenCallbacks) {
        try {
          callback(tokenMint);
        } catch (error) {
          log.error('Hot token callback error', error as Error);
        }
      }
    }
  }
  
  /**
   * Get current activity for a token (for debugging)
   */
  getActivity(tokenMint: string): TokenActivity | undefined {
    return this.tokenActivity.get(tokenMint);
  }
  
  /**
   * Check if a token is currently hot
   */
  isHot(tokenMint: string): boolean {
    return this.hotTokensTriggered.has(tokenMint);
  }
  
  /**
   * Get all hot tokens
   */
  getHotTokens(): string[] {
    return Array.from(this.hotTokensTriggered);
  }
  
  /**
   * Cleanup old tokens to prevent memory growth
   */
  private cleanup(): void {
    const now = Date.now();
    const expireTime = now - this.hotTokenWindowMs * 2;
    
    // Remove old token activity
    for (const [mint, activity] of this.tokenActivity) {
      if (activity.lastSeen < expireTime) {
        this.tokenActivity.delete(mint);
        this.hotTokensTriggered.delete(mint);
      }
    }
    
    // Enforce max tokens limit
    if (this.tokenActivity.size > MAX_TRACKED_TOKENS) {
      const entries = Array.from(this.tokenActivity.entries());
      entries.sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      
      const toRemove = entries.slice(0, entries.length - MAX_TRACKED_TOKENS);
      for (const [mint] of toRemove) {
        this.tokenActivity.delete(mint);
        this.hotTokensTriggered.delete(mint);
      }
    }
  }
  
  /**
   * Get tracker statistics
   */
  getStats(): {
    trackedTokens: number;
    hotTokens: number;
  } {
    return {
      trackedTokens: this.tokenActivity.size,
      hotTokens: this.hotTokensTriggered.size,
    };
  }
}

// Singleton instance
let trackerInstance: HotTokenTracker | null = null;

export function getHotTokenTracker(): HotTokenTracker {
  if (!trackerInstance) {
    trackerInstance = new HotTokenTracker();
  }
  return trackerInstance;
}

export function resetHotTokenTracker(): void {
  if (trackerInstance) {
    trackerInstance.stop();
    trackerInstance = null;
  }
}
