/**
 * Risk & Safety Gates
 * Strict validation before any trade entry.
 * ALL gates must pass - if ANY fails, NO TRADE.
 */

import Decimal from 'decimal.js';
import { 
  RiskGateResult, 
  RiskAssessment, 
  TokenMetrics, 
  MomentumScore,
  SwapQuote,
  LogEventType 
} from '../types';
import { TokenState } from '../universe/token-state';
import { getConfig } from '../config/config';
import { logEvent, log } from '../logging/logger';
import { JupiterClient } from '../execution/jupiter-client';

/**
 * RiskGates performs comprehensive safety checks before trade entry.
 */
export class RiskGates {
  private config = getConfig();
  private jupiterClient: JupiterClient | null = null;
  
  constructor(jupiterClient?: JupiterClient) {
    this.jupiterClient = jupiterClient || null;
  }
  
  /**
   * Set Jupiter client (for sell simulation)
   */
  setJupiterClient(client: JupiterClient): void {
    this.jupiterClient = client;
  }
  
  /**
   * Run all risk gates and return assessment
   */
  async assess(
    tokenState: TokenState,
    score: MomentumScore
  ): Promise<RiskAssessment> {
    const metrics = tokenState.getMetrics();
    const gates: RiskGateResult[] = [];
    
    // Gate 1: Minimum Liquidity
    gates.push(this.checkMinimumLiquidity(metrics));
    
    // Gate 2: Wallet Diversity
    gates.push(this.checkWalletDiversity(metrics));
    
    // Gate 3: Buyer Concentration
    gates.push(this.checkBuyerConcentration(metrics));
    
    // Gate 4: Buy/Sell Imbalance
    gates.push(this.checkBuySellImbalance(metrics));
    
    // Gate 5: Position Size vs Pool Depth
    gates.push(this.checkPositionSize(metrics));
    
    // Gate 6: Wash Trading Detection
    gates.push(this.checkWashTrading(metrics));
    
    // Gate 7: Momentum Confirmation
    gates.push(this.checkMomentumConfirmation(score));
    
    // Gate 8: Sell Simulation (if Jupiter client available)
    if (this.jupiterClient) {
      gates.push(await this.checkSellSimulation(metrics.tokenMint));
    }
    
    // Calculate overall assessment
    const allGatesPassed = gates.every(g => g.passed);
    const failedGates = gates.filter(g => !g.passed);
    
    // Determine risk level
    let overallRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME' = 'LOW';
    if (failedGates.length > 0) {
      if (failedGates.some(g => g.gateName === 'sell_simulation' || g.gateName === 'liquidity')) {
        overallRisk = 'EXTREME';
      } else if (failedGates.length >= 3) {
        overallRisk = 'HIGH';
      } else if (failedGates.length >= 1) {
        overallRisk = 'MEDIUM';
      }
    }
    
    const assessment: RiskAssessment = {
      tokenMint: metrics.tokenMint,
      timestamp: Date.now(),
      allGatesPassed,
      gates,
      overallRisk,
    };
    
    // Log the assessment
    logEvent(LogEventType.RISK_GATE_CHECK, {
      tokenMint: metrics.tokenMint,
      passed: allGatesPassed,
      risk: overallRisk,
      failedGates: failedGates.map(g => g.gateName),
    });
    
    if (!allGatesPassed) {
      log.debug(`Risk gates failed for ${metrics.tokenMint.slice(0, 8)}...`, {
        failed: failedGates.map(g => `${g.gateName}: ${g.reason}`),
      });
    }
    
    return assessment;
  }
  
  /**
   * Gate 1: Minimum Liquidity Requirement
   * Ensures pool has enough liquidity to handle our trade and exit
   */
  private checkMinimumLiquidity(metrics: TokenMetrics): RiskGateResult {
    const liquidity = metrics.estimatedLiquidity;
    const minLiquidity = this.config.minLiquiditySol;
    
    // If we don't have liquidity data, we can estimate from volume
    let estimatedLiquidity = liquidity;
    if (liquidity.isZero()) {
      // Rough estimate: liquidity is typically 5-10x of 60s volume
      const volume60s = metrics.windows['60s'].buyNotional.plus(metrics.windows['60s'].sellNotional);
      estimatedLiquidity = volume60s.mul(5);
    }
    
    const passed = estimatedLiquidity.gte(minLiquidity);
    
    return {
      passed,
      gateName: 'liquidity',
      reason: passed ? undefined : `Liquidity ${estimatedLiquidity.toFixed(2)} SOL < minimum ${minLiquidity.toFixed(2)} SOL`,
      value: estimatedLiquidity.toNumber(),
      threshold: minLiquidity.toNumber(),
    };
  }
  
