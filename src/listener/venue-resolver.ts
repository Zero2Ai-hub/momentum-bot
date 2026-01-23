/**
 * Venue Resolver
 * 
 * Determines the optimal DEX to use for parsing swap data for a given token.
 * 
 * PRIORITY ORDER (for pump-origin tokens):
 * 1. PumpSwap - graduated tokens trade here, cheap to parse via IDL
 * 2. Pump.fun bonding curve - ungraduated tokens
 * 3. Meteora/Orca/Raydium - fallback, may need expensive Helius parsing
 * 
 * APPROACH: Instead of complex pool derivation (which differs per program),
 * we track which tokens we've OBSERVED on each DEX via WebSocket.
 * This is FREE (no RPC) and 100% accurate.
 */

import { log } from '../logging/logger';
import { DEXSource, LogEventType } from '../types';
import { logEvent } from '../logging/logger';

// ═══════════════════════════════════════════════════════════════════
// Observed Venues Cache
// Tracks which DEX we've seen each token on (populated by event listener)
// ═══════════════════════════════════════════════════════════════════

// Map: tokenMint -> Set of DEXSources observed
const observedVenues = new Map<string, Set<DEXSource>>();

// Cache cleanup settings
const CACHE_MAX_SIZE = 10000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Track last access time for LRU eviction
const lastAccessTime = new Map<string, number>();

/**
 * Record that a token was observed trading on a specific DEX
 * Called by event listener when parsing logs
 */
export function recordTokenVenue(mint: string, dexSource: DEXSource): void {
  if (!observedVenues.has(mint)) {
    observedVenues.set(mint, new Set());
  }
  
  observedVenues.get(mint)!.add(dexSource);
  lastAccessTime.set(mint, Date.now());
  
  // Cleanup if cache too large
  if (observedVenues.size > CACHE_MAX_SIZE) {
    cleanupCache();
  }
}

/**
 * Get observed venues for a token
 */
export function getObservedVenues(mint: string): DEXSource[] {
  const venues = observedVenues.get(mint);
  if (venues) {
    lastAccessTime.set(mint, Date.now());
    return Array.from(venues);
  }
  return [];
}

/**
 * Check if token has been observed on PumpSwap
 */
export function hasBeenOnPumpSwap(mint: string): boolean {
  const venues = observedVenues.get(mint);
  return venues?.has(DEXSource.PUMPSWAP) ?? false;
}

/**
 * Check if token has been observed on pump.fun bonding curve
 */
export function hasBeenOnPumpFun(mint: string): boolean {
  const venues = observedVenues.get(mint);
  return venues?.has(DEXSource.PUMPFUN) ?? false;
}

