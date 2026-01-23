/**
 * Efficient sliding window implementation for time-series metrics.
 * Uses a deque-like structure with lazy cleanup for O(1) insertions.
 */

import Decimal from 'decimal.js';
import { SwapEvent, SwapDirection, WindowMetrics, DEXSource } from '../types';

interface TimestampedEvent {
  timestamp: number;
  event: SwapEvent;
}

/**
 * RollingWindow maintains a time-bounded sliding window of swap events
 * with O(1) insertion and amortized O(1) metric updates.
 */
export class RollingWindow {
  private events: TimestampedEvent[] = [];
  private windowSizeMs: number;
  
  // Incrementally maintained metrics (avoid full recomputation)
  private _swapCount = 0;
  private _buyCount = 0;
  private _sellCount = 0;
  private _buyNotional = new Decimal(0);
  private _sellNotional = new Decimal(0);
  private _uniqueBuyers = new Map<string, Decimal>(); // wallet -> total buy volume
  private _uniqueSellers = new Map<string, Decimal>(); // wallet -> total sell volume
  private _firstPrice: Decimal | null = null;
  private _lastPrice: Decimal | null = null;
  
  constructor(windowSizeMs: number) {
    this.windowSizeMs = windowSizeMs;
  }
  
  // Minimum notional to count as a real trade (filter dust/dead tokens)
  // Only applied to pump.fun bonding curve events (where we have real data)
  // Raydium/Meteora events have placeholder notional and shouldn't be filtered
  private static readonly MIN_NOTIONAL_SOL = 0.05;
  
  // Placeholder values used when we can't parse real data
  private static readonly PLACEHOLDER_NOTIONAL = 0.01;
  
  /**
   * Add a new event to the window.
   * Returns true if window state changed (for triggering score updates).
   */
  addEvent(event: SwapEvent): boolean {
    const now = Date.now();
    
    // First, expire old events
    this.expireOldEvents(now);
    
    // DUST FILTER: Skip trades with negligible notional value
    // BUT: Only apply to pump.fun events (where we have REAL data from IDL)
    // Raydium/Meteora events have placeholder notional - don't filter those!
    const notionalNum = event.notionalSol.toNumber();
    const isPumpfunSource = event.dexSource === DEXSource.PUMPFUN || event.dexSource === DEXSource.PUMPSWAP;
    const isPlaceholderNotional = Math.abs(notionalNum - RollingWindow.PLACEHOLDER_NOTIONAL) < 0.001;
    
    // Only filter dust for pump.fun where we KNOW the real notional
    // For Raydium/Meteora, trust swap count as momentum signal
    if (isPumpfunSource && !isPlaceholderNotional && notionalNum < RollingWindow.MIN_NOTIONAL_SOL) {
      return false;
    }
    
    // Add new event
    this.events.push({ timestamp: event.timestamp, event });
    
    // Update incremental metrics
    this._swapCount++;
    
    if (event.direction === SwapDirection.BUY) {
      this._buyCount++;
      this._buyNotional = this._buyNotional.plus(event.notionalSol);
      
      // FIX: Don't count 'unknown' wallets as unique buyers
      // Phase 1 events have placeholder wallets - counting them inflates buyer count artificially
      if (event.walletAddress !== 'unknown') {
        const existing = this._uniqueBuyers.get(event.walletAddress) || new Decimal(0);
        this._uniqueBuyers.set(event.walletAddress, existing.plus(event.notionalSol));
      }
    } else {
      this._sellCount++;
      this._sellNotional = this._sellNotional.plus(event.notionalSol);
      
      // FIX: Don't count 'unknown' wallets as unique sellers
      if (event.walletAddress !== 'unknown') {
        const existing = this._uniqueSellers.get(event.walletAddress) || new Decimal(0);
        this._uniqueSellers.set(event.walletAddress, existing.plus(event.notionalSol));
      }
    }
    
    // Track prices for price change calculation
    // Estimate price from notional/swap (simplified)
    if (this._firstPrice === null) {
      this._firstPrice = event.notionalSol;
    }
    this._lastPrice = event.notionalSol;
    
    return true;
  }
  
  /**
   * Remove events outside the window
   */
  private expireOldEvents(now: number): void {
    const cutoff = now - this.windowSizeMs;
    
    while (this.events.length > 0 && this.events[0].timestamp < cutoff) {
      const expired = this.events.shift()!;
      this.removeEventFromMetrics(expired.event);
    }
    
    // Update first price after expiration
    if (this.events.length > 0) {
      this._firstPrice = this.events[0].event.notionalSol;
    } else {
      this._firstPrice = null;
      this._lastPrice = null;
    }
  }
  
