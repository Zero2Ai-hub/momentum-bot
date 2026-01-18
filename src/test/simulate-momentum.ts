/**
 * Momentum Logic Simulation
 * Shows exactly how scoring evolves over a 90-second timeline.
 * 
 * Run with: npx ts-node src/test/simulate-momentum.ts
 */

import Decimal from 'decimal.js';
import { SwapEvent, SwapDirection, DEXSource } from '../types';
import { TokenState } from '../universe/token-state';
import { MomentumScorer } from '../scoring/momentum-scorer';

// ─────────────────────────────────────────────────────────────
// SYNTHETIC EVENT STREAM: 90 seconds of "MoonToken"
// ─────────────────────────────────────────────────────────────

const TOKEN_MINT = 'MoonTokenXYZ123456789012345678901234567890';

function createSwap(
  timestamp: number,
  direction: SwapDirection,
  notionalSol: number,
  wallet: string
): SwapEvent {
  return {
    signature: `sig_${timestamp}_${Math.random().toString(36).slice(2)}`,
    slot: 0,
    timestamp,
    tokenMint: TOKEN_MINT,
    direction,
    notionalSol: new Decimal(notionalSol),
    walletAddress: wallet,
    dexSource: DEXSource.RAYDIUM_V4,
  };
}

// Generate synthetic swap stream
function generateSwapStream(): SwapEvent[] {
  const baseTime = Date.now();
  const events: SwapEvent[] = [];
  
  // Phase 1: T=0-20s - Dormant/Low activity
  events.push(createSwap(baseTime + 0, SwapDirection.BUY, 0.1, 'wallet_A'));
  events.push(createSwap(baseTime + 5000, SwapDirection.BUY, 0.05, 'wallet_B'));
  events.push(createSwap(baseTime + 12000, SwapDirection.SELL, 0.03, 'wallet_A'));
  events.push(createSwap(baseTime + 18000, SwapDirection.BUY, 0.08, 'wallet_C'));
  
  // Phase 2: T=20-40s - Momentum building
  events.push(createSwap(baseTime + 22000, SwapDirection.BUY, 0.3, 'wallet_D'));
  events.push(createSwap(baseTime + 24000, SwapDirection.BUY, 0.25, 'wallet_E'));
  events.push(createSwap(baseTime + 26000, SwapDirection.BUY, 0.4, 'wallet_F'));
  events.push(createSwap(baseTime + 28000, SwapDirection.BUY, 0.15, 'wallet_G'));
  events.push(createSwap(baseTime + 30000, SwapDirection.SELL, 0.08, 'wallet_B'));
  events.push(createSwap(baseTime + 32000, SwapDirection.BUY, 0.5, 'wallet_H'));
  events.push(createSwap(baseTime + 34000, SwapDirection.BUY, 0.35, 'wallet_I'));
  events.push(createSwap(baseTime + 36000, SwapDirection.BUY, 0.2, 'wallet_J'));
  events.push(createSwap(baseTime + 38000, SwapDirection.BUY, 0.6, 'wallet_K'));
  
  // Phase 3: T=40-60s - Peak momentum
  events.push(createSwap(baseTime + 41000, SwapDirection.BUY, 0.8, 'wallet_L'));
  events.push(createSwap(baseTime + 43000, SwapDirection.BUY, 0.45, 'wallet_M'));
  events.push(createSwap(baseTime + 44000, SwapDirection.SELL, 0.15, 'wallet_D'));
  events.push(createSwap(baseTime + 46000, SwapDirection.BUY, 0.55, 'wallet_N'));
  events.push(createSwap(baseTime + 48000, SwapDirection.BUY, 0.3, 'wallet_O'));
  events.push(createSwap(baseTime + 50000, SwapDirection.BUY, 0.7, 'wallet_P'));
  events.push(createSwap(baseTime + 52000, SwapDirection.SELL, 0.2, 'wallet_E'));
  events.push(createSwap(baseTime + 54000, SwapDirection.BUY, 0.4, 'wallet_Q'));
  events.push(createSwap(baseTime + 56000, SwapDirection.BUY, 0.25, 'wallet_R'));
  events.push(createSwap(baseTime + 58000, SwapDirection.BUY, 0.35, 'wallet_S'));
  
  // Phase 4: T=60-90s - Momentum decay (sells increase)
  events.push(createSwap(baseTime + 62000, SwapDirection.SELL, 0.4, 'wallet_F'));
  events.push(createSwap(baseTime + 64000, SwapDirection.SELL, 0.35, 'wallet_G'));
  events.push(createSwap(baseTime + 66000, SwapDirection.BUY, 0.1, 'wallet_T'));
  events.push(createSwap(baseTime + 68000, SwapDirection.SELL, 0.5, 'wallet_H'));
  events.push(createSwap(baseTime + 70000, SwapDirection.SELL, 0.3, 'wallet_I'));
  events.push(createSwap(baseTime + 72000, SwapDirection.BUY, 0.05, 'wallet_U'));
  events.push(createSwap(baseTime + 76000, SwapDirection.SELL, 0.6, 'wallet_J'));
  events.push(createSwap(baseTime + 80000, SwapDirection.SELL, 0.4, 'wallet_K'));
  events.push(createSwap(baseTime + 85000, SwapDirection.SELL, 0.2, 'wallet_L'));
  
  return events.sort((a, b) => a.timestamp - b.timestamp);
}

