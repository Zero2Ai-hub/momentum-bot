/**
 * Replay Harness
 * Replays historical events through the signal engine for backtesting.
 */

import fs from 'fs';
import readline from 'readline';
import path from 'path';
import Decimal from 'decimal.js';
import { 
  LogEvent, 
  LogEventType, 
  SwapEvent, 
  SwapDirection, 
  DEXSource,
  MomentumScore,
  Position,
  PositionStatus,
} from '../types';
import { TokenUniverse } from '../universe/token-universe';
import { TokenState } from '../universe/token-state';
import { MomentumScorer } from '../scoring/momentum-scorer';
import { RiskGates } from '../risk/risk-gates';
import { getConfig, loadConfig } from '../config/config';
import { log, initializeLogger } from '../logging/logger';

interface ReplayResult {
  totalEvents: number;
  swapsProcessed: number;
  tokensObserved: number;
  entrySignals: number;
  exitSignals: number;
  simulatedTrades: SimulatedTrade[];
  performanceMetrics: PerformanceMetrics;
  eventTimeline: TimelineEvent[];
}

interface SimulatedTrade {
  tokenMint: string;
  entryTimestamp: number;
  entryScore: number;
  exitTimestamp: number;
  exitScore: number;
  exitReason: string;
  holdTimeMs: number;
  simulatedPnlPercent: number; // Based on price change
}

interface PerformanceMetrics {
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgHoldTimeMs: number;
  avgPnlPercent: number;
  maxDrawdownPercent: number;
  sharpeApprox: number;
}

interface TimelineEvent {
  timestamp: number;
  type: 'entry' | 'exit' | 'threshold_crossed';
  tokenMint: string;
  score: number;
  details: Record<string, unknown>;
}

/**
 * ReplayHarness loads historical event logs and replays them
 * through the momentum detection engine.
 */
export class ReplayHarness {
  private universe: TokenUniverse;
  private scorer: MomentumScorer;
  private riskGates: RiskGates;
  
  // Simulated positions
  private activePositions = new Map<string, {
    tokenMint: string;
    entryTimestamp: number;
    entryScore: number;
    entryPrice: Decimal;
  }>();
  
  // Results
  private trades: SimulatedTrade[] = [];
  private timeline: TimelineEvent[] = [];
  private entrySignalCount = 0;
  private exitSignalCount = 0;
  
  constructor() {
    this.universe = new TokenUniverse();
    this.scorer = new MomentumScorer();
    this.riskGates = new RiskGates();
  }
  
