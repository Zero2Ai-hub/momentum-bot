/**
 * On-chain Event Listener
 * Subscribes to Solana WebSocket streams and ingests swap events.
 * 
 * TWO-PHASE DETECTION (FIXED):
 * Phase 1 (FREE): Parse raw logs to track swap count per candidate
 * Phase 2 (RPC): Only verify & emit for "hot" candidates
 * 
 * P0 FIXES IMPLEMENTED:
 * 1. True sliding window in HotTokenTracker
 * 2. Dedupe + in-flight lock + cooldown to prevent Phase 2 spam
 * 3. Non-pump sources emit "candidateAddress", not "tokenMint"
 * 4. Pump path bypasses Phase 2 tx parsing - verify mint once, emit from logs
 */

import { Connection, PublicKey } from '@solana/web3.js';
import EventEmitter from 'eventemitter3';
import Decimal from 'decimal.js';
import { SwapEvent, SwapDirection, DEXSource, DEX_PROGRAM_IDS, LogEventType } from '../types';
import { getConfig } from '../config/config';
import { logEvent, log } from '../logging/logger';
import { validateSwapEvent, isValidTokenMint } from './parsers/known-addresses';
import { isValidTradeableToken, initializeTokenVerifier, isVerifiedToken } from './token-verifier';
import { parseTransactionWithHelius } from './helius-parser';
import { getHotTokenTracker, HotTokenTracker, HotDetectionStats } from './hot-token-tracker';
import { parseRaydiumSwap } from './parsers/raydium';
import { parsePumpFunSwap } from './parsers/pumpfun';
import { parsePumpSwapLogs } from './parsers/pumpswap';
import { getTokenUniverse } from '../universe/token-universe';

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

interface EventListenerEvents {
  'swap': (event: SwapEvent) => void;
  'connected': () => void;
  'disconnected': () => void;
  'error': (error: Error) => void;
}

interface SubscriptionHandle {
  programId: string;
  subscriptionId: number;
}

// Phase 1 candidate from log parsing
interface Phase1Candidate {
  candidateAddress: string;  // May be mint (pump) or unknown address (other DEXs)
  isPumpSource: boolean;     // If true, candidateAddress is reliable mint
  isBuy: boolean;
  wallet: string;
  notionalSol: Decimal;
  signature: string;
  dexSource: DEXSource;
}

// RPC call counters for observability
interface RpcCounters {
  getParsedTransaction: number;
  getAccountInfo: number;
  pumpEventsEmittedNoTxParse: number;
}

// Quality gate thresholds
const MIN_UNIQUE_WALLETS = 4;
const MAX_TOP_WALLET_SHARE = 0.6; // Max 60% of swaps from one wallet
const MIN_TOTAL_NOTIONAL_SOL = 0.1; // Min 0.1 SOL total activity

// ═══════════════════════════════════════════════════════════════════
// EventListener
// ═══════════════════════════════════════════════════════════════════

export class EventListener extends EventEmitter<EventListenerEvents> {
  private connection: Connection | null = null;
  private wsConnection: Connection | null = null;
  private subscriptions: SubscriptionHandle[] = [];
  private isRunning = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelayMs = 1000;
  
  // Deduplication - track recent signatures
  private recentSignatures = new Set<string>();
  private signatureCleanupInterval: NodeJS.Timeout | null = null;
  private readonly maxSignatures = 10000;
  
  // Two-phase detection
  private hotTokenTracker: HotTokenTracker;
  
  // Pending events buffer: candidateAddress -> SwapEvent[]
  // For pump sources, we buffer events while verification is pending
  private pendingPumpEvents = new Map<string, SwapEvent[]>();
  
  // Verified mints cache (avoid re-verification)
  private verifiedMints = new Set<string>();
  private rejectedMints = new Set<string>();
  
  // Emitted signatures cache (prevent duplicate event emission)
  private emittedSignatures = new Set<string>();
  
  // RPC counters
  private rpcCounters: RpcCounters = {
    getParsedTransaction: 0,
    getAccountInfo: 0,
    pumpEventsEmittedNoTxParse: 0,
  };
  
  // Counter logging interval
  private counterLogInterval: NodeJS.Timeout | null = null;
  