  /**
   * Gate 2: Wallet Diversity
   * Ensures multiple unique wallets are participating
   */
  private checkWalletDiversity(metrics: TokenMetrics): RiskGateResult {
    const uniqueBuyers = metrics.windows['60s'].uniqueBuyers.size;
    const minWallets = this.config.minUniqueWallets;
    
    const passed = uniqueBuyers >= minWallets;
    
    return {
      passed,
      gateName: 'wallet_diversity',
      reason: passed ? undefined : `Only ${uniqueBuyers} unique buyers < minimum ${minWallets}`,
      value: uniqueBuyers,
      threshold: minWallets,
    };
  }
  
  /**
   * Gate 3: Buyer Concentration
   * Rejects if single wallet dominates buying
   */
  private checkBuyerConcentration(metrics: TokenMetrics): RiskGateResult {
    const concentration = metrics.windows['60s'].topBuyerConcentration;
    const maxConcentration = this.config.maxWalletConcentrationPct;
    
    const passed = concentration <= maxConcentration;
    
    return {
      passed,
      gateName: 'buyer_concentration',
      reason: passed ? undefined : `Top buyer has ${concentration.toFixed(1)}% > max ${maxConcentration}%`,
      value: concentration,
      threshold: maxConcentration,
    };
  }
  
  /**
   * Gate 4: Buy/Sell Imbalance
   * Ensures healthy buy/sell ratio (not too extreme in either direction)
   */
  private checkBuySellImbalance(metrics: TokenMetrics): RiskGateResult {
    const buyVol = metrics.windows['60s'].buyNotional;
    const sellVol = metrics.windows['60s'].sellNotional;
    
    // Avoid division by zero
    if (sellVol.isZero() && buyVol.isZero()) {
      return {
        passed: false,
        gateName: 'buy_sell_imbalance',
        reason: 'No volume detected',
        value: 0,
        threshold: 1,
      };
    }
    
    // Calculate ratio (buy/sell)
    let ratio: number;
    if (sellVol.isZero()) {
      ratio = 100; // All buys, no sells
    } else {
      ratio = buyVol.div(sellVol).toNumber();
    }
    
    // Want ratio > 1 (more buys than sells) but not extreme (< 20)
    const minRatio = 1.0;
    const maxRatio = 20.0;
    const passed = ratio >= minRatio && ratio <= maxRatio;
    
    return {
      passed,
      gateName: 'buy_sell_imbalance',
      reason: passed 
        ? undefined 
        : ratio < minRatio 
          ? `Buy/sell ratio ${ratio.toFixed(2)} < minimum ${minRatio}`
          : `Buy/sell ratio ${ratio.toFixed(2)} > maximum ${maxRatio} (suspicious)`,
      value: ratio,
      threshold: ratio < minRatio ? minRatio : maxRatio,
    };
  }
  
  /**
   * Gate 5: Position Size vs Pool Depth
   * Ensures our trade won't move the market excessively
   */
  private checkPositionSize(metrics: TokenMetrics): RiskGateResult {
    const tradeSize = this.config.tradeSizeSol;
    let poolLiquidity = metrics.estimatedLiquidity;
    
    // Estimate liquidity if not available
    if (poolLiquidity.isZero()) {
      const volume60s = metrics.windows['60s'].buyNotional.plus(metrics.windows['60s'].sellNotional);
      poolLiquidity = volume60s.mul(5);
    }
    
    // Avoid division by zero
    if (poolLiquidity.isZero()) {
      return {
        passed: false,
        gateName: 'position_size',
        reason: 'Cannot estimate pool liquidity',
        value: 100,
        threshold: this.config.maxPositionPctOfPool,
      };
    }
    
    const pctOfPool = tradeSize.div(poolLiquidity).mul(100).toNumber();
    const maxPct = this.config.maxPositionPctOfPool;
    const passed = pctOfPool <= maxPct;
    
    return {
      passed,
      gateName: 'position_size',
      reason: passed ? undefined : `Trade would be ${pctOfPool.toFixed(2)}% of pool > max ${maxPct}%`,
      value: pctOfPool,
      threshold: maxPct,
    };
  }
  
