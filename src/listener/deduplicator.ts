/**
 * Event Deduplicator
 * Ensures each event is processed only once.
 */

/**
 * LRUSet is a Set with a maximum size.
 * When the limit is reached, oldest entries are evicted.
 */
export class LRUSet<T> {
  private map = new Map<T, number>();
  private maxSize: number;
  private counter = 0;
  
  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }
  
  /**
   * Add an item to the set.
   * Returns true if item was added (not a duplicate).
   */
  add(item: T): boolean {
    if (this.map.has(item)) {
      // Update access order
      this.map.set(item, ++this.counter);
      return false;
    }
    
    // Evict oldest if at capacity
    if (this.map.size >= this.maxSize) {
      this.evictOldest();
    }
    
    this.map.set(item, ++this.counter);
    return true;
  }
  
  /**
   * Check if item exists
   */
  has(item: T): boolean {
    return this.map.has(item);
  }
  
  /**
   * Remove an item
   */
  delete(item: T): boolean {
    return this.map.delete(item);
  }
  
  /**
   * Clear all items
   */
  clear(): void {
    this.map.clear();
    this.counter = 0;
  }
  
  /**
   * Get current size
   */
  get size(): number {
    return this.map.size;
  }
  
  /**
   * Evict the oldest entry
   */
  private evictOldest(): void {
    let oldestKey: T | null = null;
    let oldestTime = Infinity;
    
    for (const [key, time] of this.map) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestKey = key;
      }
    }
    
    if (oldestKey !== null) {
      this.map.delete(oldestKey);
    }
  }
}

/**
 * EventDeduplicator tracks seen event signatures
 * and filters duplicates.
 */
export class EventDeduplicator {
  private seenSignatures: LRUSet<string>;
  private duplicateCount = 0;
  private totalCount = 0;
  
  constructor(maxSignatures: number = 10000) {
    this.seenSignatures = new LRUSet(maxSignatures);
  }
  
  /**
   * Check if a signature is new (not seen before).
   * If new, records it and returns true.
   * If duplicate, returns false.
   */
  isNew(signature: string): boolean {
    this.totalCount++;
    
    const isNew = this.seenSignatures.add(signature);
    
    if (!isNew) {
      this.duplicateCount++;
    }
    
    return isNew;
  }
  
  /**
   * Check if seen without recording
   */
  hasSeen(signature: string): boolean {
    return this.seenSignatures.has(signature);
  }
  
  /**
   * Get deduplication statistics
   */
  getStats(): {
    totalProcessed: number;
    duplicatesFiltered: number;
    uniqueSignatures: number;
    duplicateRate: number;
  } {
    return {
      totalProcessed: this.totalCount,
      duplicatesFiltered: this.duplicateCount,
      uniqueSignatures: this.seenSignatures.size,
      duplicateRate: this.totalCount > 0 
        ? (this.duplicateCount / this.totalCount) * 100 
        : 0,
    };
  }
  
  /**
   * Clear all tracked signatures
   */
  clear(): void {
    this.seenSignatures.clear();
    this.duplicateCount = 0;
    this.totalCount = 0;
  }
}
