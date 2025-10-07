import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Tracks processed transaction hashes to prevent duplicate event processing
 * during historical scans and reconnections
 */
export class ProcessedTxTracker {
  constructor(filePath = null) {
    this.filePath = filePath || path.join(__dirname, '..', '..', 'data', 'processed-txs.json');
    this.processedTxs = new Map(); // Map<txHash, timestamp>
    this.maxAge = 48 * 60 * 60 * 1000; // Keep processed hashes for 48 hours
    this.saveInterval = null;
    this.isDirty = false;
  }

  async initialize() {
    try {
      await this.load();
      console.log(`Loaded ${this.processedTxs.size} processed transaction hashes`);

      // Clean up old entries on startup
      await this.cleanup();

      // Auto-save every 5 minutes if there are changes
      this.saveInterval = setInterval(async () => {
        if (this.isDirty) {
          await this.save();
        }
      }, 5 * 60 * 1000);

    } catch (error) {
      console.error('Failed to initialize ProcessedTxTracker:', error.message);
      console.log('Starting with empty processed tx set');
    }
  }

  async load() {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(data);

      // Convert array back to Map
      if (Array.isArray(parsed)) {
        this.processedTxs = new Map(parsed);
      } else {
        this.processedTxs = new Map();
      }

    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist yet, start fresh
        this.processedTxs = new Map();
      } else {
        throw error;
      }
    }
  }

  async save() {
    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });

      // Convert Map to array for JSON serialization
      const data = Array.from(this.processedTxs.entries());
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2));

      this.isDirty = false;
      console.log(`Saved ${this.processedTxs.size} processed transaction hashes`);

    } catch (error) {
      console.error('Failed to save processed tx hashes:', error.message);
    }
  }

  /**
   * Check if a transaction hash has been processed
   * @param {string} txHash - Transaction hash to check
   * @returns {boolean} - True if already processed
   */
  isProcessed(txHash) {
    return this.processedTxs.has(txHash.toLowerCase());
  }

  /**
   * Mark a transaction hash as processed
   * @param {string} txHash - Transaction hash to mark
   * @param {number} timestamp - Optional timestamp (defaults to now)
   */
  markProcessed(txHash, timestamp = Date.now()) {
    this.processedTxs.set(txHash.toLowerCase(), timestamp);
    this.isDirty = true;
  }

  /**
   * Remove old processed transaction hashes
   * @returns {number} - Number of entries removed
   */
  async cleanup() {
    const now = Date.now();
    const cutoff = now - this.maxAge;
    let removed = 0;

    for (const [txHash, timestamp] of this.processedTxs.entries()) {
      if (timestamp < cutoff) {
        this.processedTxs.delete(txHash);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`Cleaned up ${removed} old processed transaction hashes (older than 48 hours)`);
      this.isDirty = true;
      await this.save();
    }

    return removed;
  }

  /**
   * Get statistics about processed transactions
   * @returns {Object} - Stats object
   */
  getStats() {
    const now = Date.now();
    const last24h = now - (24 * 60 * 60 * 1000);
    const last48h = now - (48 * 60 * 60 * 1000);

    let count24h = 0;
    let count48h = 0;

    for (const timestamp of this.processedTxs.values()) {
      if (timestamp > last24h) count24h++;
      if (timestamp > last48h) count48h++;
    }

    return {
      total: this.processedTxs.size,
      last24h: count24h,
      last48h: count48h
    };
  }

  /**
   * Stop the tracker and save
   */
  async stop() {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }

    if (this.isDirty) {
      await this.save();
    }
  }
}