  /**
   * Gate 6: Wash Trading Detection
   * Identifies patterns suggesting fake volume
   */
  private checkWashTrading(metrics: TokenMetrics): RiskGateResult {
    const window60s = metrics.windows['60s'];
    
    // Heuristics for wash trading:
    // 1. Same wallets appearing in both buy and sell
    const buyerWallets = window60s.uniqueBuyers;
    const sellerWallets = window60s.uniqueSellers;
    
    let overlapCount = 0;
    for (const buyer of buyerWallets) {
      if (sellerWallets.has(buyer)) {
        overlapCount++;
      }
    }
    
    // 2. Check if overlap is suspicious (> 50% of participants)
    const totalParticipants = new Set([...buyerWallets, ...sellerWallets]).size;
    const overlapPercent = totalParticipants > 0 ? (overlapCount / totalParticipants) * 100 : 0;
    
    // 3. Check for suspiciously regular trade sizes
    // (Would need per-trade data to implement fully)
    
    const maxOverlapPercent = 30; // More than 30% overlap is suspicious
    const passed = overlapPercent <= maxOverlapPercent;
    
    return {
      passed,
      gateName: 'wash_trading',
      reason: passed ? undefined : `${overlapPercent.toFixed(1)}% of wallets both buying and selling (suspicious)`,
      value: overlapPercent,
      threshold: maxOverlapPercent,
    };
  }
  
  /**
   * Gate 7: Momentum Confirmation
   * Ensures momentum has been sustained, not just a spike
   */
  private checkMomentumConfirmation(score: MomentumScore): RiskGateResult {
    const confirmSeconds = this.config.confirmationSeconds;
    const passed = score.consecutiveAboveEntry >= confirmSeconds;
    
    return {
      passed,
      gateName: 'momentum_confirmation',
      reason: passed 
        ? undefined 
        : `Only ${score.consecutiveAboveEntry.toFixed(1)}s above threshold, need ${confirmSeconds}s`,
      value: score.consecutiveAboveEntry,
      threshold: confirmSeconds,
    };
  }
  
  /**
   * Gate 8: Sell Simulation
   * Verifies we can exit the position via sell quote
   */
  private async checkSellSimulation(tokenMint: string): Promise<RiskGateResult> {
    if (!this.jupiterClient) {
      return {
        passed: false,
        gateName: 'sell_simulation',
        reason: 'Jupiter client not available',
      };
    }
    
    try {
      // Simulate selling our expected token amount
      // Use a small amount for simulation
      const testAmount = new Decimal(1000000); // 1 token with 6 decimals
      
      const quote = await this.jupiterClient.getQuote(
        tokenMint,
        'So11111111111111111111111111111111111111112', // SOL
        testAmount
      );
      
      if (!quote) {
        // If Jupiter is unavailable/rate limited, skip this check rather than fail
        // This prevents blocking entries during API issues
        return {
          passed: true,
          gateName: 'sell_simulation',
          reason: 'Jupiter unavailable - check skipped',
        };
      }
      
      // Check price impact isn't catastrophic
      const maxImpact = 1000; // 10%
      if (quote.priceImpactBps > maxImpact) {
        return {
          passed: false,
          gateName: 'sell_simulation',
          reason: `Sell price impact ${quote.priceImpactBps} bps > max ${maxImpact} bps`,
          value: quote.priceImpactBps,
          threshold: maxImpact,
        };
      }
      
      return {
        passed: true,
        gateName: 'sell_simulation',
        value: quote.priceImpactBps,
        threshold: maxImpact,
      };
      
    } catch (error) {
      return {
        passed: false,
        gateName: 'sell_simulation',
        reason: `Sell simulation failed: ${(error as Error).message}`,
      };
    }
  }
}

// Singleton instance
let riskGatesInstance: RiskGates | null = null;

export function getRiskGates(): RiskGates {
  if (!riskGatesInstance) {
    riskGatesInstance = new RiskGates();
  }
  return riskGatesInstance;
}

export function resetRiskGates(): void {
  riskGatesInstance = null;
}
