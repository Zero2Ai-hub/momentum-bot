/**
 * Performance Metrics Tracking
 * Collects and reports bot performance statistics.
 */

import Decimal from 'decimal.js';
import { Position, PositionStatus, ExitReason } from '../types';
import { log } from './logger';

interface TradeMetric {
  tokenMint: string;
  entryTimestamp: number;
  exitTimestamp: number;
  entrySizeSol: Decimal;
  exitSizeSol: Decimal;
  pnlSol: Decimal;
  pnlPercent: number;
  holdTimeMs: number;
  exitReason: ExitReason;
  entryScore: number;
  exitScore: number;
}

interface SessionMetrics {
  startTime: number;
  endTime: number;
  
  // Volume
  totalTrades: number;
  totalVolumeSol: Decimal;
  
  // PnL
  grossPnlSol: Decimal;
  netPnlSol: Decimal;
  feesSol: Decimal;
  
  // Win/Loss
  winCount: number;
  lossCount: number;
  winRate: number;
  
  // Risk metrics
  maxDrawdownSol: Decimal;
  maxDrawdownPercent: number;
  largestWinSol: Decimal;
  largestLossSol: Decimal;
  
  // Timing
  avgHoldTimeMs: number;
  minHoldTimeMs: number;
  maxHoldTimeMs: number;
  
  // Efficiency
  profitFactor: number; // gross profit / gross loss
  avgWinSol: Decimal;
  avgLossSol: Decimal;
  expectancy: Decimal;
  
  // Exit analysis
  exitReasonBreakdown: Record<ExitReason, number>;
}

/**
 * MetricsCollector tracks and analyzes trading performance.
 */
export class MetricsCollector {
  private trades: TradeMetric[] = [];
  private startTime: number;
  private peakEquity: Decimal;
  private currentEquity: Decimal;
  private initialEquity: Decimal;
  
  constructor(initialEquitySol: Decimal = new Decimal(1)) {
    this.startTime = Date.now();
    this.initialEquity = initialEquitySol;
    this.currentEquity = initialEquitySol;
    this.peakEquity = initialEquitySol;
  }
  
  /**
   * Record a completed trade
   */
  recordTrade(position: Position): void {
    if (position.status !== PositionStatus.CLOSED) {
      return;
    }
    
    const metric: TradeMetric = {
      tokenMint: position.tokenMint,
      entryTimestamp: position.entryTimestamp,
      exitTimestamp: position.exitTimestamp || Date.now(),
      entrySizeSol: position.entrySizeSol,
      exitSizeSol: position.exitSizeSol || new Decimal(0),
      pnlSol: position.realizedPnlSol || new Decimal(0),
      pnlPercent: position.realizedPnlPercent || 0,
      holdTimeMs: position.holdTimeMs || 0,
      exitReason: position.exitReason || ExitReason.ERROR,
      entryScore: position.entryMomentumScore,
      exitScore: position.exitMomentumScore || 0,
    };
    
    this.trades.push(metric);
    
    // Update equity tracking
    this.currentEquity = this.currentEquity.plus(metric.pnlSol);
    if (this.currentEquity.gt(this.peakEquity)) {
      this.peakEquity = this.currentEquity;
    }
  }
  
  /**
   * Get current session metrics
   */
  getSessionMetrics(): SessionMetrics {
    const now = Date.now();
    
    // Initialize metrics
    let totalVolume = new Decimal(0);
    let grossProfit = new Decimal(0);
    let grossLoss = new Decimal(0);
    let winCount = 0;
    let lossCount = 0;
    let totalHoldTime = 0;
    let minHoldTime = Infinity;
    let maxHoldTime = 0;
    let largestWin = new Decimal(0);
    let largestLoss = new Decimal(0);
    
    const exitReasonCounts: Record<string, number> = {
      [ExitReason.MOMENTUM_DECAY]: 0,
      [ExitReason.FLOW_REVERSAL]: 0,
      [ExitReason.MAX_HOLD_TIME]: 0,
      [ExitReason.MANUAL]: 0,
      [ExitReason.ERROR]: 0,
    };
    
    // Calculate drawdown tracking
    let runningEquity = this.initialEquity;
    let runningPeak = this.initialEquity;
    let maxDrawdownSol = new Decimal(0);
    let maxDrawdownPercent = 0;
    
    for (const trade of this.trades) {
      totalVolume = totalVolume.plus(trade.entrySizeSol);
      
      if (trade.pnlSol.gt(0)) {
        winCount++;
        grossProfit = grossProfit.plus(trade.pnlSol);
        if (trade.pnlSol.gt(largestWin)) {
          largestWin = trade.pnlSol;
        }
      } else {
        lossCount++;
        grossLoss = grossLoss.plus(trade.pnlSol.abs());
        if (trade.pnlSol.abs().gt(largestLoss)) {
          largestLoss = trade.pnlSol.abs();
        }
      }
      
      totalHoldTime += trade.holdTimeMs;
      minHoldTime = Math.min(minHoldTime, trade.holdTimeMs);
      maxHoldTime = Math.max(maxHoldTime, trade.holdTimeMs);
      
      exitReasonCounts[trade.exitReason]++;
      
      // Update drawdown tracking
      runningEquity = runningEquity.plus(trade.pnlSol);
      if (runningEquity.gt(runningPeak)) {
        runningPeak = runningEquity;
      }
      const drawdownSol = runningPeak.minus(runningEquity);
      const drawdownPct = runningPeak.gt(0) 
        ? drawdownSol.div(runningPeak).mul(100).toNumber()
        : 0;
      
      if (drawdownSol.gt(maxDrawdownSol)) {
        maxDrawdownSol = drawdownSol;
        maxDrawdownPercent = drawdownPct;
      }
    }
    
    const totalTrades = this.trades.length;
    const netPnl = grossProfit.minus(grossLoss);
    const fees = new Decimal(0); // Would need to track actual fees
    
    const winRate = totalTrades > 0 ? (winCount / totalTrades) * 100 : 0;
    const profitFactor = grossLoss.gt(0) ? grossProfit.div(grossLoss).toNumber() : 0;
    
    const avgWin = winCount > 0 ? grossProfit.div(winCount) : new Decimal(0);
    const avgLoss = lossCount > 0 ? grossLoss.div(lossCount) : new Decimal(0);
    
    // Expectancy = (Win% × Avg Win) - (Loss% × Avg Loss)
    const expectancy = totalTrades > 0
      ? avgWin.mul(winCount / totalTrades).minus(avgLoss.mul(lossCount / totalTrades))
      : new Decimal(0);
    
    return {
      startTime: this.startTime,
      endTime: now,
      totalTrades,
      totalVolumeSol: totalVolume,
      grossPnlSol: netPnl,
      netPnlSol: netPnl.minus(fees),
      feesSol: fees,
      winCount,
      lossCount,
      winRate,
      maxDrawdownSol,
      maxDrawdownPercent,
      largestWinSol: largestWin,
      largestLossSol: largestLoss,
      avgHoldTimeMs: totalTrades > 0 ? totalHoldTime / totalTrades : 0,
      minHoldTimeMs: minHoldTime === Infinity ? 0 : minHoldTime,
      maxHoldTimeMs: maxHoldTime,
      profitFactor,
      avgWinSol: avgWin,
      avgLossSol: avgLoss,
      expectancy,
      exitReasonBreakdown: exitReasonCounts as Record<ExitReason, number>,
    };
  }
  
