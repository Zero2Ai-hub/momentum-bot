/**
 * Hot Token Tracker - Phase 1 of Two-Phase Detection
 * 
 * Tracks swap activity from raw logs (FREE, no RPC).
 * Only triggers expensive RPC verification when a token shows momentum potential.
 * 
 * FIXED: Now uses TRUE SLIDING WINDOW with timestamp deque.
 * windowMs reported will never exceed configured window + small jitter.
 * 
 * ADDED: Cooldown system to prevent Phase 2 spam.
 * ADDED: Baseline tracking for quiet→hot transition detection.
 */

import { log } from '../logging/logger';
import { logEvent } from '../logging/logger';
import { getConfig } from '../config/config';
import { LogEventType } from '../types';

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

interface SwapRecord {
  timestamp: number;
  signature: string;
  isBuy: boolean;
  wallet: string;
}

interface TokenActivity {
  // Sliding window: timestamps of recent swaps (FIFO deque)
  swaps: SwapRecord[];
  
  // Tracking state
  firstSeen: number;
  lastSeen: number;
  
  // Baseline tracking for quiet→hot detection
  baselineSwapsPerMin: number;  // Average over last 5-10 minutes
  baselineLastCalculated: number;
  baselineSwapCount: number;    // Swaps counted for baseline calculation
}

interface CooldownState {
  until: number;      // Timestamp when cooldown expires
  reason: string;     // Why cooldown was applied
  attempts: number;   // Number of attempts
}

// ═══════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════

const CLEANUP_INTERVAL_MS = 10_000;   // Cleanup old tokens every 10s
const MAX_TRACKED_CANDIDATES = 1000;  // Memory limit
const MAX_SWAPS_PER_CANDIDATE = 200;  // Max swaps to store per candidate
const BASELINE_WINDOW_MS = 5 * 60 * 1000; // 5 minute baseline window
const BASELINE_UPDATE_INTERVAL_MS = 30_000; // Update baseline every 30s

// Cooldown durations
const COOLDOWN_ON_REJECT_MS = 10 * 60 * 1000;   // 10 minutes on Phase 2 reject
const COOLDOWN_ON_SUCCESS_MS = 3 * 60 * 1000;   // 3 minutes on Phase 2 success
const COOLDOWN_ON_NOISE_MS = 15 * 60 * 1000;    // 15 minutes if noise detected

// ═══════════════════════════════════════════════════════════════════
// HotTokenTracker
// ═══════════════════════════════════════════════════════════════════

export class HotTokenTracker {
  private tokenActivity = new Map<string, TokenActivity>();
  private hotTokenCallbacks: ((candidate: string, stats: HotDetectionStats) => void)[] = [];
  private cleanupInterval: NodeJS.Timeout | null = null;
  
  // Prevent duplicate triggers
  private inflightPhase2 = new Map<string, Promise<void>>(); // Active Phase 2 verifications
  private cooldowns = new Map<string, CooldownState>();       // Cooldown tracking
  
  // Config values
  private hotTokenThreshold = 5;
  private hotTokenWindowMs = 30_000;
  
  // RPC call counters for observability
  private counters = {
    phase1CandidatesSeen: 0,
    phase2Started: 0,
    phase2Rejected: 0,
    phase2Success: 0,
    cooldownSkips: 0,
    inflightSkips: 0,
  };
  
  constructor() {}
  
  /**
   * Start the tracker
   */
  start(): void {
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
    this.inflightPhase2.clear();
    this.cooldowns.clear();
  }
  
  /**
   * Register callback for when a candidate becomes "hot"
   */
  onHotToken(callback: (candidate: string, stats: HotDetectionStats) => void): void {
    this.hotTokenCallbacks.push(callback);
  }
  
  /**
   * Record a swap from raw log parsing (FREE - no RPC)
   */
  recordSwap(
    candidate: string, 
    signature: string,
    isBuy: boolean,
    wallet: string = 'unknown'
  ): void {
    const now = Date.now();
    this.counters.phase1CandidatesSeen++;
    
    let activity = this.tokenActivity.get(candidate);
    
    if (!activity) {
      activity = {
        swaps: [],
        firstSeen: now,
        lastSeen: now,
        baselineSwapsPerMin: 0,
        baselineLastCalculated: now,
        baselineSwapCount: 0,
      };
      this.tokenActivity.set(candidate, activity);
    }
    
    // Dedupe by signature
    if (activity.swaps.some(s => s.signature === signature)) {
      return;
    }
    
    // Add new swap record
    const record: SwapRecord = {
      timestamp: now,
      signature,
      isBuy,
      wallet,
    };
    activity.swaps.push(record);
    activity.lastSeen = now;
    
    // Prune old swaps (sliding window maintenance)
    this.pruneOldSwaps(activity, now);
    
    // Update baseline periodically
    this.updateBaseline(activity, now);
    
    // Check if candidate is now "hot"
    this.checkHotStatus(candidate, activity, now);
  }
  
