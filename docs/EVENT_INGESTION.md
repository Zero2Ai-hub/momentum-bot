# Event Ingestion: Technical Details

## 1. Which Solana Events Are Subscribed To

### WebSocket Subscriptions

The bot subscribes to **program logs** (not account changes) for these DEX programs:

```typescript
// From src/types/index.ts
export const DEX_PROGRAM_IDS = {
  RAYDIUM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  METEORA: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
};
```

### Subscription Method

```typescript
// From src/listener/event-listener.ts
const subscriptionId = this.wsConnection.onLogs(
  pubkey,  // DEX program public key
  (logs, ctx) => {
    this.handleLogs(logs, ctx.slot, source);
  },
  'confirmed'  // Commitment level
);
```

This uses Solana's `logsSubscribe` RPC method which streams all transaction logs
that invoke the specified program.

### What Events Are Received

Every transaction that invokes a DEX program sends logs like:

```
Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]
Program log: Instruction: Swap
Program log: ray_log: AQAAAA0AAwBCDgAAAAAAABAnAAAAAAAAAAAAAACYmAEAAA...
Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 consumed 35420 of 200000 compute units
Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success
```

We filter for transactions containing `Instruction: Swap` (or similar).

---

## 2. How Buy vs Sell Is Inferred

### The Challenge

Solana swap logs don't explicitly say "buy" or "sell". They only show:
- Input token amount
- Output token amount
- Pool info

### Inference Logic

**Raydium** (from `src/listener/parsers/raydium.ts`):

```typescript
// Raydium ray_log contains input/output amounts as u64
const inputAmount = buffer.readBigUInt64LE(8);
const outputAmount = buffer.readBigUInt64LE(16);

const inputLamports = new Decimal(inputAmount.toString());
const outputLamports = new Decimal(outputAmount.toString());

// Heuristic: SOL has 9 decimals, tokens have 6-9
// SOL amounts in lamports are typically MUCH larger numerically
if (inputLamports.gt(outputLamports.mul(1000))) {
  // Input is much larger → likely SOL input → BUY token
  direction = SwapDirection.BUY;
  notionalSol = inputLamports.div(1e9);
} else {
  // Output is larger → likely SOL output → SELL token
  direction = SwapDirection.SELL;
  notionalSol = outputLamports.div(1e9);
}
```

**Orca** (from `src/listener/parsers/orca.ts`):

```typescript
// Orca logs sometimes include direction explicitly
if (log.toLowerCase().includes('a_to_b')) {
  direction = SwapDirection.BUY;  // Token A to Token B
} else if (log.toLowerCase().includes('b_to_a')) {
  direction = SwapDirection.SELL;
}

// Fallback: compare amounts
const sortedAmounts = amounts.sort((a, b) => b.minus(a).toNumber());
const potentialSolAmount = sortedAmounts[0];
if (potentialSolAmount.gt(1e6)) {
  notionalSol = potentialSolAmount.div(1e9);  // Likely lamports
}
```

### Limitations

1. **SOL vs Token Assumption**: We assume one side is SOL/USDC. For token-to-token swaps, this breaks.
2. **Decimal Guessing**: Without querying token metadata, we guess decimals.
3. **Pool Direction**: Some pools have SOL as token A, others as token B.

### Production Improvement Needed

For accurate direction detection:
```typescript
// Would need to:
// 1. Fetch pool accounts to know which token is base vs quote
// 2. Query token mint for decimals
// 3. Compare against known stablecoins/SOL
```

---

## 3. How Notional Value Is Computed

### Current Implementation

```typescript
// Notional = SOL-equivalent value of the swap

// For BUY (SOL → Token):
notionalSol = inputAmountLamports / 1e9;

// For SELL (Token → SOL):
notionalSol = outputAmountLamports / 1e9;
```

### Example Calculation

```
Transaction: Buy 1,000,000 PUMP tokens for 0.5 SOL

ray_log decoded:
  inputAmount: 500000000 (0.5 SOL in lamports)
  outputAmount: 1000000 (1M tokens, assuming 6 decimals)

Inference:
  500000000 > 1000000 * 1000? → Yes
  Direction: BUY
  notionalSol: 500000000 / 1e9 = 0.5 SOL
```

### Limitations

