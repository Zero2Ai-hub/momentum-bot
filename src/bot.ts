/**
 * Bot Orchestrator
 * Main coordination layer that connects all components.
 */

import { Connection } from '@solana/web3.js';
import EventEmitter from 'eventemitter3';
import { 
  SwapEvent, 
  MomentumScore, 
  Position,
  LogEventType 
} from './types';
import { getConfig, validateConfig } from './config/config';
import { initializeLogger, logEvent, log, closeLogger } from './logging/logger';
import { EventListener, getEventListener } from './listener/event-listener';
import { TokenUniverse, getTokenUniverse } from './universe/token-universe';
import { TokenState } from './universe/token-state';
import { MomentumScorer, getMomentumScorer } from './scoring/momentum-scorer';
import { RiskGates, getRiskGates } from './risk/risk-gates';
import { ExecutionEngine } from './execution/execution-engine';
import { PositionManager } from './positions/position-manager';

interface BotEvents {
  'started': () => void;
  'stopped': () => void;
  'error': (error: Error) => void;
  'trade:entry': (position: Position) => void;
  'trade:exit': (position: Position) => void;
}

interface BotStats {
  uptime: number;
  swapsProcessed: number;
  tokensTracked: number;
  activePositions: number;
  totalTrades: number;
  winRate: number;
  totalPnlSol: string;
}

/**
 * MomentumBot is the main orchestrator that:
 * - Connects all system components
 * - Handles event flow
 * - Manages lifecycle
 */
export class MomentumBot extends EventEmitter<BotEvents> {
  private connection: Connection | null = null;
  private eventListener: EventListener | null = null;
  private tokenUniverse: TokenUniverse | null = null;
  private momentumScorer: MomentumScorer | null = null;
  private riskGates: RiskGates | null = null;
  private executionEngine: ExecutionEngine | null = null;
  private positionManager: PositionManager | null = null;
  
  private isRunning = false;
  private startTime = 0;
  private swapsProcessed = 0;
  
  // Status monitoring
  private statusInterval: NodeJS.Timeout | null = null;
  
  private config = getConfig();
  
  /**
   * Initialize the bot
   */
  async initialize(): Promise<boolean> {
    log.info('Initializing Momentum Bot...');
    
    // Validate configuration
    const configErrors = validateConfig(this.config);
    if (configErrors.length > 0) {
      for (const error of configErrors) {
        log.error(`Config error: ${error}`);
      }
      return false;
    }
    
    try {
      // Initialize connection
      this.connection = new Connection(this.config.rpcUrl, 'confirmed');
      log.info(`Connected to RPC: ${this.config.rpcUrl.slice(0, 30)}...`);
      
      // Initialize components
      this.eventListener = getEventListener();
      this.tokenUniverse = getTokenUniverse();
      this.momentumScorer = getMomentumScorer();
      this.riskGates = getRiskGates();
      this.executionEngine = new ExecutionEngine(this.connection);
      
      // Initialize wallet
      const walletInitialized = this.executionEngine.initializeWallet();
      if (!walletInitialized) {
        log.warn('Wallet not initialized - running in observation mode only');
      }
      
      // Set Jupiter client on risk gates
      this.riskGates.setJupiterClient(this.executionEngine.getJupiterClient());
      
      // Initialize position manager
      this.positionManager = new PositionManager(
        this.executionEngine,
        this.momentumScorer
      );
      
      // Wire up event handlers
      this.wireEventHandlers();
      
      log.info('Bot initialized successfully');
      return true;
      
    } catch (error) {
      log.error('Failed to initialize bot', error as Error);
      return false;
    }
  }
  
  /**
   * Start the bot
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      log.warn('Bot is already running');
      return;
    }
    
    log.info('Starting Momentum Bot...');
    
    // Start components
    this.tokenUniverse!.start();
    await this.eventListener!.start();
    this.positionManager!.start();
    
    // Start status monitoring
    this.statusInterval = setInterval(() => this.logStatus(), 30_000);
    
    this.isRunning = true;
    this.startTime = Date.now();
    
    log.info('═══════════════════════════════════════════════════════════════');
    if (this.config.paperTrading) {
      log.info('    🧾 PAPER TRADING MODE - No real transactions will be sent');
    } else {
      log.info('    💰 LIVE TRADING MODE - Real transactions will be executed!');
    }
    log.info('          MOMENTUM BOT STARTED - SCANNING FOR OPPORTUNITIES');
    log.info('═══════════════════════════════════════════════════════════════');
    
    this.emit('started');
  }
  
  /**
   * Stop the bot
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    
    log.info('Stopping Momentum Bot...');
    
    // Stop status monitoring
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }
    
    // Close all positions first
    if (this.positionManager) {
      await this.positionManager.closeAllPositions('MANUAL' as any);
      this.positionManager.stop();
    }
    
    // Stop event listener
    if (this.eventListener) {
      await this.eventListener.stop();
    }
    
    // Stop token universe
    if (this.tokenUniverse) {
      this.tokenUniverse.stop();
    }
    
    // Close logger
    await closeLogger();
    
    this.isRunning = false;
    
    log.info('Bot stopped');
    this.emit('stopped');
  }
  
  /**
   * Wire up event handlers between components
   */
  private wireEventHandlers(): void {
    // Handle swap events from listener
    this.eventListener!.on('swap', (event: SwapEvent) => {
      this.handleSwapEvent(event);
    });
    
    // Handle connection errors
    this.eventListener!.on('error', (error: Error) => {
      log.error('Event listener error', error);
      this.emit('error', error);
    });
    
    // Handle new tokens entering universe
    this.tokenUniverse!.on('token:entered', (tokenMint: string, state: TokenState) => {
      log.debug(`New token: ${tokenMint.slice(0, 8)}...`);
    });
    
    // Handle position events
    this.positionManager!.on('position:opened', (position: Position) => {
      this.emit('trade:entry', position);
    });
    
    this.positionManager!.on('position:closed', (position: Position) => {
      this.emit('trade:exit', position);
    });
  }
  