  /**
   * Prune swaps older than 2x window (keep some history for baseline)
   */
  private pruneOldSwaps(activity: TokenActivity, now: number): void {
    const maxAge = Math.max(this.hotTokenWindowMs * 2, BASELINE_WINDOW_MS);
    const cutoff = now - maxAge;
    
    // Remove old swaps from front of array
    while (activity.swaps.length > 0 && activity.swaps[0].timestamp < cutoff) {
      activity.swaps.shift();
    }
    
    // Enforce max swaps limit
    if (activity.swaps.length > MAX_SWAPS_PER_CANDIDATE) {
      activity.swaps = activity.swaps.slice(-MAX_SWAPS_PER_CANDIDATE);
    }
  }
  
  /**
   * Update baseline activity (swaps per minute in the baseline window)
   */
  private updateBaseline(activity: TokenActivity, now: number): void {
    if (now - activity.baselineLastCalculated < BASELINE_UPDATE_INTERVAL_MS) {
      return;
    }
    
    // Count swaps in baseline window (but not in hot window)
    const baselineStart = now - BASELINE_WINDOW_MS;
    const hotStart = now - this.hotTokenWindowMs;
    
    let baselineSwaps = 0;
    for (const swap of activity.swaps) {
      if (swap.timestamp >= baselineStart && swap.timestamp < hotStart) {
        baselineSwaps++;
      }
    }
    
    // Calculate swaps per minute
    const baselineMinutes = (BASELINE_WINDOW_MS - this.hotTokenWindowMs) / 60_000;
    activity.baselineSwapsPerMin = baselineSwaps / Math.max(baselineMinutes, 1);
    activity.baselineLastCalculated = now;
    activity.baselineSwapCount = baselineSwaps;
  }
  
  /**
   * Get swap count in the EXACT sliding window
   */
  private getWindowSwapCount(activity: TokenActivity, now: number): {
    count: number;
    buys: number;
    sells: number;
    uniqueWallets: Set<string>;
    windowActualMs: number;
  } {
    const windowStart = now - this.hotTokenWindowMs;
    let count = 0;
    let buys = 0;
    let sells = 0;
    const uniqueWallets = new Set<string>();
    let firstInWindow = now;
    
    for (const swap of activity.swaps) {
      if (swap.timestamp >= windowStart) {
        count++;
        if (swap.isBuy) buys++;
        else sells++;
        if (swap.wallet !== 'unknown') uniqueWallets.add(swap.wallet);
        if (swap.timestamp < firstInWindow) firstInWindow = swap.timestamp;
      }
    }
    
    return {
      count,
      buys,
      sells,
      uniqueWallets,
      windowActualMs: count > 0 ? now - firstInWindow : 0,
    };
  }
  
