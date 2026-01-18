/**
 * Momentum Scoring Engine
 * Calculates composite momentum score from rolling window metrics.
 * 
 * DATA-BUDGET AWARE: Uses Phase 1 hotness data when available.
 * Phase 1 has MORE accurate swap counts than Phase 2 (which has sparse events).
 * 
 * The scoring now combines:
 * 1. Phase 1 hotness signal (swap count, buy ratio from logs)
 * 2. Phase 2 quality signal (unique wallets, sell simulation)
 * 3. Confidence scaling based on data quality
 */

import Decimal from 'decimal.js';
import { MomentumScore, TokenMetrics, WindowMetrics, LogEventType } from '../types';
import { TokenState } from '../universe/token-state';
import { getConfig } from '../config/config';
import { logEvent, log } from '../logging/logger';

// ═══════════════════════════════════════════════════════════════════
// DATA-BUDGET AWARE THRESHOLDS
// ═══════════════════════════════════════════════════════════════════

// Phase 1 swap count thresholds (more reliable than Phase 2)
const PHASE1_HOT_SWAP_COUNT = 15;     // Phase 1 says "hot" if > this in 30s
const PHASE1_VERY_HOT_SWAP_COUNT = 30; // Phase 1 says "very hot"

// Confidence scaling factors
const PHASE1_WEIGHT = 0.6;  // Phase 1 data (swap count, buy ratio)
const PHASE2_WEIGHT = 0.4;  // Phase 2 data (unique wallets, quality)

/**
 * Running statistics for z-score calculation
 * Maintains mean and variance incrementally using Welford's algorithm
 */
class RunningStats {
  private n = 0;
  private mean = 0;
  private m2 = 0; // Sum of squared differences
  
  /**
   * Add a new observation
   */
  update(value: number): void {
    this.n++;
    const delta = value - this.mean;
    this.mean += delta / this.n;
    const delta2 = value - this.mean;
    this.m2 += delta * delta2;
  }
  
  /**
   * Get current mean
   */
  getMean(): number {
    return this.mean;
  }
  
  /**
   * Get current standard deviation
   */
  getStdDev(): number {
    if (this.n < 2) return 1; // Avoid division by zero
    return Math.sqrt(this.m2 / (this.n - 1));
  }
  
  /**
   * Calculate z-score for a value
   */
  getZScore(value: number): number {
    const stdDev = this.getStdDev();
    if (stdDev === 0 || this.n < 2) {
      // Not enough data for meaningful z-score
      return 0;
    }
    // Allow early scoring while the stats are warming up.
    // This keeps paper/live behavior aligned without requiring 10+ samples.
    const z = (value - this.mean) / stdDev;
    // Clamp to reduce noise spikes from tiny sample sizes.
    return Math.max(-6, Math.min(6, z));
  }
  
  /**
   * Get observation count
   */
  getCount(): number {
    return this.n;
  }
}

/**
 * MomentumScorer calculates momentum scores for tokens
 * using z-scores of key metrics.
 */
export class MomentumScorer {
  // Global statistics for z-score normalization
  private swapCountStats = new RunningStats();
  private netInflowStats = new RunningStats();
  private uniqueBuyersStats = new RunningStats();
  private priceChangeStats = new RunningStats();
  
  // Track tokens that have crossed thresholds
  private aboveThresholdSince = new Map<string, number>();
  
  private config = getConfig();
  