// ─────────────────────────────────────────────────────────────
// SIMULATION
// ─────────────────────────────────────────────────────────────

function runSimulation(): void {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('           MOMENTUM LOGIC SIMULATION: MoonToken');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const events = generateSwapStream();
  const baseTime = events[0].timestamp;
  
  // Create token state with first event
  const tokenState = new TokenState(TOKEN_MINT, events[0]);
  const scorer = new MomentumScorer();
  
  // Also feed other tokens to build baseline for z-scores
  // (In production, many tokens would be feeding the scorer)
  seedBaselineStats(scorer);
  
  console.log('PHASE | TIME  | SWAP | DIR  | SOL   | WALLET  | 5s_cnt | 15s_net | 60s_buy | SCORE  | ENTRY? | EXIT?');
  console.log('──────┼───────┼──────┼──────┼───────┼─────────┼────────┼─────────┼─────────┼────────┼────────┼──────');
  
  let entryTriggered = false;
  let entryTime = 0;
  let consecutiveAboveEntry = 0;
  let lastCheckTime = baseTime;
  
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const relativeTime = (event.timestamp - baseTime) / 1000;
    
    // Determine phase
    let phase = 'DORMANT';
    if (relativeTime >= 20 && relativeTime < 40) phase = 'BUILD  ';
    else if (relativeTime >= 40 && relativeTime < 60) phase = 'PEAK   ';
    else if (relativeTime >= 60) phase = 'DECAY  ';
    else phase = 'DORMANT';
    
    // Process the swap
    if (i > 0) {
      tokenState.processSwap(event);
    }
    
    // Get metrics
    const metrics = tokenState.getMetrics();
    const window5s = metrics.windows['5s'];
    const window15s = metrics.windows['15s'];
    const window60s = metrics.windows['60s'];
    
    // Calculate score
    const score = scorer.calculateScore(tokenState);
    
    // Track entry confirmation
    if (score.isAboveEntryThreshold && !entryTriggered) {
      consecutiveAboveEntry += (event.timestamp - lastCheckTime) / 1000;
      if (consecutiveAboveEntry >= 3) {
        entryTriggered = true;
        entryTime = event.timestamp;
      }
    } else if (!score.isAboveEntryThreshold) {
      consecutiveAboveEntry = 0;
    }
    lastCheckTime = event.timestamp;
    
    // Check exit conditions
    const exitCheck = scorer.shouldExit(score, tokenState);
    
    // Format output
    const dir = event.direction === SwapDirection.BUY ? 'BUY ' : 'SELL';
    const entryStatus = entryTriggered ? (event.timestamp === entryTime ? '>>> YES' : 'done') : 
                        (score.isAboveEntryThreshold ? `${consecutiveAboveEntry.toFixed(1)}s...` : '');
    const exitStatus = entryTriggered && exitCheck.shouldExit ? `>>> ${exitCheck.reason}` : '';
    
    console.log(
      `${phase} | ` +
      `${relativeTime.toFixed(0).padStart(4)}s | ` +
      `${(i + 1).toString().padStart(4)} | ` +
      `${dir} | ` +
      `${event.notionalSol.toFixed(2).padStart(5)} | ` +
      `${event.walletAddress.slice(-7)} | ` +
      `${window5s.swapCount.toString().padStart(6)} | ` +
      `${window15s.netInflow.toFixed(2).padStart(7)} | ` +
      `${window60s.buyNotional.toFixed(2).padStart(7)} | ` +
      `${score.totalScore.toFixed(2).padStart(6)} | ` +
      `${entryStatus.padEnd(6)} | ` +
      `${exitStatus}`
    );
    
    // Stop if exit triggered
    if (entryTriggered && exitCheck.shouldExit) {
      console.log('\n──────────────────────────────────────────────────────────────────');
      console.log(`EXIT TRIGGERED at T=${relativeTime}s due to: ${exitCheck.reason}`);
      break;
    }
  }
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('SIMULATION COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  // Summary
  console.log('KEY OBSERVATIONS:');
  console.log('─────────────────────────────────────────────────────────────────');
  console.log('1. Score stays low during DORMANT phase (insufficient activity)');
  console.log('2. Score rises during BUILD phase as buys accelerate');
  console.log('3. Entry triggers during PEAK phase when:');
  console.log('   - Score > 2.5 (entry threshold)');
  console.log('   - Sustained for 3+ seconds');
  console.log('4. Exit triggers during DECAY phase when:');
  console.log('   - Net inflow goes negative for 5+ seconds, OR');
  console.log('   - Score drops below 0.5 (exit threshold)');
  console.log('');
  console.log('SCORE COMPONENTS:');
  console.log('─────────────────────────────────────────────────────────────────');
  console.log('  totalScore = 0.20 * zscore(swap_count_15s)');
  console.log('             + 0.35 * zscore(net_inflow_15s)');
  console.log('             + 0.25 * zscore(unique_buyers_60s)');
  console.log('             + 0.20 * zscore(price_change_60s)');
}