  /**
   * Check if a candidate has crossed the hot threshold
   */
  private checkHotStatus(candidate: string, activity: TokenActivity, now: number): void {
    // ═══════════════════════════════════════════════════════════════
    // EARLY EXIT CHECKS - prevent Phase 2 spam
    // ═══════════════════════════════════════════════════════════════
    
    // Check if in cooldown
    const cooldown = this.cooldowns.get(candidate);
    if (cooldown && cooldown.until > now) {
      // Log periodically (not every swap)
      if (this.counters.cooldownSkips % 100 === 0) {
        log.debug('PHASE1_COOLDOWN_SKIP', { 
          candidate: candidate.slice(0, 16) + '...',
          until: new Date(cooldown.until).toISOString(),
          reason: cooldown.reason,
        });
      }
      this.counters.cooldownSkips++;
      return;
    }
    
    // Check if Phase 2 is already in-flight
    if (this.inflightPhase2.has(candidate)) {
      this.counters.inflightSkips++;
      return;
    }
    
    // ═══════════════════════════════════════════════════════════════
    // TRUE SLIDING WINDOW COUNT
    // ═══════════════════════════════════════════════════════════════
    
    const windowStats = this.getWindowSwapCount(activity, now);
    
    // Not enough swaps in window
    if (windowStats.count < this.hotTokenThreshold) {
      return;
    }
    
    // QUALITY FILTERS - different criteria based on data quality
    const hasRealWalletData = windowStats.uniqueWallets.size > 0;
    
    if (hasRealWalletData) {
      // For pump.fun bonding curve: We have real wallet data from IDL
      // Apply strict quality filters
      
      // Require minimum unique wallets (prevents bot churn)
      const MIN_UNIQUE_WALLETS = 4;
      if (windowStats.uniqueWallets.size < MIN_UNIQUE_WALLETS) {
        return;
      }
      
      // Require positive buy momentum (more buys than sells)
      const buyRatioCheck = windowStats.buys / Math.max(windowStats.count, 1);
      const MIN_BUY_RATIO = 0.5; // At least 50% buys
      if (buyRatioCheck < MIN_BUY_RATIO) {
        return;
      }
    } else {
      // For Raydium/Meteora: No real wallet data, use higher swap threshold
      // This catches graduated tokens like Buttcoin/RAAAAAH
      const MIN_SWAPS_NO_WALLET_DATA = 10; // Higher threshold to compensate
      if (windowStats.count < MIN_SWAPS_NO_WALLET_DATA) {
        return;
      }
    }
    
    // ═══════════════════════════════════════════════════════════════
    // QUIET → HOT TRANSITION CHECK
    // ═══════════════════════════════════════════════════════════════
    
    // Calculate current swaps per minute
    const currentSwapsPerMin = (windowStats.count / this.hotTokenWindowMs) * 60_000;
    
    // Check if this is truly "new momentum" (was quiet, now hot)
    // Skip if token has been consistently active (baseline close to current)
    const baselineThreshold = this.hotTokenThreshold / 2; // If baseline > half threshold, not "quiet"
    const isNewMomentum = activity.baselineSwapsPerMin < baselineThreshold;
    
    // ═══════════════════════════════════════════════════════════════
    // HOT TOKEN DETECTED
    // ═══════════════════════════════════════════════════════════════
    
    const buyRatio = windowStats.buys / Math.max(windowStats.count, 1);
    const stats: HotDetectionStats = {
      swapsInWindow: windowStats.count,
      buys: windowStats.buys,
      sells: windowStats.sells,
      buyRatio,
      uniqueWallets: windowStats.uniqueWallets.size,
      windowActualMs: windowStats.windowActualMs,
      baselineSwapsPerMin: activity.baselineSwapsPerMin,
      isNewMomentum,
    };
    
    log.info(`🔥 HOT TOKEN DETECTED (Phase 1)`, {
      candidate: candidate.slice(0, 16) + '...',
      swaps: windowStats.count,
      buys: windowStats.buys,
      sells: windowStats.sells,
      buyRatio: (buyRatio * 100).toFixed(0) + '%',
      uniqueWallets: windowStats.uniqueWallets.size,
      windowMs: windowStats.windowActualMs,
      baselineSwapsPerMin: activity.baselineSwapsPerMin.toFixed(2),
      isNewMomentum,
    });
    
    // Log to JSONL for observability
    logEvent(LogEventType.PHASE1_HOT_TRIGGERED as any, {
      candidate,
      swapsInWindow: windowStats.count,
      windowActualMs: windowStats.windowActualMs,
      baselineSwapsPerMin: activity.baselineSwapsPerMin,
      isNewMomentum,
    });
    
    // Trigger callbacks (Phase 2 RPC verification)
    for (const callback of this.hotTokenCallbacks) {
      try {
        callback(candidate, stats);
      } catch (error) {
        log.error('Hot token callback error', error as Error);
      }
    }
    
    this.counters.phase2Started++;
  }
  
  /**
   * Mark a candidate as having Phase 2 in-flight
   */
  setInflight(candidate: string, promise: Promise<void>): void {
    this.inflightPhase2.set(candidate, promise);
    promise.finally(() => {
      this.inflightPhase2.delete(candidate);
    });
  }
  
  /**
   * Check if Phase 2 is in-flight for a candidate
   */
  isInflight(candidate: string): boolean {
    return this.inflightPhase2.has(candidate);
  }
  