  /**
   * Calculate momentum score for a token
   * 
   * DATA-BUDGET AWARE: Uses Phase 1 data when available for more accurate scoring.
   * Phase 1 captures ALL on-chain swaps, while Phase 2 only has sparse RPC-parsed events.
   */
  calculateScore(tokenState: TokenState): MomentumScore {
    const metrics = tokenState.getMetrics();
    const phase1 = tokenState.phase1Stats;
    
    // Use 15s window as primary signal (balance between noise and responsiveness)
    const window15s = metrics.windows['15s'];
    const window60s = metrics.windows['60s'];
    
    // ═══════════════════════════════════════════════════════════════
    // EFFECTIVE VALUES - Use Phase 1 data when available (more accurate)
    // ═══════════════════════════════════════════════════════════════
    
    // Swap count: Phase 1 is MORE accurate (sees all swaps from logs)
    const effectiveSwapCount = phase1 
      ? phase1.swapsInWindow  // Phase 1: actual swap count (e.g., 55)
      : window15s.swapCount;  // Phase 2: only parsed events (e.g., 3)
    
    // Net inflow: Phase 2 is placeholder (0.01 * N), scale based on Phase 1
    // Estimate real inflow from Phase 1 buy ratio * typical swap size
    const estimatedNotionalPerSwap = 0.5; // Conservative estimate: 0.5 SOL avg
    const effectiveNetInflow = phase1
      ? phase1.buys * estimatedNotionalPerSwap - phase1.sells * estimatedNotionalPerSwap
      : window15s.netInflow.toNumber();
    
    // Unique buyers: Phase 2 now excludes 'unknown' wallets (may be 0)
    // If Phase 1 is hot with many swaps, assume reasonable buyer diversity
    const phase2UniqueBuyers = window60s.uniqueBuyers.size;
    const estimatedUniqueBuyers = phase1 && phase2UniqueBuyers === 0
      ? Math.min(Math.floor(phase1.swapsInWindow / 3), 10) // Estimate: 1 buyer per 3 swaps, max 10
      : phase2UniqueBuyers;
    
    const priceChange = window60s.priceChangePercent;
    
    // Update running statistics with effective values
    this.swapCountStats.update(effectiveSwapCount);
    this.netInflowStats.update(effectiveNetInflow);
    this.uniqueBuyersStats.update(estimatedUniqueBuyers);
    this.priceChangeStats.update(priceChange);
    
    // Calculate z-scores
    const swapCountZScore = this.swapCountStats.getZScore(effectiveSwapCount);
    const netInflowZScore = this.netInflowStats.getZScore(effectiveNetInflow);
    const uniqueBuyersZScore = this.uniqueBuyersStats.getZScore(estimatedUniqueBuyers);
    const priceChangeZScore = this.priceChangeStats.getZScore(priceChange);
    
    // ═══════════════════════════════════════════════════════════════
    // COMBINED SCORING: Phase 1 hotness + Phase 2 z-scores
    // ═══════════════════════════════════════════════════════════════
    
    // Phase 1 hotness score (direct, not z-score based)
    let phase1HotnessScore = 0;
    if (phase1) {
      // Scale swap count to a 0-3 score
      if (phase1.swapsInWindow >= PHASE1_VERY_HOT_SWAP_COUNT) {
        phase1HotnessScore = 3.0;
      } else if (phase1.swapsInWindow >= PHASE1_HOT_SWAP_COUNT) {
        phase1HotnessScore = 2.0;
      } else if (phase1.swapsInWindow >= 5) {
        phase1HotnessScore = 1.0;
      }
      
      // Boost for strong buy ratio
      if (phase1.buyRatio >= 0.8) {
        phase1HotnessScore *= 1.2;
      }
      
      // Boost for new momentum (quiet → hot transition)
      if (phase1.isNewMomentum) {
        phase1HotnessScore *= 1.1;
      }
    }
    
    // Phase 2 z-score based score
    const phase2ZScore = 
      this.config.weights.swapCount * swapCountZScore +
      this.config.weights.netInflow * netInflowZScore +
      this.config.weights.uniqueBuyers * uniqueBuyersZScore +
      this.config.weights.priceChange * priceChangeZScore;
    
    // Combined score: weight Phase 1 higher when we have it
    const totalScore = phase1
      ? PHASE1_WEIGHT * phase1HotnessScore + PHASE2_WEIGHT * phase2ZScore
      : phase2ZScore;
    
    const isAboveEntryThreshold = totalScore >= this.config.entryThreshold;
    const isAboveExitThreshold = totalScore >= this.config.exitThreshold;
    
    // Track confirmation time
    const now = Date.now();
    let consecutiveAboveEntry = 0;
    
    if (isAboveEntryThreshold) {
      if (!this.aboveThresholdSince.has(metrics.tokenMint)) {
        this.aboveThresholdSince.set(metrics.tokenMint, now);
        
        // Enhanced logging with Phase 1 data
        logEvent(LogEventType.MOMENTUM_THRESHOLD_CROSSED, {
          tokenMint: metrics.tokenMint,
          score: totalScore,
          direction: 'above_entry',
          threshold: this.config.entryThreshold,
          phase1HotnessScore: phase1 ? phase1HotnessScore : null,
          phase2ZScore,
          effectiveSwapCount,
          estimatedUniqueBuyers,
        });
        
        // Log confidence scoring details for observability
        log.info(`📊 PHASE2_CONFIDENCE`, {
          token: metrics.tokenMint.slice(0, 16) + '...',
          phase1: phase1 ? {
            swaps: phase1.swapsInWindow,
            buys: phase1.buys,
            buyRatio: (phase1.buyRatio * 100).toFixed(0) + '%',
            isNewMomentum: phase1.isNewMomentum,
            hotnessScore: phase1HotnessScore.toFixed(2),
          } : 'none',
          phase2: {
            swaps: window15s.swapCount,
            uniqueBuyers: phase2UniqueBuyers,
            zScore: phase2ZScore.toFixed(2),
          },
          combined: {
            score: totalScore.toFixed(2),
            threshold: this.config.entryThreshold,
          },
        });
      }
      consecutiveAboveEntry = (now - this.aboveThresholdSince.get(metrics.tokenMint)!) / 1000;
    } else {
      if (this.aboveThresholdSince.has(metrics.tokenMint)) {
        logEvent(LogEventType.MOMENTUM_THRESHOLD_CROSSED, {
          tokenMint: metrics.tokenMint,
          score: totalScore,
          direction: 'below_entry',
          threshold: this.config.entryThreshold,
        });
      }
      this.aboveThresholdSince.delete(metrics.tokenMint);
    }
    
    // Update token state tracking
    tokenState.updateAboveEntryTracking(isAboveEntryThreshold);
    tokenState.updateNegativeInflowTracking(window15s.netInflow);
    
    return {
      tokenMint: metrics.tokenMint,
      timestamp: now,
      totalScore,
      components: {
        swapCountZScore,
        netInflowZScore,
        uniqueBuyersZScore,
        priceChangeZScore,
      },
      isAboveEntryThreshold,
      isAboveExitThreshold,
      consecutiveAboveEntry,
    };
  }
  
