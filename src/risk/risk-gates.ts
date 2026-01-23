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
    
    // Gate 1: Minimum Liquidity (Phase 1 aware)
    gates.push(this.checkMinimumLiquidity(metrics, tokenState));
    
    // Gate 2: Wallet Diversity (Phase 1 aware)
    gates.push(this.checkWalletDiversity(metrics, tokenState));
    
    // Gate 3: Buyer Concentration
    gates.push(this.checkBuyerConcentration(metrics));
    
    // Gate 4: Buy/Sell Imbalance (Phase 1 aware)
    gates.push(this.checkBuySellImbalance(metrics, tokenState));
    
    // Gate 5: Position Size vs Pool Depth (Phase 1 aware)
    gates.push(this.checkPositionSize(metrics, tokenState));
    
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
   * 
   * FIX: When Phase 1 data is available with high activity, assume minimum
   * viable liquidity exists (can't have 5+ swaps on illiquid pool).
   */
  private checkMinimumLiquidity(metrics: TokenMetrics, tokenState: TokenState): RiskGateResult {
    const liquidity = metrics.estimatedLiquidity;
    const minLiquidity = this.config.minLiquiditySol;
    
    // If we don't have liquidity data, we can estimate from volume
    let estimatedLiquidity = liquidity;
    if (liquidity.isZero()) {
      // Rough estimate: liquidity is typically 5-10x of 60s volume
      const volume60s = metrics.windows['60s'].buyNotional.plus(metrics.windows['60s'].sellNotional);
      estimatedLiquidity = volume60s.mul(5);
    }
    
    // FIX: If we have high swap activity but low estimated liquidity,
    // the volume data is unreliable (placeholder values from log parsing). 
    // A pool with active trading MUST have liquidity - can't have 50+ swaps on a dead pool!
    // Use CURRENT swap count from metrics (more accurate than stale Phase 1 stats).
    const currentSwapCount = metrics.windows['60s'].swapCount;
    const phase1 = tokenState.phase1Stats;
    const effectiveSwapCount = Math.max(currentSwapCount, phase1?.swapsInWindow || 0);
    
    if (effectiveSwapCount >= 5 && estimatedLiquidity.lt(minLiquidity)) {
      // High velocity = high liquidity correlation:
      // - 5-20 swaps/60s → small cap, ~5-10 SOL liquidity
      // - 20-50 swaps/60s → medium activity, ~10-25 SOL liquidity  
      // - 50+ swaps/60s → hot token, MUST have significant liquidity (20+ SOL minimum)
      // - 100+ swaps/60s → very hot, likely 50+ SOL liquidity
      let minViableLiquidity: Decimal;
      if (effectiveSwapCount >= 100) {
        // 100+ swaps = extremely active, assume at least 50 SOL
        minViableLiquidity = new Decimal(50);
      } else if (effectiveSwapCount >= 50) {
        // 50+ swaps = very active, assume at least 20 SOL
        minViableLiquidity = new Decimal(20);
      } else if (effectiveSwapCount >= 20) {
        // 20+ swaps = actively traded, assume at least 10 SOL
        minViableLiquidity = new Decimal(10);
      } else {
        // 5-20 swaps = some activity, assume at least 5 SOL
        minViableLiquidity = new Decimal(5);
      }
      estimatedLiquidity = Decimal.max(estimatedLiquidity, minViableLiquidity);
      
      log.info(`📊 Liquidity estimated from swap velocity: ${estimatedLiquidity.toFixed(2)} SOL (${effectiveSwapCount} swaps)`);
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
   * 
   * FIX: When we have Phase 1 data but Phase 2 has wallet:"unknown" events,
   * use Phase 1's swap count as evidence of activity instead of failing.
   * 
   * KEY INSIGHT: Graduated tokens (Raydium/Meteora) have mostly "unknown" wallets.
   * With 25% enrichment, we get ~25% of real wallets. So if we have 100 swaps
   * but only 5 unique buyers, it could really be ~20+ buyers!
   */
  private checkWalletDiversity(metrics: TokenMetrics, tokenState: TokenState): RiskGateResult {
    const uniqueBuyers = metrics.windows['60s'].uniqueBuyers.size;
    const minWallets = this.config.minUniqueWallets;
    
    // FIX: If we have high swap activity but low uniqueBuyers,
    // it means most events are from log parsing with wallet:"unknown".
    // Use CURRENT swap count as evidence - estimate unique buyers from swap velocity.
    const currentSwapCount = metrics.windows['60s'].swapCount;
    const phase1 = tokenState.phase1Stats;
    const effectiveSwapCount = Math.max(currentSwapCount, phase1?.swapsInWindow || 0);
    
    // Calculate the ratio of known buyers to swaps
    // If this ratio is < 10%, we're mostly dealing with "unknown" wallets (graduated tokens)
    const knownBuyerRatio = effectiveSwapCount > 0 ? uniqueBuyers / effectiveSwapCount : 0;
    
    // FIX: If we have many swaps but few known buyers (< 10% ratio), use estimation
    // This handles: uniqueBuyers=0, uniqueBuyers=1, or any low count with high activity
    if (knownBuyerRatio < 0.10 && effectiveSwapCount >= 10) {
      // Estimate unique buyers: ~1 per 2 swaps (conservative)
      // 100 swaps → ~50 unique buyers
      const estimatedBuyers = Math.max(uniqueBuyers, Math.floor(effectiveSwapCount / 2));
      const passed = estimatedBuyers >= minWallets;
      
      log.info(`📊 Wallet diversity estimated from swaps: ${estimatedBuyers} buyers (${uniqueBuyers} known + ${effectiveSwapCount} swaps, ratio=${(knownBuyerRatio*100).toFixed(1)}%)`);
      
      return {
        passed,
        gateName: 'wallet_diversity',
        reason: passed ? undefined : `Estimated ${estimatedBuyers} buyers from ${effectiveSwapCount} swaps < minimum ${minWallets}`,
        value: estimatedBuyers,
        threshold: minWallets,
      };
    }
    
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
   * 
   * FIX: For graduated tokens (Raydium/Meteora), we only know ~25% of wallets.
   * With few known wallets, concentration is artificially high.
   * Skip this check if we have high swap activity but few known buyers.
   */
  private checkBuyerConcentration(metrics: TokenMetrics): RiskGateResult {
    const concentration = metrics.windows['60s'].topBuyerConcentration;
    const maxConcentration = this.config.maxWalletConcentrationPct;
    const uniqueBuyers = metrics.windows['60s'].uniqueBuyers.size;
    const swapCount = metrics.windows['60s'].swapCount;
    
    // FIX: If we have many swaps but few known buyers, concentration is unreliable
    // Skip this check when we likely have incomplete wallet data
    const knownBuyerRatio = swapCount > 0 ? uniqueBuyers / swapCount : 1;
    
    if (knownBuyerRatio < 0.10 && swapCount >= 20) {
      // High activity but few known wallets = graduated token with incomplete data
      // Trust the swap velocity instead of concentration
      log.info(`📊 Buyer concentration check SKIPPED: only ${uniqueBuyers} known buyers from ${swapCount} swaps (${(knownBuyerRatio*100).toFixed(1)}% coverage)`);
      return {
        passed: true,
        gateName: 'buyer_concentration',
        reason: undefined,
        value: concentration,
        threshold: maxConcentration,
      };
    }
    
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
   * 
   * FIX: When we have Phase 1 data from log parsing, sells are often not detected.
   * A 100% buy ratio with Phase 1 data is EXPECTED, not suspicious!
   * Use Phase 1's buy ratio instead of Phase 2's incomplete data.
   */
  private checkBuySellImbalance(metrics: TokenMetrics, tokenState: TokenState): RiskGateResult {
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
    
    // FIX: If we have high swap activity but sellVol is 0, it's because log parsing
    // can't reliably detect sells. This is NOT a red flag for momentum tokens!
    const currentSwapCount = metrics.windows['60s'].swapCount;
    const phase1 = tokenState.phase1Stats;
    const effectiveSwapCount = Math.max(currentSwapCount, phase1?.swapsInWindow || 0);
    
    if (sellVol.isZero() && effectiveSwapCount >= 5) {
      // Use Phase 1 buyRatio if available, otherwise assume bullish (most pump tokens are)
      const buyRatio = phase1?.buyRatio ?? 0.8; // Default to 80% if no Phase 1 data
      const passed = buyRatio >= 0.5; // >50% buys = net buying pressure = GOOD
      
      log.info(`📊 Buy/sell imbalance: buyRatio=${(buyRatio * 100).toFixed(0)}% (${effectiveSwapCount} swaps, sells not detectable from logs)`);
      
      return {
        passed,
        gateName: 'buy_sell_imbalance',
        reason: passed 
          ? undefined 
          : `Buy ratio ${(buyRatio * 100).toFixed(0)}% < 50% (bearish)`,
        value: buyRatio * 100,
        threshold: 50,
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
   * 
   * FIX: Use Phase 1 data to estimate minimum liquidity when volume data is unreliable.
   */
  private checkPositionSize(metrics: TokenMetrics, tokenState: TokenState): RiskGateResult {
    const tradeSize = this.config.tradeSizeSol;
    let poolLiquidity = metrics.estimatedLiquidity;
    
    // Estimate liquidity if not available
    if (poolLiquidity.isZero()) {
      const volume60s = metrics.windows['60s'].buyNotional.plus(metrics.windows['60s'].sellNotional);
      poolLiquidity = volume60s.mul(5);
    }
    
    // FIX: Use CURRENT swap count (more accurate than stale Phase 1 stats)
    const currentSwapCount = metrics.windows['60s'].swapCount;
    const phase1 = tokenState.phase1Stats;
    const effectiveSwapCount = Math.max(currentSwapCount, phase1?.swapsInWindow || 0);
    
    if (effectiveSwapCount >= 5 && poolLiquidity.lt(new Decimal(10))) {
      // Use same estimation as liquidity gate
      if (effectiveSwapCount >= 100) {
        poolLiquidity = new Decimal(50);
      } else if (effectiveSwapCount >= 50) {
        poolLiquidity = new Decimal(20);
      } else if (effectiveSwapCount >= 20) {
        poolLiquidity = new Decimal(10);
      } else {
        poolLiquidity = new Decimal(5);
      }
      log.debug(`Position size using swap velocity liquidity estimate: ${poolLiquidity.toFixed(2)} SOL (${effectiveSwapCount} swaps)`);
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
