/**
 * Analytics Engine
 * Aggregates token analytics and provides computed metrics.
 */

import Decimal from 'decimal.js';
import { TokenState } from '../universe/token-state';
import { TokenMetrics, WindowMetrics, WindowSize } from '../types';

/**
 * Computed analytics for a token across all windows.
 */
export interface TokenAnalytics {
  tokenMint: string;
  
  // Activity metrics
  activityLevel: 'dormant' | 'low' | 'moderate' | 'high' | 'extreme';
  swapVelocity: number; // swaps per minute
  
  // Flow metrics
  netFlowDirection: 'inflow' | 'outflow' | 'neutral';
  flowMagnitude: Decimal;
  flowAcceleration: number; // change in flow rate
  
  // Participation metrics
  participationScore: number; // 0-100
  walletDiversityIndex: number; // unique wallets / total swaps
  
  // Price action
  priceVolatility: number;
  priceTrend: 'up' | 'down' | 'flat';
  
  // Health indicators
  healthScore: number; // 0-100 composite health
  redFlags: string[];
}

/**
 * AnalyticsEngine computes derived metrics from raw window data.
 */
export class AnalyticsEngine {
  /**
   * Compute full analytics for a token
   */
  computeAnalytics(tokenState: TokenState): TokenAnalytics {
    const metrics = tokenState.getMetrics();
    
    // Compute individual components
    const activityLevel = this.computeActivityLevel(metrics);
    const swapVelocity = this.computeSwapVelocity(metrics);
    const flowAnalysis = this.analyzeFlow(metrics);
    const participationScore = this.computeParticipationScore(metrics);
    const walletDiversityIndex = this.computeWalletDiversity(metrics);
    const priceAnalysis = this.analyzePriceAction(metrics);
    const healthScore = this.computeHealthScore(metrics);
    const redFlags = this.detectRedFlags(metrics);
    
    return {
      tokenMint: metrics.tokenMint,
      activityLevel,
      swapVelocity,
      netFlowDirection: flowAnalysis.direction,
      flowMagnitude: flowAnalysis.magnitude,
      flowAcceleration: flowAnalysis.acceleration,
      participationScore,
      walletDiversityIndex,
      priceVolatility: priceAnalysis.volatility,
      priceTrend: priceAnalysis.trend,
      healthScore,
      redFlags,
    };
  }
  
  /**
   * Determine activity level based on swap frequency
   */
  private computeActivityLevel(
    metrics: TokenMetrics
  ): 'dormant' | 'low' | 'moderate' | 'high' | 'extreme' {
    const swaps60s = metrics.windows['60s'].swapCount;
    
    if (swaps60s === 0) return 'dormant';
    if (swaps60s < 5) return 'low';
    if (swaps60s < 20) return 'moderate';
    if (swaps60s < 50) return 'high';
    return 'extreme';
  }
  
  /**
   * Calculate swaps per minute
   */
  private computeSwapVelocity(metrics: TokenMetrics): number {
    const window = metrics.windows['60s'];
    const durationMs = window.lastTimestamp - window.firstTimestamp;
    
    if (durationMs <= 0) return 0;
    
    return (window.swapCount / durationMs) * 60_000;
  }
  
  /**
   * Analyze capital flow
   */
  private analyzeFlow(metrics: TokenMetrics): {
    direction: 'inflow' | 'outflow' | 'neutral';
    magnitude: Decimal;
    acceleration: number;
  } {
    const net15s = metrics.windows['15s'].netInflow;
    const net60s = metrics.windows['60s'].netInflow;
    
    // Direction based on 15s window
    let direction: 'inflow' | 'outflow' | 'neutral';
    if (net15s.gt(0.01)) {
      direction = 'inflow';
    } else if (net15s.lt(-0.01)) {
      direction = 'outflow';
    } else {
      direction = 'neutral';
    }
    
    // Magnitude is absolute value
    const magnitude = net15s.abs();
    
    // Acceleration: compare 15s to 60s rate
    const rate15s = net15s.div(15); // per second
    const rate60s = net60s.div(60); // per second
    
    let acceleration = 0;
    if (!rate60s.isZero()) {
      acceleration = rate15s.minus(rate60s).div(rate60s.abs()).toNumber();
    }
    
    return { direction, magnitude, acceleration };
  }
  
  /**
   * Compute participation score (0-100)
   */
  private computeParticipationScore(metrics: TokenMetrics): number {
    const buyers = metrics.windows['60s'].uniqueBuyers.size;
    const sellers = metrics.windows['60s'].uniqueSellers.size;
    const totalParticipants = new Set([
      ...metrics.windows['60s'].uniqueBuyers,
      ...metrics.windows['60s'].uniqueSellers,
    ]).size;
    
    // Score based on participant count and buy/sell participation
    const participantScore = Math.min(totalParticipants / 20 * 50, 50);
    const balanceScore = Math.min(buyers, sellers) / Math.max(buyers, sellers, 1) * 50;
    
    return Math.round(participantScore + balanceScore);
  }
  