  /**
   * Decrement metrics when an event expires
   */
  private removeEventFromMetrics(event: SwapEvent): void {
    this._swapCount--;
    
    if (event.direction === SwapDirection.BUY) {
      this._buyCount--;
      this._buyNotional = this._buyNotional.minus(event.notionalSol);
      
      // FIX: Match the add logic - don't touch unknown wallets
      if (event.walletAddress !== 'unknown') {
        const existing = this._uniqueBuyers.get(event.walletAddress);
        if (existing) {
          const newVal = existing.minus(event.notionalSol);
          if (newVal.lte(0)) {
            this._uniqueBuyers.delete(event.walletAddress);
          } else {
            this._uniqueBuyers.set(event.walletAddress, newVal);
          }
        }
      }
    } else {
      this._sellCount--;
      this._sellNotional = this._sellNotional.minus(event.notionalSol);
      
      // FIX: Match the add logic - don't touch unknown wallets
      if (event.walletAddress !== 'unknown') {
        const existing = this._uniqueSellers.get(event.walletAddress);
        if (existing) {
          const newVal = existing.minus(event.notionalSol);
          if (newVal.lte(0)) {
            this._uniqueSellers.delete(event.walletAddress);
          } else {
            this._uniqueSellers.set(event.walletAddress, newVal);
          }
        }
      }
    }
  }
  
  /**
   * Force expire events (call periodically even without new events)
   */
  tick(): void {
    this.expireOldEvents(Date.now());
  }
  
  /**
   * Calculate top buyer concentration (% of buy volume from largest buyer)
   */
  private calculateTopBuyerConcentration(): number {
    if (this._buyNotional.isZero() || this._uniqueBuyers.size === 0) {
      return 0;
    }
    
    let maxVolume = new Decimal(0);
    for (const volume of this._uniqueBuyers.values()) {
      if (volume.gt(maxVolume)) {
        maxVolume = volume;
      }
    }
    
    return maxVolume.div(this._buyNotional).mul(100).toNumber();
  }
  
  /**
   * Calculate approximate price change within window
   */
  private calculatePriceChange(): number {
    if (!this._firstPrice || !this._lastPrice || this._firstPrice.isZero()) {
      return 0;
    }
    
    // This is a rough approximation - real price would need pool state
    // We use notional as a proxy which isn't perfect but indicates relative changes
    return this._lastPrice.minus(this._firstPrice)
      .div(this._firstPrice)
      .mul(100)
      .toNumber();
  }
  
  /**
   * Get current window metrics
   */
  getMetrics(): WindowMetrics {
    // Ensure we're up to date
    this.tick();
    
    return {
      windowSizeMs: this.windowSizeMs,
      swapCount: this._swapCount,
      buyCount: this._buyCount,
      sellCount: this._sellCount,
      buyNotional: this._buyNotional,
      sellNotional: this._sellNotional,
      netInflow: this._buyNotional.minus(this._sellNotional),
      uniqueBuyers: new Set(this._uniqueBuyers.keys()),
      uniqueSellers: new Set(this._uniqueSellers.keys()),
      topBuyerConcentration: this.calculateTopBuyerConcentration(),
      priceChangePercent: this.calculatePriceChange(),
      firstTimestamp: this.events.length > 0 ? this.events[0].timestamp : 0,
      lastTimestamp: this.events.length > 0 ? this.events[this.events.length - 1].timestamp : 0,
    };
  }
  
  /**
   * Get raw event count (for debugging)
   */
  get eventCount(): number {
    return this.events.length;
  }
  
  /**
   * Clear all events
   */
  clear(): void {
    this.events = [];
    this._swapCount = 0;
    this._buyCount = 0;
    this._sellCount = 0;
    this._buyNotional = new Decimal(0);
    this._sellNotional = new Decimal(0);
    this._uniqueBuyers.clear();
    this._uniqueSellers.clear();
    this._firstPrice = null;
    this._lastPrice = null;
  }
}

/**
 * Factory to create standard window set for a token
 */
export function createWindowSet(): {
  '5s': RollingWindow;
  '15s': RollingWindow;
  '60s': RollingWindow;
} {
  return {
    '5s': new RollingWindow(5_000),
    '15s': new RollingWindow(15_000),
    '60s': new RollingWindow(60_000),
  };
}