/**
 * Seed baseline statistics so z-scores are meaningful.
 * In production, this happens naturally as many tokens are processed.
 */
function seedBaselineStats(scorer: MomentumScorer): void {
  // Simulate having seen many tokens already
  // This sets reasonable mean/stddev for z-score calculation
  const dummyToken = new TokenState('dummy', {
    signature: 'dummy',
    slot: 0,
    timestamp: Date.now() - 100000,
    tokenMint: 'dummy',
    direction: SwapDirection.BUY,
    notionalSol: new Decimal(0.1),
    walletAddress: 'dummy',
    dexSource: DEXSource.UNKNOWN,
  });
  
  // Feed various activity levels to establish baseline
  const activityLevels = [
    { swaps: 2, inflow: 0.1 },
    { swaps: 5, inflow: 0.3 },
    { swaps: 3, inflow: 0.2 },
    { swaps: 8, inflow: 0.5 },
    { swaps: 1, inflow: 0.05 },
    { swaps: 4, inflow: 0.25 },
    { swaps: 6, inflow: 0.4 },
    { swaps: 2, inflow: 0.15 },
    { swaps: 10, inflow: 0.8 },
    { swaps: 3, inflow: 0.1 },
  ];
  
  for (const level of activityLevels) {
    // Add dummy swaps to build statistics
    for (let i = 0; i < level.swaps; i++) {
      dummyToken.processSwap({
        signature: `seed_${i}`,
        slot: 0,
        timestamp: Date.now(),
        tokenMint: 'dummy',
        direction: SwapDirection.BUY,
        notionalSol: new Decimal(level.inflow / level.swaps),
        walletAddress: `wallet_seed_${i}`,
        dexSource: DEXSource.UNKNOWN,
      });
    }
    scorer.calculateScore(dummyToken);
  }
}

// Run the simulation
runSimulation();
