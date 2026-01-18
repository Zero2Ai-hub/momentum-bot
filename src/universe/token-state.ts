/**
 * Per-token state management.
 * Maintains rolling windows and metrics for a single token.
 */

import Decimal from 'decimal.js';
import { SwapEvent, TokenMetrics, WindowMetrics, WindowSize, WINDOW_SIZES } from '../types';
import { RollingWindow, createWindowSet } from '../analytics/rolling-window';

export class TokenState {
  readonly tokenMint: string;
  
  private windows: {
    '5s': RollingWindow;
    '15s': RollingWindow;
    '60s': RollingWindow;
  };
  
  private _allTimeSwapCount = 0;
  private _firstSeenTimestamp: number;
  private _lastActivityTimestamp: number;
  private _estimatedPrice = new Decimal(0);
  private _estimatedLiquidity = new Decimal(0);
  
  // For momentum confirmation tracking
  private _consecutiveAboveEntryMs = 0;
  private _lastScoreCheckTimestamp = 0;
  private _consecutiveNegativeInflowMs = 0;
  
  constructor(tokenMint: string, firstEvent: SwapEvent) {
    this.tokenMint = tokenMint;
    this.windows = createWindowSet();
    this._firstSeenTimestamp = firstEvent.timestamp;
    this._lastActivityTimestamp = firstEvent.timestamp;
    
    // Process first event
    this.processSwap(firstEvent);
  }
  
  /**
   * Process a new swap event
   */
  processSwap(event: SwapEvent): void {
    // Update all windows
    this.windows['5s'].addEvent(event);
    this.windows['15s'].addEvent(event);
    this.windows['60s'].addEvent(event);
    
    // Update state
    this._allTimeSwapCount++;
    this._lastActivityTimestamp = event.timestamp;
    
    // Update estimated price (simplified - uses notional as proxy)
    // In production, you'd query actual pool price
    if (event.notionalSol.gt(0)) {
      this._estimatedPrice = event.notionalSol;
    }
  }
  
  /**
   * Update liquidity estimate (called from external source)
   */
  updateLiquidity(liquiditySol: Decimal): void {
    this._estimatedLiquidity = liquiditySol;
  }
  
  /**
   * Tick all windows to expire old events
   */
  tick(): void {
    this.windows['5s'].tick();
    this.windows['15s'].tick();
    this.windows['60s'].tick();
  }
  
  /**
   * Get metrics for a specific window
   */
  getWindowMetrics(windowSize: WindowSize): WindowMetrics {
    return this.windows[windowSize].getMetrics();
  }
  
  /**
   * Get complete token metrics
   */
  getMetrics(): TokenMetrics {
    return {
      tokenMint: this.tokenMint,
      windows: {
        '5s': this.windows['5s'].getMetrics(),
        '15s': this.windows['15s'].getMetrics(),
        '60s': this.windows['60s'].getMetrics(),
      },
      allTimeSwapCount: this._allTimeSwapCount,
      firstSeenTimestamp: this._firstSeenTimestamp,
      lastActivityTimestamp: this._lastActivityTimestamp,
      estimatedPrice: this._estimatedPrice,
      estimatedLiquidity: this._estimatedLiquidity,
    };
  }
  
  /**
   * Check if token has been inactive for given duration
   */
  isInactiveSince(durationMs: number): boolean {
    return Date.now() - this._lastActivityTimestamp > durationMs;
  }
  
  /**
   * Track consecutive time above entry threshold
   */
  updateAboveEntryTracking(isAboveThreshold: boolean): void {
    const now = Date.now();
    
    if (this._lastScoreCheckTimestamp > 0) {
      const elapsed = now - this._lastScoreCheckTimestamp;
      
      if (isAboveThreshold) {
        this._consecutiveAboveEntryMs += elapsed;
      } else {
        this._consecutiveAboveEntryMs = 0;
      }
    }
    
    this._lastScoreCheckTimestamp = now;
  }
  
  /**
   * Track consecutive negative inflow periods
   */
  updateNegativeInflowTracking(netInflow: Decimal): void {
    const now = Date.now();
    
    if (this._lastScoreCheckTimestamp > 0) {
      const elapsed = now - this._lastScoreCheckTimestamp;
      
      if (netInflow.lt(0)) {
        this._consecutiveNegativeInflowMs += elapsed;
      } else {
        this._consecutiveNegativeInflowMs = 0;
      }
    }
  }
  
  /**
   * Get consecutive time above entry threshold in seconds
   */
  get consecutiveAboveEntrySeconds(): number {
    return this._consecutiveAboveEntryMs / 1000;
  }
  
  /**
   * Get consecutive negative inflow time in seconds
   */
  get consecutiveNegativeInflowSeconds(): number {
    return this._consecutiveNegativeInflowMs / 1000;
  }
  
  /**
   * Reset confirmation tracking (after entry)
   */
  resetConfirmationTracking(): void {
    this._consecutiveAboveEntryMs = 0;
    this._lastScoreCheckTimestamp = Date.now();
  }
  
  // Getters
  get allTimeSwapCount(): number {
    return this._allTimeSwapCount;
  }
  
  get firstSeenTimestamp(): number {
    return this._firstSeenTimestamp;
  }
  
  get lastActivityTimestamp(): number {
    return this._lastActivityTimestamp;
  }
  
  get estimatedPrice(): Decimal {
    return this._estimatedPrice;
  }
  
  get estimatedLiquidity(): Decimal {
    return this._estimatedLiquidity;
  }
}
