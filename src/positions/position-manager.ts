/**
 * Position Manager
 * Tracks active positions and manages exit logic.
 */

import Decimal from 'decimal.js';
import EventEmitter from 'eventemitter3';
import { v4 as uuidv4 } from 'uuid';
import {
  Position,
  PositionStatus,
  ExitReason,
  MomentumScore,
  LogEventType,
  ExecutionResult,
} from '../types';
import { TokenState } from '../universe/token-state';
import { MomentumScorer } from '../scoring/momentum-scorer';
import { ExecutionEngine } from '../execution/execution-engine';
import { getConfig } from '../config/config';
import { logEvent, log } from '../logging/logger';

interface PositionManagerEvents {
  'position:opened': (position: Position) => void;
  'position:closed': (position: Position) => void;
  'position:failed': (position: Position) => void;
  'exit:triggered': (positionId: string, reason: ExitReason) => void;
}

/**
 * PositionManager handles the lifecycle of trading positions:
 * - Entry execution
 * - Exit condition monitoring
 * - PnL tracking
 * - Max hold time enforcement
 */
export class PositionManager extends EventEmitter<PositionManagerEvents> {
  private positions = new Map<string, Position>();
  private positionsByToken = new Map<string, string>(); // tokenMint -> positionId
  private monitorInterval: NodeJS.Timeout | null = null;
  
  private executionEngine: ExecutionEngine;
  private momentumScorer: MomentumScorer;
  private config = getConfig();
  
  // Exit tracking
  private consecutiveBelowExitThreshold = new Map<string, number>();
  private consecutiveNegativeInflow = new Map<string, number>();
  
  constructor(
    executionEngine: ExecutionEngine,
    momentumScorer: MomentumScorer
  ) {
    super();
    this.executionEngine = executionEngine;
    this.momentumScorer = momentumScorer;
  }
  
  /**
   * Start position monitoring
   */
  start(): void {
    // Check exit conditions every second
    this.monitorInterval = setInterval(() => this.monitorPositions(), 1000);
    log.info('Position manager started');
  }
  