1. **No Price Oracle**: We don't fetch actual token prices
2. **Approximation**: notionalSol is the swap amount, not the token's USD value
3. **Partial Data**: Sometimes ray_log is missing or malformed

---

## 4. How Duplicates and Missed Events Are Handled

### Duplicate Detection

```typescript
// From src/listener/event-listener.ts

// LRU Set tracks recent signatures
private recentSignatures = new Set<string>();
private readonly maxSignatures = 10000;

// In handleLogs:
if (this.recentSignatures.has(logs.signature)) {
  return;  // Skip duplicate
}
this.recentSignatures.add(logs.signature);

// Periodic cleanup to prevent memory growth
private cleanupSignatures(): void {
  if (this.recentSignatures.size > this.maxSignatures) {
    const toKeep = Array.from(this.recentSignatures).slice(-this.maxSignatures / 2);
    this.recentSignatures.clear();
    for (const sig of toKeep) {
      this.recentSignatures.add(sig);
    }
  }
}
```

### Why Duplicates Occur

1. **WebSocket Reconnection**: After reconnect, may receive recent events again
2. **Multiple Subscriptions**: If subscribed to multiple programs that interact
3. **RPC Behavior**: Some RPCs may send duplicates during high load

### Missed Events

**Causes:**
1. WebSocket disconnection during activity
2. RPC rate limiting
3. Network issues

**Handling:**

```typescript
// From src/listener/event-listener.ts

private async handleReconnect(): Promise<void> {
  this.reconnectAttempts++;
  
  if (this.reconnectAttempts > this.maxReconnectAttempts) {
    this.emit('error', new Error('Max reconnection attempts reached'));
    return;
  }
  
  // Exponential backoff
  const delay = this.retryDelayMs * Math.pow(2, this.reconnectAttempts - 1);
  await new Promise(resolve => setTimeout(resolve, delay));
  
  // Reconnect
  await this.connectWebSocket();
}
```

### What's NOT Recovered

- **Historical Events**: We don't backfill events during downtime
- **Gap Detection**: We don't detect if events were missed

### Production Improvement Needed

```typescript
// To handle gaps:
// 1. Track last processed slot
// 2. On reconnect, query getSignaturesForAddress for gaps
// 3. Fetch and replay missed transactions

async function backfillGaps(lastSlot: number, currentSlot: number) {
  const signatures = await connection.getSignaturesForAddress(
    programId,
    { minContextSlot: lastSlot }
  );
  // Replay each missed signature
}
```

---

## 5. Event Flow Summary

```
Solana Network
     │
     ▼
┌─────────────────────┐
│ WebSocket Stream    │  logsSubscribe for each DEX program
│ (4 subscriptions)   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Deduplication       │  Check signature against LRU set
│ (signature check)   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Log Parser          │  DEX-specific parsing (Raydium/Orca/etc)
│ (per-DEX logic)     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Direction Inference │  Heuristic: larger amount = SOL side
│ (buy vs sell)       │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ SwapEvent Creation  │  Structured event object
│                     │
└──────────┬──────────┘
           │
           ▼
     emit('swap')
```

---

## 6. Known Issues

| Issue | Impact | Mitigation |
|-------|--------|------------|
| Direction inference can be wrong | Incorrect buy/sell classification | Conservative thresholds |
| Missing decimals metadata | Notional may be off by orders of magnitude | Use well-known tokens only |
| No gap recovery | Missed events during downtime | Accept some data loss |
| Rate limiting | Subscription may be throttled | Use paid RPC provider |
| Parser assumptions | May miss swaps with unusual log formats | Log unknown formats for analysis |

---

## 7. Verification Checklist

To verify event ingestion is working:

1. **Check subscription count**:
   ```typescript
   const stats = eventListener.getStats();
   console.log(stats.subscriptionCount); // Should be 4
   ```

2. **Monitor signature dedup rate**:
   ```typescript
   const dedupStats = deduplicator.getStats();
   console.log(dedupStats.duplicateRate); // Should be < 5%
   ```

3. **Validate parsed events**:
   ```typescript
   eventListener.on('swap', (event) => {
     console.assert(event.tokenMint.length >= 32, 'Invalid mint');
     console.assert(event.notionalSol.gt(0), 'Zero notional');
     console.assert(['BUY', 'SELL'].includes(event.direction), 'Invalid direction');
   });
   ```