  /**
   * Compute wallet diversity index
   */
  private computeWalletDiversity(metrics: TokenMetrics): number {
    const uniqueWallets = new Set([
      ...metrics.windows['60s'].uniqueBuyers,
      ...metrics.windows['60s'].uniqueSellers,
    ]).size;
    
    const totalSwaps = metrics.windows['60s'].swapCount;
    
    if (totalSwaps === 0) return 0;
    
    return uniqueWallets / totalSwaps;
  }
  
  /**
   * Analyze price action
   */
  private analyzePriceAction(metrics: TokenMetrics): {
    volatility: number;
    trend: 'up' | 'down' | 'flat';
  } {
    const priceChange60s = metrics.windows['60s'].priceChangePercent;
    const priceChange15s = metrics.windows['15s'].priceChangePercent;
    
    // Volatility approximation (would need price series for true volatility)
    const volatility = Math.abs(priceChange60s);
    
    // Trend based on recent price change
    let trend: 'up' | 'down' | 'flat';
    if (priceChange15s > 1) {
      trend = 'up';
    } else if (priceChange15s < -1) {
      trend = 'down';
    } else {
      trend = 'flat';
    }
    
    return { volatility, trend };
  }
  
  /**
   * Compute overall health score (0-100)
   */
  private computeHealthScore(metrics: TokenMetrics): number {
    let score = 100;
    
    const window60s = metrics.windows['60s'];
    
    // Penalize low liquidity (if we have estimate)
    if (metrics.estimatedLiquidity.lt(5)) {
      score -= 20;
    }
    
    // Penalize low participant diversity
    const totalParticipants = new Set([
      ...window60s.uniqueBuyers,
      ...window60s.uniqueSellers,
    ]).size;
    if (totalParticipants < 3) {
      score -= 30;
    } else if (totalParticipants < 5) {
      score -= 15;
    }
    
    // Penalize high concentration
    if (window60s.topBuyerConcentration > 70) {
      score -= 30;
    } else if (window60s.topBuyerConcentration > 50) {
      score -= 15;
    }
    
    // Penalize imbalanced buy/sell ratio
    const buyVol = window60s.buyNotional;
    const sellVol = window60s.sellNotional;
    if (!sellVol.isZero()) {
      const ratio = buyVol.div(sellVol).toNumber();
      if (ratio > 20 || ratio < 0.05) {
        score -= 20;
      }
    } else if (buyVol.gt(0)) {
      // All buys, no sells - suspicious
      score -= 15;
    }
    
    return Math.max(0, score);
  }
  
  /**
   * Detect red flags
   */
  private detectRedFlags(metrics: TokenMetrics): string[] {
    const flags: string[] = [];
    const window60s = metrics.windows['60s'];
    
    // Single wallet dominance
    if (window60s.topBuyerConcentration > 80) {
      flags.push('Single wallet dominance (>80%)');
    }
    
    // Potential wash trading
    const buyers = window60s.uniqueBuyers;
    const sellers = window60s.uniqueSellers;
    let overlapCount = 0;
    for (const buyer of buyers) {
      if (sellers.has(buyer)) overlapCount++;
    }
    const totalUnique = new Set([...buyers, ...sellers]).size;
    if (totalUnique > 0 && (overlapCount / totalUnique) > 0.4) {
      flags.push('Possible wash trading (>40% wallet overlap)');
    }
    
    // Very low participants
    if (buyers.size < 2 && window60s.swapCount > 10) {
      flags.push('Very few unique buyers despite high activity');
    }
    
    // Extreme buy/sell imbalance
    if (!window60s.sellNotional.isZero()) {
      const ratio = window60s.buyNotional.div(window60s.sellNotional).toNumber();
      if (ratio > 50) {
        flags.push('Extreme buy/sell imbalance (>50:1)');
      }
    }
    
    // All buys with significant volume
    if (window60s.sellCount === 0 && 
        window60s.buyCount > 20 && 
        window60s.buyNotional.gt(1)) {
      flags.push('No sells despite significant buy volume');
    }
    
    return flags;
  }
  
  /**
   * Compare two tokens by momentum potential
   */
  compareTokens(a: TokenState, b: TokenState): number {
    const analyticsA = this.computeAnalytics(a);
    const analyticsB = this.computeAnalytics(b);
    
    // Compare by health score first
    const healthDiff = analyticsB.healthScore - analyticsA.healthScore;
    if (Math.abs(healthDiff) > 10) {
      return healthDiff;
    }
    
    // Then by flow magnitude
    return analyticsB.flowMagnitude.minus(analyticsA.flowMagnitude).toNumber();
  }
  
  /**
   * Rank tokens by opportunity quality
   */
  rankTokens(tokens: TokenState[]): TokenState[] {
    return tokens.sort((a, b) => this.compareTokens(a, b));
  }
}

// Singleton
let engineInstance: AnalyticsEngine | null = null;

export function getAnalyticsEngine(): AnalyticsEngine {
  if (!engineInstance) {
    engineInstance = new AnalyticsEngine();
  }
  return engineInstance;
}