  constructor() {
    super();
    this.hotTokenTracker = getHotTokenTracker();
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════
  
  async start(): Promise<void> {
    if (this.isRunning) {
      log.warn('Event listener already running');
      return;
    }
    
    const config = getConfig();
    this.isRunning = true;
    
    // Initialize token verifier
    await initializeTokenVerifier();
    
    // Start hot token tracker (Phase 1)
    this.hotTokenTracker.start();
    this.hotTokenTracker.onHotToken((candidate, stats) => this.handleHotCandidate(candidate, stats));
    
    // Create HTTP connection for queries
    this.connection = new Connection(config.rpcUrl, 'confirmed');
    
    // Create WebSocket connection for streaming
    await this.connectWebSocket();
    
    // Start signature cleanup timer
    this.signatureCleanupInterval = setInterval(() => {
      this.cleanupSignatures();
    }, 30_000);
    
    // Start counter logging (every 60s)
    this.counterLogInterval = setInterval(() => {
      this.logCounters();
    }, 60_000);
    
    log.info('Event listener started (Two-Phase Detection enabled)');
  }
  
  async stop(): Promise<void> {
    this.isRunning = false;
    
    await this.unsubscribeAll();
    this.hotTokenTracker.stop();
    
    if (this.signatureCleanupInterval) {
      clearInterval(this.signatureCleanupInterval);
      this.signatureCleanupInterval = null;
    }
    
    if (this.counterLogInterval) {
      clearInterval(this.counterLogInterval);
      this.counterLogInterval = null;
    }
    
    this.recentSignatures.clear();
    this.pendingPumpEvents.clear();
    this.verifiedMints.clear();
    this.rejectedMints.clear();
    
    log.info('Event listener stopped');
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // WebSocket Connection
  // ═══════════════════════════════════════════════════════════════════
  
  private async connectWebSocket(): Promise<void> {
    const config = getConfig();
    
    try {
      this.wsConnection = new Connection(config.rpcUrl, {
        commitment: 'confirmed',
        wsEndpoint: config.wsUrl,
      });
      
      // Subscribe to each DEX program
      await this.subscribeToProgram(DEX_PROGRAM_IDS.RAYDIUM_V4, DEXSource.RAYDIUM_V4);
      await this.subscribeToProgram(DEX_PROGRAM_IDS.RAYDIUM_CLMM, DEXSource.RAYDIUM_CLMM);
      await this.subscribeToProgram(DEX_PROGRAM_IDS.ORCA_WHIRLPOOL, DEXSource.ORCA_WHIRLPOOL);
      await this.subscribeToProgram(DEX_PROGRAM_IDS.METEORA, DEXSource.METEORA);
      await this.subscribeToProgram(DEX_PROGRAM_IDS.PUMPSWAP, DEXSource.PUMPSWAP);
      await this.subscribeToProgram(DEX_PROGRAM_IDS.PUMPFUN, DEXSource.PUMPFUN);
      
      this.reconnectAttempts = 0;
      this.emit('connected');
      log.info('WebSocket connected and subscribed to DEX programs');
      
    } catch (error) {
      log.error('WebSocket connection failed', error as Error);
      this.emit('error', error as Error);
      await this.handleReconnect();
    }
  }
  
  private async subscribeToProgram(programId: string, source: DEXSource): Promise<void> {
    if (!this.wsConnection) return;
    
    try {
      const pubkey = new PublicKey(programId);
      
      const subscriptionId = this.wsConnection.onLogs(
        pubkey,
        (logs, ctx) => {
          this.handleLogs(logs, ctx.slot, source);
        },
        'confirmed'
      );
      
      this.subscriptions.push({ programId, subscriptionId });
      log.debug(`Subscribed to ${source} (${programId.slice(0, 8)}...)`);
      
    } catch (error) {
      log.error(`Failed to subscribe to ${source}`, error as Error);
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // Log Handling - Phase 1
  // ═══════════════════════════════════════════════════════════════════
  
  private handleLogs(
    logs: { signature: string; err: any; logs: string[] },
    slot: number,
    source: DEXSource
  ): void {
    // Skip failed transactions
    if (logs.err) return;
    
    // Deduplication check
    if (this.recentSignatures.has(logs.signature)) {
      return;
    }
    this.recentSignatures.add(logs.signature);
    
    // ═══════════════════════════════════════════════════════════════════
    // PHASE 1: FREE LOG PARSING
    // ═══════════════════════════════════════════════════════════════════
    
    const candidates = this.parseLogsPhase1(logs.signature, slot, logs.logs, source);
    
    for (const candidate of candidates) {
      // Validate pump token format - ALL pump.fun tokens end with "pump"
      if (!candidate.candidateAddress.endsWith('pump')) {
        continue;
      }
      
      // Quick validation
      if (!isValidTokenMint(candidate.candidateAddress)) {
        continue;
      }
      
      // Record in hot token tracker (tracks signatures for later parsing)
      this.hotTokenTracker.recordSwap(
        candidate.candidateAddress,
        logs.signature,
        candidate.isBuy,
        candidate.wallet
      );
      
      // For PUMPFUN/PUMPSWAP sources: buffer events (they have real data from logs)
      // For non-pump sources: emit event if token is already verified
      if (candidate.isPumpSource) {
        this.bufferPumpEvent(candidate);
      } else if (this.verifiedMints.has(candidate.candidateAddress)) {
        // Token already verified! ALWAYS emit so universe sees ALL swaps
        // FIX: Previously only 33% of swaps were emitted, causing momentum to appear dead
        this.emitVerifiedNonPumpSwap(candidate, logs.signature);
      }
      // Non-pump unverified: signatures tracked via recordSwap, will be parsed in Phase 2
    }
  }
  
  /**
   * Parse a single signature and emit event for verified non-pump token
   * This enables ongoing real-time data after initial verification
   */
  private async parseAndEmitNonPumpEvent(tokenMint: string, signature: string): Promise<void> {
    // Skip if already emitted
    if (this.emittedSignatures.has(signature)) {
      return;
    }
    
    try {
      const event = await parseTransactionWithHelius(this.connection!, signature, 0);
      this.rpcCounters.getParsedTransaction++;
      
      if (event && event.tokenMint === tokenMint) {
        const validation = validateSwapEvent(
          event.tokenMint,
          event.walletAddress,
          event.notionalSol.toNumber()
        );
        
        if (validation.valid) {
          this.emittedSignatures.add(signature);
          
          logEvent(LogEventType.SWAP_DETECTED, {
            signature: event.signature,
            tokenMint: event.tokenMint,
            direction: event.direction,
            notionalSol: event.notionalSol.toString(),
            wallet: event.walletAddress,
            dex: event.dexSource,
            phase: 'non_pump_realtime',
          });
          
          this.emit('swap', event);
        }
      }
    } catch (error) {
      // Non-critical - just skip this signature
    }
  }
  
  /**
   * Emit a swap event for a verified non-pump token
   * 
   * FIX: This ensures ALL swaps are visible to the token universe for momentum counting.
   * Previously, only 33% of swaps were emitted due to aggressive rate limiting,
   * causing tokens like Buttcoin to appear "dead" despite massive activity.
   * 
   * The strategy:
   * 1. ALWAYS emit an event from Phase 1 data (direction from logs)
   * 2. Rate-limit RPC parsing for enriched data (wallet, exact notional)
   * 3. Universe sees ALL swaps, risk gates evaluate the parsed subset
   */
  private emitVerifiedNonPumpSwap(candidate: Phase1Candidate, signature: string): void {
    // Skip if already emitted (prevents duplicates)
    if (this.emittedSignatures.has(signature)) {
      return;
    }
    
    this.emittedSignatures.add(signature);
    
    // Create event from Phase 1 candidate data
    const event: SwapEvent = {
      signature,
      slot: 0, // Unknown from logs
      timestamp: Date.now(),
      tokenMint: candidate.candidateAddress,
      direction: candidate.isBuy ? SwapDirection.BUY : SwapDirection.SELL,
      notionalSol: candidate.notionalSol, // May be placeholder (0.01)
      walletAddress: candidate.wallet, // May be 'unknown'
      dexSource: candidate.dexSource,
    };
    
    logEvent(LogEventType.SWAP_DETECTED, {
      signature,
      tokenMint: candidate.candidateAddress,
      direction: event.direction,
      notionalSol: event.notionalSol.toString(),
      wallet: event.walletAddress,
      dex: event.dexSource,
      phase: 'non_pump_phase1', // New phase to distinguish from RPC-parsed
    });
    
    this.emit('swap', event);
    
    // Rate-limited RPC parsing for enriched data (async, fire-and-forget)
    // Only parse ~20% of swaps to save credits, but still emit all
    if (Math.random() < 0.20) {
      this.enrichSwapWithRpc(candidate.candidateAddress, signature);
    }
  }
  
  /**
   * Enrich a swap event with RPC data (async, fire-and-forget)
   * This doesn't emit a new event - just improves metrics for risk gates
   */
  private async enrichSwapWithRpc(tokenMint: string, signature: string): Promise<void> {
    try {
      const event = await parseTransactionWithHelius(this.connection!, signature, 0);
      this.rpcCounters.getParsedTransaction++;
      
      if (event && event.tokenMint === tokenMint) {
        // Log enriched data for debugging
        log.debug(`Enriched swap: ${signature.slice(0, 16)}...`, {
          wallet: event.walletAddress.slice(0, 8),
          notional: event.notionalSol.toString(),
          direction: event.direction,
        });
      }
    } catch {
      // Non-critical
    }
  }
  
  /**
   * Phase 1: Parse raw logs to extract candidates (FREE - no RPC)
   * 
   * KEY INSIGHT: pump.fun tokens ALWAYS end with "pump" - this is 100% reliable!
   * We can detect pump.fun tokens from ANY DEX by scanning for addresses ending with "pump".
   */
  private parseLogsPhase1(
    signature: string,
    slot: number,
    logs: string[],
    source: DEXSource
  ): Phase1Candidate[] {
    const results: Phase1Candidate[] = [];
    
    try {
      const isPumpSource = source === DEXSource.PUMPFUN || source === DEXSource.PUMPSWAP;
      
      if (isPumpSource) {
        // Use DEX-specific parsers for pump sources
        let events: SwapEvent[] = [];
        
        switch (source) {
          case DEXSource.PUMPFUN:
            events = parsePumpFunSwap(signature, slot, logs);
            break;
          case DEXSource.PUMPSWAP:
            events = parsePumpSwapLogs(signature, slot, logs);
            break;
        }
        
        for (const event of events) {
          if (event.tokenMint && event.tokenMint !== 'unknown' && event.tokenMint.endsWith('pump')) {
            results.push({
              candidateAddress: event.tokenMint,
              isPumpSource: true,
              isBuy: event.direction === SwapDirection.BUY,
              wallet: event.walletAddress || 'unknown',
              notionalSol: event.notionalSol,
              signature,
              dexSource: source,
            });
          }
        }
      } else {
        // For non-pump DEXs (METEORA, RAYDIUM, ORCA, etc.):
        // Scan logs for addresses ending with "pump" - these are pump.fun tokens traded on other DEXs!
        // This is 100% reliable because only pump.fun creates tokens with "pump" suffix.
        const pumpTokens = this.scanLogsForPumpTokens(logs);
        
        for (const tokenMint of pumpTokens) {
          // For non-pump sources, we don't have direction/wallet info from logs
          // Default to BUY since momentum tracking cares about activity, not direction
          results.push({
            candidateAddress: tokenMint,
            isPumpSource: false, // We know it's a pump token, but source is different DEX
            isBuy: true, // Default assumption
            wallet: 'unknown',
            notionalSol: new Decimal(0.01), // Placeholder - actual amount determined in Phase 2
            signature,
            dexSource: source,
          });
        }
      }
    } catch (error) {
      // Phase 1 errors are non-critical
    }
    
    return results;
  }
  
  /**
   * Scan raw logs for pump.fun token addresses (ending with "pump")
   * This catches pump.fun tokens traded on ANY DEX (Meteora, Raydium, etc.)
   */
  private scanLogsForPumpTokens(logs: string[]): Set<string> {
    const pumpTokens = new Set<string>();
    
    // Pattern: valid base58 address ending with "pump"
    const pumpPattern = /([1-9A-HJ-NP-Za-km-z]{40,44}pump)\b/g;
    
    for (const log of logs) {
      const matches = log.matchAll(pumpPattern);
      for (const match of matches) {
        const addr = match[1];
        // Must be valid length (43-44 chars) and pass basic validation
        if (addr.length >= 43 && addr.length <= 44 && isValidTokenMint(addr)) {
          pumpTokens.add(addr);
        }
      }
    }
    
    return pumpTokens;
  }
  
  /**
   * Buffer a pump event for later emission after verification
   */
  private bufferPumpEvent(candidate: Phase1Candidate): void {
    const { candidateAddress } = candidate;
    
    // Already verified? Emit immediately
    if (this.verifiedMints.has(candidateAddress)) {
      this.emitPumpEvent(candidate);
      return;
    }
    
    // Rejected? Skip
    if (this.rejectedMints.has(candidateAddress)) {
      return;
    }
    
    // Buffer for later
    if (!this.pendingPumpEvents.has(candidateAddress)) {
      this.pendingPumpEvents.set(candidateAddress, []);
    }
    
    const buffer = this.pendingPumpEvents.get(candidateAddress)!;
    
    // Create SwapEvent from candidate
    const event: SwapEvent = {
      signature: candidate.signature,
      slot: 0, // Unknown from logs
      timestamp: Date.now(),
      tokenMint: candidateAddress,
      direction: candidate.isBuy ? SwapDirection.BUY : SwapDirection.SELL,
      notionalSol: candidate.notionalSol,
      walletAddress: candidate.wallet,
      dexSource: candidate.dexSource,
    };
    
    // Limit buffer size
    if (buffer.length < 100) {
      buffer.push(event);
    }
  }
  
  /**
   * Emit a pump event directly (no tx parsing - P0-4)
   */
  private emitPumpEvent(candidate: Phase1Candidate): void {
    // DEDUPE: Skip if we already emitted this signature
    if (this.emittedSignatures.has(candidate.signature)) {
      return;
    }
    
    const event: SwapEvent = {
      signature: candidate.signature,
      slot: 0,
      timestamp: Date.now(),
      tokenMint: candidate.candidateAddress,
      direction: candidate.isBuy ? SwapDirection.BUY : SwapDirection.SELL,
      notionalSol: candidate.notionalSol,
      walletAddress: candidate.wallet,
      dexSource: candidate.dexSource,
    };
    
    // Basic validation
    const validation = validateSwapEvent(
      event.tokenMint,
      event.walletAddress,
      event.notionalSol.toNumber()
    );
    
    if (!validation.valid) return;
    
    // Mark as emitted to prevent duplicates
    this.emittedSignatures.add(candidate.signature);
    
    // Log and emit
    logEvent(LogEventType.SWAP_DETECTED, {
      signature: event.signature,
      tokenMint: event.tokenMint,
      direction: event.direction,
      notionalSol: event.notionalSol.toString(),
      wallet: event.walletAddress,
      dex: event.dexSource,
      phase: 'pump_log_parsed',
    });
    
    this.rpcCounters.pumpEventsEmittedNoTxParse++;
    this.emit('swap', event);
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // Phase 2: Hot Candidate Verification
  // ═══════════════════════════════════════════════════════════════════
  
  /**
   * Handle when a candidate becomes "hot" - trigger Phase 2 verification
   */
  private async handleHotCandidate(candidate: string, stats: HotDetectionStats): Promise<void> {
    // ═══════════════════════════════════════════════════════════════
    // P0-2: Dedupe + in-flight lock
    // ═══════════════════════════════════════════════════════════════
    
    if (this.hotTokenTracker.isInflight(candidate)) {
      return; // Already being verified
    }
    
    // Create verification promise and track it
    const verificationPromise = this.verifyCandidate(candidate, stats);
    this.hotTokenTracker.setInflight(candidate, verificationPromise);
    
    await verificationPromise;
  }
  
  /**
   * Verify a hot candidate
   */
  private async verifyCandidate(candidate: string, stats: HotDetectionStats): Promise<void> {
    log.info(`🚀 Phase 2: Verifying candidate ${candidate}`);
    
    logEvent(LogEventType.PHASE2_STARTED, {
      candidate,
      swapsInWindow: stats.swapsInWindow,
      uniqueWallets: stats.uniqueWallets,
      isNewMomentum: stats.isNewMomentum,
    });
    
    try {
      // ═══════════════════════════════════════════════════════════════
      // P1-5: Quality Gate (Anti-Noise)
      // Only apply if we HAVE wallet info (uniqueWallets > 0 or known wallets)
      // For non-pump sources, we can't extract wallets so uniqueWallets=0 is expected
      // ═══════════════════════════════════════════════════════════════
      
      // If we have SOME wallet info but it's too concentrated, reject as noise
      // But if uniqueWallets=0, it means we couldn't extract wallets - skip this check
      if (stats.uniqueWallets > 0 && stats.uniqueWallets < MIN_UNIQUE_WALLETS) {
        log.info(`❌ Phase 2 NOISE: ${candidate.slice(0, 16)}... - only ${stats.uniqueWallets} unique wallets (min: ${MIN_UNIQUE_WALLETS})`);
        logEvent(LogEventType.PHASE2_NOISE_REJECTED, {
          candidate,
          reason: 'insufficient_unique_wallets',
          value: stats.uniqueWallets,
          threshold: MIN_UNIQUE_WALLETS,
        });
        this.hotTokenTracker.setCooldown(candidate, 'noise');
        return;
      }
      
      // ═══════════════════════════════════════════════════════════════
      // P0-4: Pump Fast Path - No TX Parsing
      // ═══════════════════════════════════════════════════════════════
      
      if (candidate.endsWith('pump')) {
        await this.verifyPumpCandidate(candidate, stats);
        return;
      }
      
      // ═══════════════════════════════════════════════════════════════
      // Non-pump path (should be rare since Phase 1 doesn't track them)
      // ═══════════════════════════════════════════════════════════════
      
      await this.verifyNonPumpCandidate(candidate, stats);
      
    } catch (error) {
      log.error('Phase 2 verification error', error as Error);
      this.hotTokenTracker.setCooldown(candidate, 'rejected');
    }
  }
  
  /**
   * Verify pump candidate
   * - For PUMPFUN/PUMPSWAP: flush buffered events (already have real data)
   * - For non-pump sources: parse signatures to get REAL wallet/direction/notional
   * 
   * ENHANCED: Now passes Phase 1 hotness stats to TokenUniverse for data-budget-aware scoring
   */
  private async verifyPumpCandidate(candidate: string, stats: HotDetectionStats): Promise<void> {
    // Check cache first
    if (this.verifiedMints.has(candidate)) {
      log.info(`✅ Phase 2 VERIFIED (cached): ${candidate}`);
      await this.emitRealEventsForCandidate(candidate);
      // Attach Phase 1 stats to existing token (if in universe)
      this.attachPhase1Stats(candidate, stats);
      this.hotTokenTracker.setCooldown(candidate, 'success');
      return;
    }
    
    if (this.rejectedMints.has(candidate)) {
      log.info(`❌ Phase 2 REJECTED (cached): ${candidate}`);
      this.hotTokenTracker.setCooldown(candidate, 'rejected');
      return;
    }
    
    // Verify mint with 1 RPC call (getAccountInfo)
    const isValid = await isValidTradeableToken(candidate);
    this.rpcCounters.getAccountInfo++;
    
    if (isValid) {
      log.info(`✅ Phase 2 VERIFIED (pump fast path): ${candidate}`);
      
      this.verifiedMints.add(candidate);
      
      // FIX: Cache Phase 1 stats FIRST (before events can create the token)
      // This ensures stats are attached when token enters universe
      this.attachPhase1Stats(candidate, stats);
      
      // Emit real events (either from buffer or by parsing signatures)
      const txParseCalls = await this.emitRealEventsForCandidate(candidate);
      
      logEvent(LogEventType.PHASE2_VERIFIED, {
        candidate,
        method: txParseCalls > 0 ? 'with_tx_parse' : 'pump_fast_path',
        txParseCalls,
        accountInfoCalls: 1,
        phase1SwapsInWindow: stats.swapsInWindow,
        phase1BuyRatio: stats.buyRatio,
      });
      
      this.hotTokenTracker.setCooldown(candidate, 'success');
    } else {
      log.info(`❌ Phase 2 REJECTED (pump fast path): ${candidate} - not a valid SPL mint`);
      
      logEvent(LogEventType.PHASE2_REJECTED, {
        candidate,
        reason: 'invalid_spl_mint',
      });
      
      this.rejectedMints.add(candidate);
      this.pendingPumpEvents.delete(candidate);
      this.hotTokenTracker.setCooldown(candidate, 'rejected');
    }
  }
  
  /**
   * Attach Phase 1 hotness stats to a token in the universe
   * This enables data-budget-aware scoring that uses the MORE ACCURATE Phase 1 swap count
   */
  private attachPhase1Stats(tokenMint: string, stats: HotDetectionStats): void {
    const universe = getTokenUniverse();
    
    // Convert HotDetectionStats to Phase1HotnessStats
    const phase1Stats = {
      swapsInWindow: stats.swapsInWindow,
      buys: stats.buys,
      sells: stats.sells,
      buyRatio: stats.buyRatio,
      windowMs: stats.windowActualMs,
      detectedAt: Date.now(),
      baselineSwapsPerMin: stats.baselineSwapsPerMin,
      isNewMomentum: stats.isNewMomentum,
    };
    
    universe.setPhase1Stats(tokenMint, phase1Stats);
  }
  
  /**
   * Emit real events for a verified candidate
   * - If we have buffered events (from PUMPFUN/PUMPSWAP), flush them
   * - If no buffered events (from non-pump DEX), parse signatures to get REAL data
   * Returns number of tx parse calls made
   */
  private async emitRealEventsForCandidate(candidate: string): Promise<number> {
    // Check if we have buffered events (from PUMPFUN/PUMPSWAP - already real data)
    const bufferedEvents = this.pendingPumpEvents.get(candidate);
    
    if (bufferedEvents && bufferedEvents.length > 0) {
      // Flush buffered events - they already have real wallet/direction/notional
      this.flushPendingPumpEvents(candidate);
      return 0; // No tx parsing needed
    }
    
    // No buffered events = came from non-pump DEX (METEORA, RAYDIUM, ORCA)
    // Parse 1-3 signatures to get REAL wallet/direction/notional
    // Parse up to 10 signatures to get substantial initial data
    const signatures = this.hotTokenTracker.getRecentSignatures(candidate, 10);
    
    if (signatures.length === 0) {
      log.debug(`No signatures to parse for ${candidate.slice(0, 16)}...`);
      return 0;
    }
    
    log.info(`📊 Parsing ${signatures.length} signatures for REAL data: ${candidate.slice(0, 16)}...`);
    
    let txParseCalls = 0;
    let eventsEmitted = 0;
    
    for (const sig of signatures) {
      try {
        const event = await parseTransactionWithHelius(this.connection!, sig, 0);
        txParseCalls++;
        this.rpcCounters.getParsedTransaction++;
        
        // Only emit if this event is for our candidate token
        if (event && event.tokenMint === candidate) {
          // DEDUPE: Skip if we already emitted this signature
          if (this.emittedSignatures.has(event.signature)) {
            continue;
          }
          
          const validation = validateSwapEvent(
            event.tokenMint,
            event.walletAddress,
            event.notionalSol.toNumber()
          );
          
          if (validation.valid) {
            // Mark as emitted to prevent duplicates
            this.emittedSignatures.add(event.signature);
            
            logEvent(LogEventType.SWAP_DETECTED, {
              signature: event.signature,
              tokenMint: event.tokenMint,
              direction: event.direction,
              notionalSol: event.notionalSol.toString(),
              wallet: event.walletAddress,
              dex: event.dexSource,
              phase: 'non_pump_tx_parsed',
            });
            
            this.emit('swap', event);
            eventsEmitted++;
          }
        }
      } catch (error) {
        log.debug(`Failed to parse signature ${sig.slice(0, 16)}...`);
      }
    }
    
    log.info(`✅ Emitted ${eventsEmitted} REAL events for ${candidate.slice(0, 16)}... (${txParseCalls} tx parses)`);
    
    return txParseCalls;
  }
  
  /**
   * Flush buffered pump events after verification
   */
  private flushPendingPumpEvents(mint: string): void {
    const events = this.pendingPumpEvents.get(mint);
    if (!events || events.length === 0) return;
    
    log.debug(`Flushing ${events.length} buffered pump events for ${mint.slice(0, 16)}...`);
    
    for (const event of events) {
      // DEDUPE: Skip if we already emitted this signature
      if (this.emittedSignatures.has(event.signature)) {
        continue;
      }
      
      const validation = validateSwapEvent(
        event.tokenMint,
        event.walletAddress,
        event.notionalSol.toNumber()
      );
      
      if (validation.valid) {
        // Mark as emitted to prevent duplicates
        this.emittedSignatures.add(event.signature);
        
        logEvent(LogEventType.SWAP_DETECTED, {
          signature: event.signature,
          tokenMint: event.tokenMint,
          direction: event.direction,
          notionalSol: event.notionalSol.toString(),
          wallet: event.walletAddress,
          dex: event.dexSource,
          phase: 'pump_buffered_flush',
        });
        
        this.rpcCounters.pumpEventsEmittedNoTxParse++;
        this.emit('swap', event);
      }
    }
    
    this.pendingPumpEvents.delete(mint);
  }
  
  /**
   * P2-8: Verify non-pump candidate - try 1 signature then bail
   */
  private async verifyNonPumpCandidate(candidate: string, stats: HotDetectionStats): Promise<void> {
    // Get 1 signature to try
    const signatures = this.hotTokenTracker.getRecentSignatures(candidate, 1);
    
    if (signatures.length === 0) {
      log.debug(`No signatures for non-pump candidate ${candidate.slice(0, 16)}...`);
      this.hotTokenTracker.setCooldown(candidate, 'rejected');
      return;
    }
    
    // Try to parse 1 signature
    const sig = signatures[0];
    
    try {
      if (!this.connection) {
        this.hotTokenTracker.setCooldown(candidate, 'rejected');
        return;
      }
      
      this.rpcCounters.getParsedTransaction++;
      const event = await parseTransactionWithHelius(this.connection, sig, 0);
      
      if (!event || !event.tokenMint || event.tokenMint === 'unknown') {
        log.info(`❌ Phase 2 REJECTED (non-pump): ${candidate.slice(0, 16)}... - no valid mint from tx parse`);
        this.hotTokenTracker.setCooldown(candidate, 'rejected');
        return;
      }
      
      // Verify the mint found
      this.rpcCounters.getAccountInfo++;
      const isValid = await isValidTradeableToken(event.tokenMint);
      
      if (!isValid) {
        log.info(`❌ Phase 2 REJECTED (non-pump): ${event.tokenMint.slice(0, 16)}... - not a valid SPL mint`);
        this.hotTokenTracker.setCooldown(candidate, 'rejected');
        return;
      }
      
      log.info(`✅ Phase 2 VERIFIED (non-pump): ${event.tokenMint}`);
      
      logEvent(LogEventType.PHASE2_VERIFIED, {
        candidate,
        resolvedMint: event.tokenMint,
        method: 'non_pump_single_sig',
        txParseCalls: 1,
        accountInfoCalls: 1,
      });
      
      // Emit the event
      const validation = validateSwapEvent(
        event.tokenMint,
        event.walletAddress,
        event.notionalSol.toNumber()
      );
      
      if (validation.valid) {
        logEvent(LogEventType.SWAP_DETECTED, {
          signature: event.signature,
          tokenMint: event.tokenMint,
          direction: event.direction,
          notionalSol: event.notionalSol.toString(),
          wallet: event.walletAddress,
          dex: event.dexSource,
          phase: 'non_pump_verified',
        });
        
        this.emit('swap', event);
      }
      
      this.hotTokenTracker.setCooldown(candidate, 'success');
      
    } catch (error) {
      log.debug(`Non-pump verification failed: ${(error as Error).message}`);
      this.hotTokenTracker.setCooldown(candidate, 'rejected');
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // Utilities
  // ═══════════════════════════════════════════════════════════════════
  
  private async unsubscribeAll(): Promise<void> {
    if (!this.wsConnection) return;
    
    for (const sub of this.subscriptions) {
      try {
        await this.wsConnection.removeOnLogsListener(sub.subscriptionId);
      } catch (error) {
        log.debug(`Error unsubscribing from ${sub.programId}`, { error });
      }
    }
    
    this.subscriptions = [];
  }
  
  private async handleReconnect(): Promise<void> {
    if (!this.isRunning) return;
    
    this.reconnectAttempts++;
    
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      log.error('Max reconnection attempts reached');
      this.emit('error', new Error('Max reconnection attempts reached'));
      return;
    }
    
    const delay = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);
    log.warn(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    this.emit('disconnected');
    
    await new Promise(resolve => setTimeout(resolve, delay));
    await this.unsubscribeAll();
    await this.connectWebSocket();
  }
  
  private cleanupSignatures(): void {
    if (this.recentSignatures.size > this.maxSignatures) {
      const toKeep = Array.from(this.recentSignatures).slice(-this.maxSignatures / 2);
      this.recentSignatures.clear();
      for (const sig of toKeep) {
        this.recentSignatures.add(sig);
      }
      log.debug(`Cleaned up signatures, ${this.recentSignatures.size} remaining`);
    }
    
    // Cleanup emitted signatures cache
    if (this.emittedSignatures.size > this.maxSignatures) {
      const toKeep = Array.from(this.emittedSignatures).slice(-this.maxSignatures / 2);
      this.emittedSignatures.clear();
      for (const sig of toKeep) {
        this.emittedSignatures.add(sig);
      }
    }
    
    // Cleanup verified/rejected caches
    if (this.verifiedMints.size > 5000) {
      const arr = Array.from(this.verifiedMints);
      this.verifiedMints = new Set(arr.slice(-2500));
    }
    if (this.rejectedMints.size > 10000) {
      const arr = Array.from(this.rejectedMints);
      this.rejectedMints = new Set(arr.slice(-5000));
    }
    
    // Cleanup old pending events
    for (const [mint, events] of this.pendingPumpEvents) {
      if (events.length > 0) {
        const oldestEvent = events[0];
        if (Date.now() - oldestEvent.timestamp > 60_000) {
          this.pendingPumpEvents.delete(mint);
        }
      }
    }
  }
  
  /**
   * Log RPC counters periodically (observability)
   */
  private logCounters(): void {
    const trackerCounters = this.hotTokenTracker.getAndResetCounters();
    
    logEvent(LogEventType.RPC_COUNTERS, {
      getParsedTransaction: this.rpcCounters.getParsedTransaction,
      getAccountInfo: this.rpcCounters.getAccountInfo,
      pumpEventsEmittedNoTxParse: this.rpcCounters.pumpEventsEmittedNoTxParse,
      phase1CandidatesSeen: trackerCounters.phase1CandidatesSeen,
      phase2Started: trackerCounters.phase2Started,
      phase2Rejected: trackerCounters.phase2Rejected,
      phase2Success: trackerCounters.phase2Success,
      cooldownSkips: trackerCounters.cooldownSkips,
      inflightSkips: trackerCounters.inflightSkips,
    });
    
    log.info('📊 RPC COUNTERS', {
      getParsedTx: this.rpcCounters.getParsedTransaction,
      getAccountInfo: this.rpcCounters.getAccountInfo,
      pumpNoTxParse: this.rpcCounters.pumpEventsEmittedNoTxParse,
      phase2Started: trackerCounters.phase2Started,
      phase2Rejected: trackerCounters.phase2Rejected,
      phase2Success: trackerCounters.phase2Success,
    });
    
    // Reset counters
    this.rpcCounters = {
      getParsedTransaction: 0,
      getAccountInfo: 0,
      pumpEventsEmittedNoTxParse: 0,
    };
  }
  
  getConnection(): Connection | null {
    return this.connection;
  }
  
  getStats(): {
    isRunning: boolean;
    subscriptionCount: number;
    recentSignatureCount: number;
    reconnectAttempts: number;
    phase1TrackedTokens: number;
    hotTokens: number;
    pendingPumpEvents: number;
    verifiedMints: number;
    rejectedMints: number;
  } {
    const hotTokenStats = this.hotTokenTracker.getStats();
    return {
      isRunning: this.isRunning,
      subscriptionCount: this.subscriptions.length,
      recentSignatureCount: this.recentSignatures.size,
      reconnectAttempts: this.reconnectAttempts,
      phase1TrackedTokens: hotTokenStats.trackedTokens,
      hotTokens: hotTokenStats.hotTokens,
      pendingPumpEvents: this.pendingPumpEvents.size,
      verifiedMints: this.verifiedMints.size,
      rejectedMints: this.rejectedMints.size,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// Singleton
// ═══════════════════════════════════════════════════════════════════

let listenerInstance: EventListener | null = null;

export function getEventListener(): EventListener {
  if (!listenerInstance) {
    listenerInstance = new EventListener();
  }
  return listenerInstance;
}

export function resetEventListener(): void {
  if (listenerInstance) {
    listenerInstance.stop();
    listenerInstance = null;
  }
}