  /**
   * Set cooldown for a candidate after Phase 2 result
   */
  setCooldown(candidate: string, reason: 'rejected' | 'success' | 'noise'): void {
    const now = Date.now();
    const existing = this.cooldowns.get(candidate);
    const attempts = existing ? existing.attempts + 1 : 1;
    
    let durationMs: number;
    switch (reason) {
      case 'rejected':
        durationMs = COOLDOWN_ON_REJECT_MS;
        this.counters.phase2Rejected++;
        break;
      case 'noise':
        durationMs = COOLDOWN_ON_NOISE_MS;
        this.counters.phase2Rejected++;
        break;
      case 'success':
        durationMs = COOLDOWN_ON_SUCCESS_MS;
        this.counters.phase2Success++;
        break;
    }
    
    this.cooldowns.set(candidate, {
      until: now + durationMs,
      reason,
      attempts,
    });
    
    log.debug('Phase 2 cooldown set', {
      candidate: candidate.slice(0, 16) + '...',
      reason,
      durationMs,
      attempts,
    });
  }
  
  /**
   * Get recent signatures for a candidate (for Phase 2 verification)
   */
  getRecentSignatures(candidate: string, limit: number = 5): string[] {
    const activity = this.tokenActivity.get(candidate);
    if (!activity) return [];
    
    const now = Date.now();
    const windowStart = now - this.hotTokenWindowMs;
    
    // Get signatures from within the window, most recent first
    return activity.swaps
      .filter(s => s.timestamp >= windowStart)
      .slice(-limit)
      .map(s => s.signature);
  }
  
  /**
   * Get current swap count in window for a token
   * Used by EventListener to determine enrichment rate
   */
  getTokenSwapCount(candidate: string): number {
    const activity = this.tokenActivity.get(candidate);
    if (!activity) return 0;
    
    const now = Date.now();
    const windowStart = now - this.hotTokenWindowMs;
    
    return activity.swaps.filter(s => s.timestamp >= windowStart).length;
  }
  
  /**
   * Get buffered swap data for a candidate (for Pump path - no tx parsing needed)
   */
  getBufferedSwaps(candidate: string): SwapRecord[] {
    const activity = this.tokenActivity.get(candidate);
    if (!activity) return [];
    
    const now = Date.now();
    const windowStart = now - this.hotTokenWindowMs;
    
    return activity.swaps.filter(s => s.timestamp >= windowStart);
  }
  
  /**
   * Cleanup old data
   */
  private cleanup(): void {
    const now = Date.now();
    const expireTime = now - Math.max(this.hotTokenWindowMs * 3, BASELINE_WINDOW_MS * 1.5);
    
    // Remove old token activity
    for (const [candidate, activity] of this.tokenActivity) {
      if (activity.lastSeen < expireTime) {
        this.tokenActivity.delete(candidate);
      }
    }
    
    // Remove expired cooldowns
    for (const [candidate, cooldown] of this.cooldowns) {
      if (cooldown.until < now) {
        this.cooldowns.delete(candidate);
      }
    }
    
    // Enforce max candidates limit
    if (this.tokenActivity.size > MAX_TRACKED_CANDIDATES) {
      const entries = Array.from(this.tokenActivity.entries());
      entries.sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      
      const toRemove = entries.slice(0, entries.length - MAX_TRACKED_CANDIDATES);
      for (const [candidate] of toRemove) {
        this.tokenActivity.delete(candidate);
      }
    }
  }
  
  /**
   * Get tracker statistics
   */
  getStats(): {
    trackedTokens: number;
    hotTokens: number;
    cooldownCount: number;
    inflightCount: number;
  } {
    return {
      trackedTokens: this.tokenActivity.size,
      hotTokens: this.inflightPhase2.size,
      cooldownCount: this.cooldowns.size,
      inflightCount: this.inflightPhase2.size,
    };
  }
  
  /**
   * Get and reset counters (for periodic logging)
   */
  getAndResetCounters(): typeof this.counters {
    const result = { ...this.counters };
    this.counters = {
      phase1CandidatesSeen: 0,
      phase2Started: 0,
      phase2Rejected: 0,
      phase2Success: 0,
      cooldownSkips: 0,
      inflightSkips: 0,
    };
    return result;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Hot Detection Stats (passed to callbacks)
// ═══════════════════════════════════════════════════════════════════

export interface HotDetectionStats {
  swapsInWindow: number;
  buys: number;
  sells: number;
  buyRatio: number;
  uniqueWallets: number;
  windowActualMs: number;
  baselineSwapsPerMin: number;
  isNewMomentum: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// Singleton
// ═══════════════════════════════════════════════════════════════════

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
