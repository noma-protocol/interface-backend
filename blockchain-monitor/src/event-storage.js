import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Helper function to convert BigInt to string in nested objects
function bigIntReplacer(key, value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

// Helper function to convert string back to BigInt when needed
function bigIntReviver(key, value) {
  // Common BigInt fields in blockchain events
  const bigIntFields = ['amount0', 'amount1', 'amount', 'liquidity', 'paid0', 'paid1', 'sqrtPriceX96'];
  if (bigIntFields.includes(key) && typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return value;
}

export class EventStorage {
  constructor(filePath) {
    this.filePath = filePath;
    this.events = [];
    this.isInitialized = false;
  }

  async initialize() {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      
      try {
        const data = await fs.readFile(this.filePath, 'utf-8');
        this.events = JSON.parse(data, bigIntReviver);
        console.log(`Loaded ${this.events.length} events from storage`);
      } catch (error) {
        if (error.code === 'ENOENT') {
          this.events = [];
          await this.save();
          console.log('Created new event storage file');
        } else {
          throw error;
        }
      }
      
      this.isInitialized = true;
    } catch (error) {
      console.error('Failed to initialize event storage:', error);
      throw error;
    }
  }

  async addEvent(event) {
    if (!this.isInitialized) {
      throw new Error('EventStorage not initialized');
    }

    const eventWithId = {
      ...event,
      id: this.generateEventId(event),
      storedAt: Date.now()
    };

    this.events.push(eventWithId);
    await this.save();
    
    return eventWithId;
  }

  async save() {
    try {
      await fs.writeFile(this.filePath, JSON.stringify(this.events, bigIntReplacer, 2));
    } catch (error) {
      console.error('Failed to save events:', error);
      throw error;
    }
  }

  generateEventId(event) {
    return `${event.transactionHash}-${event.logIndex}`;
  }

  getAllEvents() {
    return [...this.events];
  }

  getEventsSince(timestamp) {
    return this.events.filter(event => event.timestamp >= timestamp);
  }

  getEventsByPool(poolAddress) {
    return this.events.filter(event => 
      event.poolAddress.toLowerCase() === poolAddress.toLowerCase()
    );
  }

  getEventsByTransactionHash(txHash) {
    return this.events.filter(event => event.transactionHash === txHash);
  }

  getEventsByBlockRange(startBlock, endBlock) {
    return this.events.filter(event => 
      event.blockNumber >= startBlock && event.blockNumber <= endBlock
    );
  }

  getEventsByType(eventName) {
    return this.events.filter(event => event.eventName === eventName);
  }

  getEventCount() {
    return this.events.length;
  }

  getLatestEvents(limit = 100) {
    return this.events.slice(-limit).reverse();
  }

  getLatestTrades(limit = 50) {
    // Filter only Swap events (trades) and return the most recent ones
    const swapEvents = this.events.filter(event => event.eventName === 'Swap');
    return swapEvents.slice(-limit).reverse();
  }

  getLatestGlobalTrades(limit = 50) {
    // Get latest trades across all pools
    const swapEvents = this.events
      .filter(event => event.eventName === 'Swap')
      .slice(-limit)
      .reverse();
    
    // Add formatted trade info for easier consumption
    return swapEvents.map(event => ({
      ...event,
      tradeInfo: this.formatTradeInfo(event)
    }));
  }

  formatTradeInfo(event) {
    if (event.eventName !== 'Swap') return null;
    
    const args = event.args;
    const amount0 = BigInt(args.amount0 || '0');
    const amount1 = BigInt(args.amount1 || '0');
    
    // Determine trade direction
    const isBuy = amount0 > 0n && amount1 < 0n;
    const isSell = amount0 < 0n && amount1 > 0n;
    
    return {
      type: isBuy ? 'buy' : isSell ? 'sell' : 'unknown',
      amount0: args.amount0,
      amount1: args.amount1,
      sender: args.sender,
      recipient: args.recipient,
      // Include actual sender/recipient if available
      actualSender: event.actualSender || args.sender,
      actualRecipient: event.actualRecipient || args.recipient
    };
  }

  async clearOldEvents(daysToKeep = 30) {
    const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
    const originalCount = this.events.length;
    
    this.events = this.events.filter(event => event.timestamp >= cutoffTime);
    
    if (this.events.length < originalCount) {
      await this.save();
      console.log(`Cleared ${originalCount - this.events.length} old events`);
    }
  }
}