import NodeCache from 'node-cache';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, '..', 'data', 'contract-state-cache.json');

class BlockchainCache {
    constructor() {
        // Different cache instances for different data types with appropriate TTL
        this.transactionCache = new NodeCache({
            stdTTL: 3600,      // 1 hour for transactions (immutable)
            checkperiod: 600   // Check for expired keys every 10 minutes
        });

        this.blockCache = new NodeCache({
            stdTTL: 3600,      // 1 hour for blocks (immutable)
            checkperiod: 600
        });

        this.contractStateCache = new NodeCache({
            stdTTL: 0,         // No default TTL - must be specified per key
            checkperiod: 300   // Check every 5 minutes
        });

        this.logCache = new NodeCache({
            stdTTL: 300,       // 5 minutes for logs
            checkperiod: 60
        });

        // Statistics
        this.stats = {
            hits: 0,
            misses: 0,
            sets: 0
        };

        // Track if we need to persist
        this.persistenceEnabled = true;
        this.persistencePending = false;

        // Load persistent cache on startup
        this.loadPersistentCache();
    }

    async loadPersistentCache() {
        try {
            const data = await fs.readFile(CACHE_FILE, 'utf-8');
            const parsed = JSON.parse(data);

            // Restore cache entries
            if (parsed.entries) {
                for (const [key, entry] of Object.entries(parsed.entries)) {
                    // Check if entry has expired
                    if (entry.expiresAt === 0 || entry.expiresAt > Date.now()) {
                        const ttl = entry.expiresAt === 0 ? 0 : Math.floor((entry.expiresAt - Date.now()) / 1000);
                        this.contractStateCache.set(key, entry.value, ttl > 0 ? ttl : 10000000);
                    }
                }
                console.log(`[Cache] Loaded ${Object.keys(parsed.entries).length} entries from disk`);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('[Cache] Error loading persistent cache:', error);
            }
        }
    }

    async savePersistentCache() {
        if (!this.persistenceEnabled) return;

        try {
            const keys = this.contractStateCache.keys();
            const entries = {};

            for (const key of keys) {
                const value = this.contractStateCache.get(key);
                const ttl = this.contractStateCache.getTtl(key);

                if (value !== undefined) {
                    entries[key] = {
                        value,
                        expiresAt: ttl || 0
                    };
                }
            }

            // Custom JSON serializer that converts BigInt to string
            const json = JSON.stringify({ entries }, (key, value) =>
                typeof value === 'bigint' ? value.toString() : value
            , 2);

            await fs.writeFile(CACHE_FILE, json);
            this.persistencePending = false;
        } catch (error) {
            console.error('[Cache] Error saving persistent cache:', error);
        }
    }

    schedulePersistence() {
        if (this.persistencePending) return;

        this.persistencePending = true;

        // Debounce writes - save after 5 seconds of inactivity
        setTimeout(() => {
            this.savePersistentCache();
        }, 5000);
    }
    
    // Generate cache key for logs
    getLogCacheKey(filter) {
        const key = `logs:${filter.address || 'all'}:${filter.fromBlock}:${filter.toBlock}:${JSON.stringify(filter.topics || [])}`;
        return key;
    }
    
    // Generic get method with stats
    async get(cache, key) {
        const value = cache.get(key);
        if (value !== undefined) {
            this.stats.hits++;
            return value;
        }
        this.stats.misses++;
        return undefined;
    }
    
    // Generic set method with stats
    set(cache, key, value, ttl) {
        this.stats.sets++;
        // If ttl is 0, undefined, or negative, don't expire
        // NodeCache interprets 0 as "use default", so we use a very large number
        if (ttl === 0 || ttl === undefined || ttl < 0) {
            return cache.set(key, value, 10000000); // ~115 days
        } else {
            return cache.set(key, value, ttl);
        }
    }
    
    // Transaction methods
    async getTransaction(txHash) {
        return this.get(this.transactionCache, `tx:${txHash}`);
    }
    
    setTransaction(txHash, transaction) {
        return this.set(this.transactionCache, `tx:${txHash}`, transaction);
    }
    
    // Block methods
    async getBlock(blockNumber) {
        return this.get(this.blockCache, `block:${blockNumber}`);
    }
    
    setBlock(blockNumber, block) {
        return this.set(this.blockCache, `block:${blockNumber}`, block);
    }
    
    // Contract state methods
    async getContractState(address, method, args = []) {
        const key = `state:${address}:${method}:${JSON.stringify(args)}`;
        return this.get(this.contractStateCache, key);
    }
    
    setContractState(address, method, args, value, ttl) {
        const key = `state:${address}:${method}:${JSON.stringify(args)}`;
        const result = this.set(this.contractStateCache, key, value, ttl);

        // Schedule persistence for permanent cache entries (ttl = 0)
        if (ttl === 0 || ttl === undefined || ttl < 0) {
            this.schedulePersistence();
        }

        return result;
    }
    
    // Log methods
    async getLogs(filter) {
        const key = this.getLogCacheKey(filter);
        return this.get(this.logCache, key);
    }
    
    setLogs(filter, logs) {
        const key = this.getLogCacheKey(filter);
        return this.set(this.logCache, key, logs);
    }
    
    // Clear specific cache
    clearCache(cacheType) {
        switch(cacheType) {
            case 'transaction':
                this.transactionCache.flushAll();
                break;
            case 'block':
                this.blockCache.flushAll();
                break;
            case 'contractState':
                this.contractStateCache.flushAll();
                break;
            case 'log':
                this.logCache.flushAll();
                break;
            case 'all':
                this.transactionCache.flushAll();
                this.blockCache.flushAll();
                this.contractStateCache.flushAll();
                this.logCache.flushAll();
                break;
        }
    }
    
    // Get cache statistics
    getStats() {
        const totalRequests = this.stats.hits + this.stats.misses;
        const hitRate = totalRequests > 0 ? (this.stats.hits / totalRequests * 100).toFixed(2) : 0;
        
        return {
            ...this.stats,
            hitRate: `${hitRate}%`,
            transactionCacheSize: this.transactionCache.keys().length,
            blockCacheSize: this.blockCache.keys().length,
            contractStateCacheSize: this.contractStateCache.keys().length,
            logCacheSize: this.logCache.keys().length
        };
    }
    
    // Log cache statistics periodically
    startStatsLogging(intervalMs = 300000) { // 5 minutes default
        setInterval(() => {
            console.log('[Cache Stats]', this.getStats());
        }, intervalMs);
    }
}

// Create singleton instance
const cache = new BlockchainCache();

export default cache;