  /**
   * Replay events from a log file
   */
  async replayFile(filePath: string): Promise<ReplayResult> {
    const config = getConfig();
    
    log.info(`Starting replay from: ${filePath}`);
    
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });
    
    let totalEvents = 0;
    let swapsProcessed = 0;
    
    for await (const line of rl) {
      if (!line.trim()) continue;
      
      try {
        const event: LogEvent = JSON.parse(line);
        totalEvents++;
        
        // Process swap events
        if (event.type === LogEventType.SWAP_DETECTED) {
          const swapEvent = this.reconstructSwapEvent(event);
          if (swapEvent) {
            await this.processSwapEvent(swapEvent);
            swapsProcessed++;
          }
        }
        
        // Also replay at actual event timestamps for accuracy
        if (event.type === LogEventType.ENTRY_SIGNAL) {
          // Entry signals were generated during recording
          this.entrySignalCount++;
        }
        
        if (event.type === LogEventType.EXIT_SIGNAL) {
          this.exitSignalCount++;
        }
        
      } catch (error) {
        // Skip malformed lines
        log.debug(`Skipping malformed line: ${(error as Error).message}`);
      }
    }
    
    // Close any remaining positions at end of replay
    await this.closeAllPositions();
    
    // Calculate performance metrics
    const metrics = this.calculatePerformanceMetrics();
    
    return {
      totalEvents,
      swapsProcessed,
      tokensObserved: this.universe.size,
      entrySignals: this.entrySignalCount,
      exitSignals: this.exitSignalCount,
      simulatedTrades: this.trades,
      performanceMetrics: metrics,
      eventTimeline: this.timeline,
    };
  }
  
  /**
   * Reconstruct a SwapEvent from log data
   */
  private reconstructSwapEvent(logEvent: LogEvent): SwapEvent | null {
    const data = logEvent.data;
    
    if (!data.tokenMint || !data.direction) {
      return null;
    }
    
    return {
      signature: data.signature as string || `replay_${logEvent.timestamp}`,
      slot: 0,
      timestamp: logEvent.timestamp,
      tokenMint: data.tokenMint as string,
      direction: data.direction as SwapDirection,
      notionalSol: new Decimal(data.notionalSol as string || '0.01'),
      walletAddress: data.wallet as string || 'unknown',
      dexSource: (data.dex as DEXSource) || DEXSource.UNKNOWN,
    };
  }
  
  /**
   * Process a swap event through the signal engine
   */
  private async processSwapEvent(event: SwapEvent): Promise<void> {
    // Update token universe
    const tokenState = this.universe.processSwap(event);
    
    // Calculate momentum score
    const score = this.scorer.calculateScore(tokenState);
    
    // Check for entry signal
    if (this.scorer.isEntryReady(score) && !this.activePositions.has(event.tokenMint)) {
      await this.simulateEntry(tokenState, score);
    }
    
    // Check for exit signal on active positions
    if (this.activePositions.has(event.tokenMint)) {
      const exitResult = this.scorer.shouldExit(score, tokenState);
      
      if (exitResult.shouldExit) {
        await this.simulateExit(event.tokenMint, score, exitResult.reason || 'unknown');
      }
    }
  }
  
  /**
   * Simulate entering a position
   */
  private async simulateEntry(
    tokenState: TokenState,
    score: MomentumScore
  ): Promise<void> {
    const config = getConfig();
    
    // Run risk gates (simplified for replay)
    const assessment = await this.riskGates.assess(tokenState, score);
    
    // For replay, we may want to be less strict
    // Only check critical gates
    const criticalGatesFailed = assessment.gates.some(
      g => !g.passed && (g.gateName === 'liquidity' || g.gateName === 'wallet_diversity')
    );
    
    if (criticalGatesFailed) {
      log.debug(`Skipping entry for ${tokenState.tokenMint.slice(0, 8)} - critical gates failed`);
      return;
    }
    
    // Simulate entry
    this.activePositions.set(tokenState.tokenMint, {
      tokenMint: tokenState.tokenMint,
      entryTimestamp: Date.now(),
      entryScore: score.totalScore,
      entryPrice: tokenState.estimatedPrice,
    });
    
    this.timeline.push({
      timestamp: Date.now(),
      type: 'entry',
      tokenMint: tokenState.tokenMint,
      score: score.totalScore,
      details: {
        components: score.components,
        confirmationTime: score.consecutiveAboveEntry,
      },
    });
    
    this.entrySignalCount++;
    log.info(`[REPLAY] Entry signal: ${tokenState.tokenMint.slice(0, 8)}... score=${score.totalScore.toFixed(2)}`);
  }
  
  /**
   * Simulate exiting a position
   */
  private async simulateExit(
    tokenMint: string,
    score: MomentumScore,
    reason: string
  ): Promise<void> {
    const position = this.activePositions.get(tokenMint);
    if (!position) return;
    
    const tokenState = this.universe.getToken(tokenMint);
    const exitPrice = tokenState?.estimatedPrice || position.entryPrice;
    
    // Calculate simulated PnL (based on price change)
    const pnlPercent = position.entryPrice.gt(0)
      ? exitPrice.minus(position.entryPrice).div(position.entryPrice).mul(100).toNumber()
      : 0;
    
    const holdTimeMs = Date.now() - position.entryTimestamp;
    
    // Record trade
    this.trades.push({
      tokenMint,
      entryTimestamp: position.entryTimestamp,
      entryScore: position.entryScore,
      exitTimestamp: Date.now(),
      exitScore: score.totalScore,
      exitReason: reason,
      holdTimeMs,
      simulatedPnlPercent: pnlPercent,
    });
    
    this.timeline.push({
      timestamp: Date.now(),
      type: 'exit',
      tokenMint,
      score: score.totalScore,
      details: {
        reason,
        holdTimeMs,
        pnlPercent,
      },
    });
    
    this.activePositions.delete(tokenMint);
    this.exitSignalCount++;
    
    log.info(`[REPLAY] Exit signal: ${tokenMint.slice(0, 8)}... reason=${reason} pnl=${pnlPercent.toFixed(2)}%`);
  }
  
  /**
   * Close all remaining positions at end of replay
   */
  private async closeAllPositions(): Promise<void> {
    for (const [tokenMint, position] of this.activePositions) {
      const tokenState = this.universe.getToken(tokenMint);
      const score = tokenState 
        ? this.scorer.calculateScore(tokenState)
        : { totalScore: 0 } as MomentumScore;
      
      await this.simulateExit(tokenMint, score, 'end_of_replay');
    }
  }
  
  /**
   * Calculate performance metrics from trades
   */
  private calculatePerformanceMetrics(): PerformanceMetrics {
    if (this.trades.length === 0) {
      return {
        totalTrades: 0,
        winCount: 0,
        lossCount: 0,
        winRate: 0,
        avgHoldTimeMs: 0,
        avgPnlPercent: 0,
        maxDrawdownPercent: 0,
        sharpeApprox: 0,
      };
    }
    
    let winCount = 0;
    let lossCount = 0;
    let totalPnl = 0;
    let totalHoldTime = 0;
    const pnls: number[] = [];
    
    // Calculate running equity curve for drawdown
    let equity = 100; // Start at 100
    let maxEquity = 100;
    let maxDrawdown = 0;
    
    for (const trade of this.trades) {
      if (trade.simulatedPnlPercent > 0) {
        winCount++;
      } else {
        lossCount++;
      }
      
      totalPnl += trade.simulatedPnlPercent;
      totalHoldTime += trade.holdTimeMs;
      pnls.push(trade.simulatedPnlPercent);
      
      // Update equity curve
      equity *= (1 + trade.simulatedPnlPercent / 100);
      maxEquity = Math.max(maxEquity, equity);
      const drawdown = (maxEquity - equity) / maxEquity * 100;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
    }
    
    const avgPnl = totalPnl / this.trades.length;
    
    // Calculate Sharpe approximation (assuming risk-free = 0)
    const stdDev = this.calculateStdDev(pnls);
    const sharpe = stdDev > 0 ? avgPnl / stdDev : 0;
    
    return {
      totalTrades: this.trades.length,
      winCount,
      lossCount,
      winRate: (winCount / this.trades.length) * 100,
      avgHoldTimeMs: totalHoldTime / this.trades.length,
      avgPnlPercent: avgPnl,
      maxDrawdownPercent: maxDrawdown,
      sharpeApprox: sharpe,
    };
  }
  
  /**
   * Calculate standard deviation
   */
  private calculateStdDev(values: number[]): number {
    if (values.length === 0) return 0;
    
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    
    return Math.sqrt(avgSquaredDiff);
  }
  
  /**
   * Generate replay report
   */
  generateReport(result: ReplayResult): string {
    const lines: string[] = [
      '═══════════════════════════════════════════════════════════════',
      '                    REPLAY ANALYSIS REPORT',
      '═══════════════════════════════════════════════════════════════',
      '',
      'EVENT SUMMARY',
      '─────────────────────────────────────────────────────────────────',
      `Total Events Processed:     ${result.totalEvents}`,
      `Swap Events Processed:      ${result.swapsProcessed}`,
      `Unique Tokens Observed:     ${result.tokensObserved}`,
      `Entry Signals Generated:    ${result.entrySignals}`,
      `Exit Signals Generated:     ${result.exitSignals}`,
      '',
      'PERFORMANCE METRICS',
      '─────────────────────────────────────────────────────────────────',
      `Total Trades:               ${result.performanceMetrics.totalTrades}`,
      `Win Count:                  ${result.performanceMetrics.winCount}`,
      `Loss Count:                 ${result.performanceMetrics.lossCount}`,
      `Win Rate:                   ${result.performanceMetrics.winRate.toFixed(1)}%`,
      `Average PnL:                ${result.performanceMetrics.avgPnlPercent.toFixed(2)}%`,
      `Max Drawdown:               ${result.performanceMetrics.maxDrawdownPercent.toFixed(2)}%`,
      `Avg Hold Time:              ${Math.round(result.performanceMetrics.avgHoldTimeMs / 1000)}s`,
      `Sharpe Ratio (approx):      ${result.performanceMetrics.sharpeApprox.toFixed(2)}`,
      '',
      'TRADE LOG',
      '─────────────────────────────────────────────────────────────────',
    ];
    
    for (const trade of result.simulatedTrades.slice(-20)) { // Last 20 trades
      const holdSec = Math.round(trade.holdTimeMs / 1000);
      const pnlStr = trade.simulatedPnlPercent >= 0 
        ? `+${trade.simulatedPnlPercent.toFixed(2)}%` 
        : `${trade.simulatedPnlPercent.toFixed(2)}%`;
      
      lines.push(
        `${trade.tokenMint.slice(0, 8)}... | ` +
        `Entry: ${trade.entryScore.toFixed(2)} | ` +
        `Exit: ${trade.exitScore.toFixed(2)} (${trade.exitReason}) | ` +
        `Hold: ${holdSec}s | ` +
        `PnL: ${pnlStr}`
      );
    }
    
    lines.push('');
    lines.push('═══════════════════════════════════════════════════════════════');
    
    return lines.join('\n');
  }
}

/**
 * Main replay entry point
 */
async function main() {
  // Initialize
  loadConfig();
  initializeLogger();
  
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: npm run replay <event-log-file.jsonl>');
    console.log('');
    console.log('Example: npm run replay ./logs/events_2024-01-15.jsonl');
    process.exit(1);
  }
  
  const logFile = args[0];
  
  if (!fs.existsSync(logFile)) {
    console.error(`File not found: ${logFile}`);
    process.exit(1);
  }
  
  const harness = new ReplayHarness();
  
  console.log('Starting replay analysis...\n');
  
  const result = await harness.replayFile(logFile);
  const report = harness.generateReport(result);
  
  console.log(report);
  
  // Save report
  const reportPath = logFile.replace('.jsonl', '_report.txt');
  fs.writeFileSync(reportPath, report);
  console.log(`\nReport saved to: ${reportPath}`);
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}
