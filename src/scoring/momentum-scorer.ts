/**
 * Momentum Scoring Engine
 * Calculates composite momentum score from rolling window metrics.
 * Uses z-scores for cross-token comparability.
 */

import Decimal from 'decimal.js';
import { MomentumScore, TokenMetrics, WindowMetrics, LogEventType } from '../types';
import { TokenState } from '../universe/token-state';
import { getConfig } from '../config/config';
import { logEvent, log } from '../logging/logger';

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
   */
  calculateScore(tokenState: TokenState): MomentumScore {
    const metrics = tokenState.getMetrics();
    
    // Use 15s window as primary signal (balance between noise and responsiveness)
    const window15s = metrics.windows['15s'];
    const window60s = metrics.windows['60s'];
    
    // Extract raw values
    const swapCount = window15s.swapCount;
    const netInflow = window15s.netInflow.toNumber();
    const uniqueBuyers = window60s.uniqueBuyers.size;
    const priceChange = window60s.priceChangePercent;
    
    // Update running statistics
    this.swapCountStats.update(swapCount);
    this.netInflowStats.update(netInflow);
    this.uniqueBuyersStats.update(uniqueBuyers);
    this.priceChangeStats.update(priceChange);
    
    // Calculate z-scores
    const swapCountZScore = this.swapCountStats.getZScore(swapCount);
    const netInflowZScore = this.netInflowStats.getZScore(netInflow);
    const uniqueBuyersZScore = this.uniqueBuyersStats.getZScore(uniqueBuyers);
    const priceChangeZScore = this.priceChangeStats.getZScore(priceChange);
    
    // Calculate weighted score
    const totalScore = 
      this.config.weights.swapCount * swapCountZScore +
      this.config.weights.netInflow * netInflowZScore +
      this.config.weights.uniqueBuyers * uniqueBuyersZScore +
      this.config.weights.priceChange * priceChangeZScore;
    
    const isAboveEntryThreshold = totalScore >= this.config.entryThreshold;
    const isAboveExitThreshold = totalScore >= this.config.exitThreshold;
    
    // Track confirmation time
    const now = Date.now();
    let consecutiveAboveEntry = 0;
    
    if (isAboveEntryThreshold) {
      if (!this.aboveThresholdSince.has(metrics.tokenMint)) {
        this.aboveThresholdSince.set(metrics.tokenMint, now);
        
        logEvent(LogEventType.MOMENTUM_THRESHOLD_CROSSED, {
          tokenMint: metrics.tokenMint,
          score: totalScore,
          direction: 'above_entry',
          threshold: this.config.entryThreshold,
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
