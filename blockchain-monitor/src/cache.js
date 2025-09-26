import NodeCache from 'node-cache';

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
            stdTTL: 3600,      // 1 hour default for contract state
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
        // If ttl is 0 or undefined, use permanent caching (no TTL)
        if (ttl === 0 || ttl === undefined) {
            return cache.set(key, value);
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
        return this.set(this.contractStateCache, key, value, ttl);
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