  /**
   * Stop position monitoring
   */
  stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }
  
  /**
   * Open a new position
   */
  async openPosition(
    tokenState: TokenState,
    score: MomentumScore
  ): Promise<Position | null> {
    const tokenMint = tokenState.tokenMint;
    
    // Check if we already have a position in this token
    if (this.positionsByToken.has(tokenMint)) {
      log.debug(`Already have position in ${tokenMint.slice(0, 8)}...`);
      return null;
    }
    
    // Check max concurrent positions
    const activeCount = this.getActivePositionCount();
    if (activeCount >= this.config.maxConcurrentPositions) {
      log.debug(`Max concurrent positions (${this.config.maxConcurrentPositions}) reached`);
      return null;
    }
    
    // Create position object
    const positionId = uuidv4();
    const position: Position = {
      id: positionId,
      tokenMint,
      status: PositionStatus.PENDING_ENTRY,
      entryTimestamp: Date.now(),
      entryPriceSol: tokenState.estimatedPrice,
      entrySizeSol: this.config.tradeSizeSol,
      tokenAmount: new Decimal(0),
      entryMomentumScore: score.totalScore,
      maxMomentumScore: score.totalScore,
      minMomentumScore: score.totalScore,
      consecutiveNegativeInflow: 0,
    };
    
    this.positions.set(positionId, position);
    this.positionsByToken.set(tokenMint, positionId);
    
    logEvent(LogEventType.ENTRY_SIGNAL, {
      positionId,
      tokenMint,
      score: score.totalScore,
      entrySizeSol: this.config.tradeSizeSol.toString(),
    });
    
    log.info(`Opening position in ${tokenMint.slice(0, 8)}...`, {
      score: score.totalScore.toFixed(2),
      sizeSol: this.config.tradeSizeSol.toString(),
    });
    
    // Execute buy
    const result = await this.executionEngine.executeBuy(
      tokenMint,
      this.config.tradeSizeSol
    );
    
    if (result.success) {
      position.status = PositionStatus.ACTIVE;
      position.entrySignature = result.signature;
      position.tokenAmount = result.actualOutputAmount || new Decimal(0);
      
      // Reset token confirmation tracking
      tokenState.resetConfirmationTracking();
      
      logEvent(LogEventType.POSITION_OPENED, {
        positionId,
        tokenMint,
        signature: result.signature,
        tokenAmount: position.tokenAmount.toString(),
        executionTimeMs: result.executionTimeMs,
      });
      
      log.trade('POSITION OPENED', {
        token: tokenMint.slice(0, 8),
        signature: result.signature?.slice(0, 16),
        amount: position.tokenAmount.toString(),
      });
      
      this.emit('position:opened', position);
      return position;
      
    } else {
      position.status = PositionStatus.FAILED;
      this.positions.delete(positionId);
      this.positionsByToken.delete(tokenMint);
      
      log.warn(`Failed to open position: ${result.error}`);
      this.emit('position:failed', position);
      return null;
    }
  }
  
  /**
   * Close a position
   */
  async closePosition(
    positionId: string,
    reason: ExitReason
  ): Promise<boolean> {
    const position = this.positions.get(positionId);
    if (!position || position.status !== PositionStatus.ACTIVE) {
      return false;
    }
    
    position.status = PositionStatus.PENDING_EXIT;
    position.exitReason = reason;
    
    logEvent(LogEventType.EXIT_SIGNAL, {
      positionId,
      tokenMint: position.tokenMint,
      reason,
      holdTimeMs: Date.now() - position.entryTimestamp,
    });
    
    log.info(`Closing position ${positionId.slice(0, 8)}... (${reason})`);
    
    this.emit('exit:triggered', positionId, reason);
    
    // Execute sell
    const result = await this.executionEngine.executeSell(
      position.tokenMint,
      position.tokenAmount
    );
    
    position.exitTimestamp = Date.now();
    position.holdTimeMs = position.exitTimestamp - position.entryTimestamp;
    
    if (result.success) {
      position.status = PositionStatus.CLOSED;
      position.exitSignature = result.signature;
      position.exitSizeSol = result.actualOutputAmount;
      
      // Calculate PnL
      const exitSol = result.actualOutputAmount || new Decimal(0);
      position.realizedPnlSol = exitSol.minus(position.entrySizeSol);
      position.realizedPnlPercent = position.entrySizeSol.gt(0)
        ? position.realizedPnlSol.div(position.entrySizeSol).mul(100).toNumber()
        : 0;
      
      logEvent(LogEventType.POSITION_CLOSED, {
        positionId,
        tokenMint: position.tokenMint,
        exitSignature: result.signature,
        pnlSol: position.realizedPnlSol?.toString(),
        pnlPercent: position.realizedPnlPercent,
        holdTimeMs: position.holdTimeMs,
        exitReason: reason,
      });
      
      log.trade('POSITION CLOSED', {
        token: position.tokenMint.slice(0, 8),
        pnl: `${position.realizedPnlPercent?.toFixed(2)}%`,
        holdTime: `${Math.round((position.holdTimeMs || 0) / 1000)}s`,
        reason,
      });
      
      this.emit('position:closed', position);
      
    } else {
      // Failed to close - keep trying
      position.status = PositionStatus.ACTIVE;
      log.error(`Failed to close position: ${result.error}`);
      return false;
    }
    
    // Cleanup tracking
    this.positionsByToken.delete(position.tokenMint);
    this.consecutiveBelowExitThreshold.delete(positionId);
    this.consecutiveNegativeInflow.delete(positionId);
    
    return true;
  }
  
  /**
   * Monitor all active positions for exit conditions
   */
  private async monitorPositions(): Promise<void> {
    const now = Date.now();
    
    for (const [positionId, position] of this.positions) {
      if (position.status !== PositionStatus.ACTIVE) continue;
      
      // Check exit conditions
      const exitResult = await this.checkExitConditions(position, now);
      
      if (exitResult.shouldExit) {
        await this.closePosition(positionId, exitResult.reason!);
      }
    }
  }
  
  /**
   * Check all exit conditions for a position
   */
  private async checkExitConditions(
    position: Position,
    now: number
  ): Promise<{ shouldExit: boolean; reason: ExitReason | null }> {
    // Condition A: Max hold time
    const holdTimeMs = now - position.entryTimestamp;
    if (holdTimeMs >= this.config.maxHoldTimeMs) {
      return { shouldExit: true, reason: ExitReason.MAX_HOLD_TIME };
    }
    
    // Get token state (may not exist if token exited universe)
    // In that case, exit immediately
    const { getTokenUniverse } = await import('../universe/token-universe');
    const tokenState = getTokenUniverse().getToken(position.tokenMint);
    
    if (!tokenState) {
      return { shouldExit: true, reason: ExitReason.ERROR };
    }
    
    // Calculate current score
    const score = this.momentumScorer.calculateScore(tokenState);
    
    // Update position tracking
    if (score.totalScore > position.maxMomentumScore) {
      position.maxMomentumScore = score.totalScore;
    }
    if (score.totalScore < position.minMomentumScore) {
      position.minMomentumScore = score.totalScore;
    }
    
    // Condition B: Momentum decay
    if (!score.isAboveExitThreshold) {
      const consecutive = (this.consecutiveBelowExitThreshold.get(position.id) || 0) + 1;
      this.consecutiveBelowExitThreshold.set(position.id, consecutive);
      
      // Exit after 3 consecutive checks below threshold
      if (consecutive >= 3) {
        return { shouldExit: true, reason: ExitReason.MOMENTUM_DECAY };
      }
    } else {
      this.consecutiveBelowExitThreshold.set(position.id, 0);
    }
    
    // Condition C: Flow reversal
    const metrics = tokenState.getMetrics();
    const netInflow = metrics.windows['15s'].netInflow;
    
    if (netInflow.lt(0)) {
      const consecutive = (this.consecutiveNegativeInflow.get(position.id) || 0) + 1;
      this.consecutiveNegativeInflow.set(position.id, consecutive);
      position.consecutiveNegativeInflow = consecutive;
      
      // Exit after 5 consecutive checks with negative inflow
      if (consecutive >= 5) {
        return { shouldExit: true, reason: ExitReason.FLOW_REVERSAL };
      }
    } else {
      this.consecutiveNegativeInflow.set(position.id, 0);
      position.consecutiveNegativeInflow = 0;
    }
    
    return { shouldExit: false, reason: null };
  }
  
  /**
   * Update unrealized PnL for a position
   */
  async updateUnrealizedPnl(position: Position): Promise<void> {
    try {
      const jupiterClient = this.executionEngine.getJupiterClient();
      const sellQuote = await jupiterClient.getSellQuote(
        position.tokenMint,
        position.tokenAmount
      );
      
      if (sellQuote) {
        const currentValue = sellQuote.expectedOutputAmount.div(1e9); // Convert from lamports
        position.unrealizedPnlSol = currentValue.minus(position.entrySizeSol);
      }
    } catch {
      // Ignore quote errors for unrealized PnL
    }
  }
  
  /**
   * Force close all positions (emergency)
   */
  async closeAllPositions(reason: ExitReason): Promise<void> {
    log.warn(`Force closing all positions: ${reason}`);
    
    const activePositions = Array.from(this.positions.values())
      .filter(p => p.status === PositionStatus.ACTIVE);
    
    for (const position of activePositions) {
      await this.closePosition(position.id, reason);
    }
  }
  
  /**
   * Get position by ID
   */
  getPosition(positionId: string): Position | undefined {
    return this.positions.get(positionId);
  }
  
  /**
   * Get position by token mint
   */
  getPositionByToken(tokenMint: string): Position | undefined {
    const positionId = this.positionsByToken.get(tokenMint);
    return positionId ? this.positions.get(positionId) : undefined;
  }
  
  /**
   * Check if we have a position in a token
   */
  hasPositionInToken(tokenMint: string): boolean {
    return this.positionsByToken.has(tokenMint);
  }
  
  /**
   * Get all active positions
   */
  getActivePositions(): Position[] {
    return Array.from(this.positions.values())
      .filter(p => p.status === PositionStatus.ACTIVE);
  }
  
  /**
   * Get count of active positions
   */
  getActivePositionCount(): number {
    return this.getActivePositions().length;
  }
  
  /**
   * Get all positions (including closed)
   */
  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }
  
  /**
   * Get performance summary
   */
  getPerformanceSummary(): {
    totalTrades: number;
    winCount: number;
    lossCount: number;
    totalPnlSol: Decimal;
    avgHoldTimeMs: number;
    winRate: number;
  } {
    const closedPositions = Array.from(this.positions.values())
      .filter(p => p.status === PositionStatus.CLOSED);
    
    let winCount = 0;
    let lossCount = 0;
    let totalPnl = new Decimal(0);
    let totalHoldTime = 0;
    
    for (const position of closedPositions) {
      if (position.realizedPnlSol) {
        totalPnl = totalPnl.plus(position.realizedPnlSol);
        
        if (position.realizedPnlSol.gt(0)) {
          winCount++;
        } else {
          lossCount++;
        }
      }
      
      if (position.holdTimeMs) {
        totalHoldTime += position.holdTimeMs;
      }
    }
    
    return {
      totalTrades: closedPositions.length,
      winCount,
      lossCount,
      totalPnlSol: totalPnl,
      avgHoldTimeMs: closedPositions.length > 0 ? totalHoldTime / closedPositions.length : 0,
      winRate: closedPositions.length > 0 ? (winCount / closedPositions.length) * 100 : 0,
    };
  }
}