  /**
   * Log current metrics summary
   */
  logSummary(): void {
    const metrics = this.getSessionMetrics();
    const runtime = (metrics.endTime - metrics.startTime) / 1000 / 60;
    
    log.info('═══════════════════════════════════════════════════════════════');
    log.info('                    SESSION METRICS SUMMARY');
    log.info('═══════════════════════════════════════════════════════════════');
    log.info(`Runtime:          ${runtime.toFixed(1)} minutes`);
    log.info(`Total Trades:     ${metrics.totalTrades}`);
    log.info(`Total Volume:     ${metrics.totalVolumeSol.toFixed(4)} SOL`);
    log.info('───────────────────────────────────────────────────────────────');
    log.info(`Net PnL:          ${metrics.netPnlSol.toFixed(4)} SOL`);
    log.info(`Win Rate:         ${metrics.winRate.toFixed(1)}%`);
    log.info(`Profit Factor:    ${metrics.profitFactor.toFixed(2)}`);
    log.info(`Max Drawdown:     ${metrics.maxDrawdownPercent.toFixed(2)}%`);
    log.info('───────────────────────────────────────────────────────────────');
    log.info(`Avg Hold Time:    ${(metrics.avgHoldTimeMs / 1000).toFixed(1)}s`);
    log.info(`Largest Win:      ${metrics.largestWinSol.toFixed(4)} SOL`);
    log.info(`Largest Loss:     ${metrics.largestLossSol.toFixed(4)} SOL`);
    log.info(`Expectancy:       ${metrics.expectancy.toFixed(6)} SOL/trade`);
    log.info('───────────────────────────────────────────────────────────────');
    log.info('Exit Reasons:');
    for (const [reason, count] of Object.entries(metrics.exitReasonBreakdown)) {
      if (count > 0) {
        log.info(`  ${reason}: ${count}`);
      }
    }
    log.info('═══════════════════════════════════════════════════════════════');
  }
  
  /**
   * Export metrics to JSON
   */
  toJSON(): object {
    return {
      metrics: this.getSessionMetrics(),
      trades: this.trades.map(t => ({
        ...t,
        entrySizeSol: t.entrySizeSol.toString(),
        exitSizeSol: t.exitSizeSol.toString(),
        pnlSol: t.pnlSol.toString(),
      })),
    };
  }
  
  /**
   * Get trade count
   */
  get tradeCount(): number {
    return this.trades.length;
  }
  
  /**
   * Get current equity
   */
  get equity(): Decimal {
    return this.currentEquity;
  }
  
  /**
   * Get current drawdown
   */
  get drawdown(): Decimal {
    return this.peakEquity.minus(this.currentEquity);
  }
  
  /**
   * Get drawdown percentage
   */
  get drawdownPercent(): number {
    return this.peakEquity.gt(0)
      ? this.drawdown.div(this.peakEquity).mul(100).toNumber()
      : 0;
  }
}

// Singleton instance
let metricsInstance: MetricsCollector | null = null;

export function getMetricsCollector(initialEquity?: Decimal): MetricsCollector {
  if (!metricsInstance) {
    metricsInstance = new MetricsCollector(initialEquity);
  }
  return metricsInstance;
}

export function resetMetricsCollector(): void {
  metricsInstance = null;
}