function cleanupCache(): void {
  const now = Date.now();
  const toDelete: string[] = [];
  
  // Find expired entries
  for (const [mint, time] of lastAccessTime) {
    if (now - time > CACHE_TTL_MS) {
      toDelete.push(mint);
    }
  }
  
  // If still too large after TTL cleanup, remove oldest
  if (observedVenues.size - toDelete.length > CACHE_MAX_SIZE * 0.8) {
    const sortedByTime = Array.from(lastAccessTime.entries())
      .sort((a, b) => a[1] - b[1]);
    
    const removeCount = Math.floor(CACHE_MAX_SIZE * 0.2);
    for (let i = 0; i < removeCount && i < sortedByTime.length; i++) {
      toDelete.push(sortedByTime[i][0]);
    }
  }
  
  for (const mint of toDelete) {
    observedVenues.delete(mint);
    lastAccessTime.delete(mint);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Venue Resolution
// ═══════════════════════════════════════════════════════════════════

export type VenueResolution = {
  chosenVenue: DEXSource;
  tried: DEXSource[];
  reason: string;
  observedVenues?: DEXSource[];
};

export type VenueResolverConfig = {
  preferPumpSwapForPumpMints: boolean;
};

const defaultConfig: VenueResolverConfig = {
  preferPumpSwapForPumpMints: true,
};

/**
 * Check if a mint is pump-origin (created on pump.fun)
 * All pump.fun tokens end with 'pump' - this is a platform invariant
 */
export function isPumpOriginMint(mint: string): boolean {
  return mint.endsWith('pump');
}

/**
 * Resolve the best venue for parsing swap data for a given mint
 * 
 * STRATEGY:
 * 1. If detected from PumpSwap/PumpFun, use that (already have IDL data)
 * 2. If detected from Raydium/Meteora but we've SEEN this token on PumpSwap before,
 *    prefer PumpSwap (we'll get better data from PumpSwap subscription)
 * 3. Otherwise, use detected source with limited parsing
 * 
 * NO RPC CALLS - uses observation-based cache only!
 */
export function resolveVenueForMint(
  mint: string,
  detectedSource: DEXSource,
  config: Partial<VenueResolverConfig> = {}
): VenueResolution {
  const cfg = { ...defaultConfig, ...config };
  const tried: DEXSource[] = [];
  const isPumpOrigin = isPumpOriginMint(mint);
  const observed = getObservedVenues(mint);
  
  logEvent(LogEventType.VENUE_RESOLVE_START, {
    mint: mint.slice(0, 16),
    detectedSource,
    isPumpOrigin,
    observedVenues: observed,
  });
  
  // ═══════════════════════════════════════════════════════════════
  // Case 1: Non-pump origin tokens - use detected source
  // ═══════════════════════════════════════════════════════════════
  
  if (!isPumpOrigin || !cfg.preferPumpSwapForPumpMints) {
    const result: VenueResolution = {
      chosenVenue: detectedSource,
      tried: [detectedSource],
      reason: isPumpOrigin ? 'pumpswap_preference_disabled' : 'not_pump_origin',
    };
    logEvent(LogEventType.VENUE_RESOLVE_RESULT, result);
    return result;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // Case 2: Detected from PumpSwap - perfect, use directly
  // ═══════════════════════════════════════════════════════════════
  
  if (detectedSource === DEXSource.PUMPSWAP) {
    const result: VenueResolution = {
      chosenVenue: DEXSource.PUMPSWAP,
      tried: [DEXSource.PUMPSWAP],
      reason: 'detected_from_pumpswap',
      observedVenues: observed,
    };
    log.info(`🎯 VENUE: ${mint.slice(0, 16)}... → PumpSwap (detected directly)`);
    logEvent(LogEventType.VENUE_RESOLVE_RESULT, result);
    return result;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // Case 3: Detected from pump.fun bonding curve - use it
  // ═══════════════════════════════════════════════════════════════
  
  if (detectedSource === DEXSource.PUMPFUN) {
    const result: VenueResolution = {
      chosenVenue: DEXSource.PUMPFUN,
      tried: [DEXSource.PUMPFUN],
      reason: 'detected_from_pumpfun_bonding_curve',
      observedVenues: observed,
    };
    logEvent(LogEventType.VENUE_RESOLVE_RESULT, result);
    return result;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // Case 4: Detected from Raydium/Meteora - check if we've seen it on PumpSwap
  // ═══════════════════════════════════════════════════════════════
  
  tried.push(DEXSource.PUMPSWAP);
  
  if (observed.includes(DEXSource.PUMPSWAP)) {
    // We've seen this token on PumpSwap before!
    // This means it's graduated and actively trading on PumpSwap
    const result: VenueResolution = {
      chosenVenue: DEXSource.PUMPSWAP,
      tried,
      reason: 'previously_observed_on_pumpswap',
      observedVenues: observed,
    };
    log.info(`🎯 VENUE: ${mint.slice(0, 16)}... → PumpSwap (previously observed)`);
    logEvent(LogEventType.VENUE_RESOLVE_RESULT, result);
    return result;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // Case 5: Never seen on PumpSwap - fallback to detected source
  // ═══════════════════════════════════════════════════════════════
  
  tried.push(detectedSource);
  
  const result: VenueResolution = {
    chosenVenue: detectedSource,
    tried,
    reason: 'not_observed_on_pumpswap',
    observedVenues: observed,
  };
  
  log.info(`⚠️ VENUE: ${mint.slice(0, 16)}... → ${detectedSource} (not seen on PumpSwap yet)`);
  logEvent(LogEventType.VENUE_RESOLVE_RESULT, result);
  return result;
}

/**
 * Clear the venue cache (for testing)
 */
export function clearVenueCache(): void {
  observedVenues.clear();
  lastAccessTime.clear();
}

/**
 * Get venue cache stats (for debugging)
 */
export function getVenueCacheStats(): { 
  size: number; 
  pumpSwapCount: number;
  pumpFunCount: number;
} {
  let pumpSwapCount = 0;
  let pumpFunCount = 0;
  
  for (const venues of observedVenues.values()) {
    if (venues.has(DEXSource.PUMPSWAP)) pumpSwapCount++;
    if (venues.has(DEXSource.PUMPFUN)) pumpFunCount++;
  }
  
  return {
    size: observedVenues.size,
    pumpSwapCount,
    pumpFunCount,
  };
}