  /**
   * Check if token is ready for entry (confirmed momentum)
   */
  isEntryReady(score: MomentumScore): boolean {
    return score.isAboveEntryThreshold && 
           score.consecutiveAboveEntry >= this.config.confirmationSeconds;
  }
  
  /**
   * Check if token should be exited
   */
  shouldExit(score: MomentumScore, tokenState: TokenState): {
    shouldExit: boolean;
    reason: 'momentum_decay' | 'flow_reversal' | null;
  } {
    // Check momentum decay
    if (!score.isAboveExitThreshold) {
      return { shouldExit: true, reason: 'momentum_decay' };
    }
    
    // Check flow reversal (negative inflow for N seconds)
    const metrics = tokenState.getMetrics();
    const netInflow15s = metrics.windows['15s'].netInflow;
    
    if (netInflow15s.lt(0) && tokenState.consecutiveNegativeInflowSeconds >= 5) {
      return { shouldExit: true, reason: 'flow_reversal' };
    }
    
    return { shouldExit: false, reason: null };
  }
  
  /**
   * Get diagnostic info for a token
   */
  getDiagnostics(tokenState: TokenState): {
    score: MomentumScore;
    metrics: TokenMetrics;
    statsHealth: {
      swapCountObservations: number;
      netInflowObservations: number;
      uniqueBuyersObservations: number;
      priceChangeObservations: number;
    };
  } {
    const score = this.calculateScore(tokenState);
    const metrics = tokenState.getMetrics();
    
    return {
      score,
      metrics,
      statsHealth: {
        swapCountObservations: this.swapCountStats.getCount(),
        netInflowObservations: this.netInflowStats.getCount(),
        uniqueBuyersObservations: this.uniqueBuyersStats.getCount(),
        priceChangeObservations: this.priceChangeStats.getCount(),
      },
    };
  }
  
  /**
   * Reset all statistics (for testing or recalibration)
   */
  reset(): void {
    this.swapCountStats = new RunningStats();
    this.netInflowStats = new RunningStats();
    this.uniqueBuyersStats = new RunningStats();
    this.priceChangeStats = new RunningStats();
    this.aboveThresholdSince.clear();
  }
  
  /**
   * Get global statistics summary
   */
  getStatsSummary(): {
    observationCount: number;
    swapCountMean: number;
    netInflowMean: number;
    uniqueBuyersMean: number;
    priceChangeMean: number;
  } {
    return {
      observationCount: this.swapCountStats.getCount(),
      swapCountMean: this.swapCountStats.getMean(),
      netInflowMean: this.netInflowStats.getMean(),
      uniqueBuyersMean: this.uniqueBuyersStats.getMean(),
      priceChangeMean: this.priceChangeStats.getMean(),
    };
  }
}

// Singleton instance
let scorerInstance: MomentumScorer | null = null;

export function getMomentumScorer(): MomentumScorer {
  if (!scorerInstance) {
    scorerInstance = new MomentumScorer();
  }
  return scorerInstance;
}

export function resetMomentumScorer(): void {
  if (scorerInstance) {
    scorerInstance.reset();
  }
  scorerInstance = null;
}