  /**
   * Handle incoming swap event
   */
  private async handleSwapEvent(event: SwapEvent): Promise<void> {
    this.swapsProcessed++;
    
    // Update token universe (now validates mint as second safety net)
    const tokenState = await this.tokenUniverse!.processSwap(event);
    
    // Skip if token was rejected (null means invalid mint or validation failed)
    if (!tokenState) {
      return;
    }
    
    // Skip if we already have a position in this token
    if (this.positionManager!.hasPositionInToken(event.tokenMint)) {
      return;
    }
    
    // Calculate momentum score
    const score = this.momentumScorer!.calculateScore(tokenState);
    
    // Only log tokens with REAL momentum (score > 50% of threshold)
    const analytics60s = tokenState.getWindowMetrics('60s');
    if (score.totalScore >= this.config.entryThreshold * 0.5) {
      const pct = ((score.totalScore / this.config.entryThreshold) * 100).toFixed(0);
      // Full token mint for easy lookup on Solscan/Birdeye
      log.info(`🔥 MOMENTUM: ${tokenState.tokenMint} | ${pct}% | swaps=${analytics60s.swapCount} | buyers=${analytics60s.uniqueBuyers.size} | net=${analytics60s.netInflow.toFixed(3)} SOL`);
    }
    
    // Check if entry is ready
    if (this.momentumScorer!.isEntryReady(score)) {
      await this.evaluateEntry(tokenState, score);
    }
  }
  
  /**
   * Evaluate whether to enter a position
   */
  private async evaluateEntry(
    tokenState: TokenState,
    score: MomentumScore
  ): Promise<void> {
    // Check max concurrent positions
    if (this.positionManager!.getActivePositionCount() >= this.config.maxConcurrentPositions) {
      log.info(`🚫 REJECTED: ${tokenState.tokenMint.slice(0, 12)}... | Score: ${score.totalScore.toFixed(1)} | Failed: max_positions (${this.config.maxConcurrentPositions})`);
      return;
    }
    
    // Run risk assessment
    const assessment = await this.riskGates!.assess(tokenState, score);
    
    if (!assessment.allGatesPassed) {
      // Get the failed gates and their reasons
      const failedGates = assessment.gates.filter(g => !g.passed);
      const failedReasons = failedGates
        .map(g => g.reason || g.gateName)
        .join(' | ');
      
      log.info(`🚫 REJECTED: ${tokenState.tokenMint.slice(0, 12)}... | Score: ${score.totalScore.toFixed(1)} | Risk: ${assessment.overallRisk} | Failed: ${failedReasons}`);
      return;
    }
    
    // Check wallet balance
    const canAfford = await this.executionEngine!.canAffordTrade(this.config.tradeSizeSol);
    if (!canAfford) {
      log.info(`🚫 REJECTED: ${tokenState.tokenMint.slice(0, 12)}... | Score: ${score.totalScore.toFixed(1)} | Failed: insufficient_balance`);
      return;
    }
    
    // Execute entry
    log.info(`═══ ENTRY OPPORTUNITY ═══`);
    log.info(`Token: ${tokenState.tokenMint}`);
    log.info(`Score: ${score.totalScore.toFixed(2)}`);
    log.info(`Risk: ${assessment.overallRisk}`);
    
    await this.positionManager!.openPosition(tokenState, score);
  }
  
  /**
   * Log current status
   */
  private logStatus(): void {
    const stats = this.getStats();
    const performance = this.positionManager!.getPerformanceSummary();
    const universeStats = this.tokenUniverse!.getStats();
    
    // Calculate swaps per minute
    const uptimeMin = stats.uptime / 60000;
    const swapsPerMin = uptimeMin > 0 ? Math.round(stats.swapsProcessed / uptimeMin) : 0;
    
    log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log.info(`📊 STATUS | Uptime: ${Math.round(uptimeMin)}m | Swaps/min: ${swapsPerMin} | Active tokens: ${universeStats.totalTokens}`);
    log.info(`🎯 SCANNING: ALL tokens with DEX activity (Raydium, Orca, Meteora, PumpSwap, Pump.fun)`);
    log.info(`📈 Waiting for momentum score ≥ ${this.config.entryThreshold} (sustained ${this.config.confirmationSeconds}s)`);
    
    if (performance.totalTrades > 0) {
      log.info(`💰 TRADES | Total: ${performance.totalTrades} | Win: ${performance.winRate.toFixed(0)}% | PnL: ${performance.totalPnlSol.toFixed(4)} SOL`);
    } else {
      log.info(`⏳ No trades yet - waiting for high-momentum opportunities`);
    }
    log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }
  
  /**
   * Get bot statistics
   */
  getStats(): BotStats {
    const performance = this.positionManager?.getPerformanceSummary() || {
      totalTrades: 0,
      winRate: 0,
      totalPnlSol: { toString: () => '0' },
    };
    
    return {
      uptime: this.isRunning ? Date.now() - this.startTime : 0,
      swapsProcessed: this.swapsProcessed,
      tokensTracked: this.tokenUniverse?.size || 0,
      activePositions: this.positionManager?.getActivePositionCount() || 0,
      totalTrades: performance.totalTrades,
      winRate: performance.winRate,
      totalPnlSol: performance.totalPnlSol.toString(),
    };
  }
  
  /**
   * Check if bot is running
   */
  get running(): boolean {
    return this.isRunning;
  }
}

// Factory function
export function createBot(): MomentumBot {
  return new MomentumBot();
}
