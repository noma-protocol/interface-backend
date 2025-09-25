import { ethers } from 'ethers';
import EventEmitter from 'events';
import cache from './cache.js';

// Standard Uniswap V3 events
const UNISWAP_V3_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Collect(address indexed owner, address recipient, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount0, uint128 amount1)",
  "event Flash(address indexed sender, address indexed recipient, uint256 amount0, uint256 amount1, uint256 paid0, uint256 paid1)"
];

// PancakeSwap V3 extended events (with protocol fees)
const PANCAKESWAP_V3_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint128 protocolFeesToken0, uint128 protocolFeesToken1)",
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)",
  "event Collect(address indexed owner, address recipient, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount0, uint128 amount1)",
  "event Flash(address indexed sender, address indexed recipient, uint256 amount0, uint256 amount1, uint256 paid0, uint256 paid1)"
];

// Combined ABI for compatibility
const POOL_ABI = [...UNISWAP_V3_ABI, ...PANCAKESWAP_V3_ABI];

// Rate limiting configuration for QuickNode
const RATE_LIMIT_CONFIG = {
  requestsPerSecond: 20, // QuickNode allows 25/sec, leaving some buffer
  requestDelay: 50, // 50ms between requests (20 requests/second)
  maxRetries: 3,
  retryDelay: 1000, // Initial retry delay in ms
  backoffMultiplier: 2
};

export class BlockchainMonitor extends EventEmitter {
  constructor(rpcUrl, poolAddresses) {
    super();
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.poolAddresses = poolAddresses;
    this.contracts = new Map();
    this.isRunning = false;
    this.requestQueue = [];
    this.lastRequestTime = 0;
  }

  async initialize() {
    for (const poolAddress of this.poolAddresses) {
      const contract = new ethers.Contract(poolAddress, POOL_ABI, this.provider);
      this.contracts.set(poolAddress, contract);
    }
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    // Start polling for events
    this.lastBlock = await this.provider.getBlockNumber();
    console.log(`Starting from block ${this.lastBlock}`);
    
    this.pollInterval = setInterval(async () => {
      await this.pollEvents();
    }, 10000); // Poll every 10 seconds instead of 5

    console.log(`Monitoring ${this.poolAddresses.length} pools for events...`);
  }

  // Rate-limited request execution
  async rateLimitedRequest(requestFn) {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < RATE_LIMIT_CONFIG.requestDelay) {
      await this.sleep(RATE_LIMIT_CONFIG.requestDelay - timeSinceLastRequest);
    }
    
    this.lastRequestTime = Date.now();
    
    // Execute with retry logic
    let lastError;
    for (let attempt = 0; attempt < RATE_LIMIT_CONFIG.maxRetries; attempt++) {
      try {
        return await requestFn();
      } catch (error) {
        lastError = error;
        
        // Check if it's a rate limit error
        if (error.code === 429 || (error.error && error.error.code === 429)) {
          const retryDelay = RATE_LIMIT_CONFIG.retryDelay * Math.pow(RATE_LIMIT_CONFIG.backoffMultiplier, attempt);
          console.log(`Rate limited. Retrying after ${retryDelay}ms...`);
          await this.sleep(retryDelay);
        } else {
          // For non-rate-limit errors, throw immediately
          throw error;
        }
      }
    }
    
    throw lastError;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async pollEvents() {
    try {
      const currentBlock = await this.rateLimitedRequest(() => this.provider.getBlockNumber());
      
      if (currentBlock > this.lastBlock) {
        // Process in smaller chunks to reduce load
        const maxBlockRange = 5; // Reduced from 9
        let fromBlock = this.lastBlock + 1;
        
        while (fromBlock <= currentBlock) {
          const toBlock = Math.min(fromBlock + maxBlockRange - 1, currentBlock);
          
          // Query all events at once using a combined filter to reduce requests
          for (const [address, contract] of this.contracts) {
            try {
              // Check cache first
              const filter = {
                address: address,
                fromBlock: fromBlock,
                toBlock: toBlock
              };
              
              let events = await cache.getLogs(filter);
              
              if (events === undefined) {
                // Cache miss - fetch from provider
                events = await this.rateLimitedRequest(async () => {
                  return await this.provider.getLogs(filter);
                });
                
                // Cache the results
                cache.setLogs(filter, events);
              }
              
              // Process the logs
              if (events.length > 0) {
                console.log(`Found ${events.length} events for pool ${address}`);
              }
              
              for (const log of events) {
                await this.processLog(address, contract, log);
              }
              
              // Add a small delay between pools
              await this.sleep(RATE_LIMIT_CONFIG.requestDelay);
              
            } catch (error) {
              console.error(`Error querying events for ${address}:`, error.message);
            }
          }
          
          fromBlock = toBlock + 1;
        }
        
        this.lastBlock = currentBlock;
      }
    } catch (error) {
      console.error('Error polling events:', error);
    }
  }

  async processLog(poolAddress, contract, log) {
    try {
      // Parse the log to determine event type
      const parsedLog = contract.interface.parseLog(log);
      if (!parsedLog) return;
      
      // Convert args to plain object and handle BigInt values
      let args = {};
      
      // Special handling for PancakeSwap extended Swap event
      if (parsedLog.name === 'Swap' && parsedLog.args.length > 7) {
        // Map the extended args manually for PancakeSwap
        args = {
          sender: parsedLog.args[0],
          recipient: parsedLog.args[1],
          amount0: parsedLog.args[2].toString(),
          amount1: parsedLog.args[3].toString(),
          sqrtPriceX96: parsedLog.args[4].toString(),
          liquidity: parsedLog.args[5].toString(),
          tick: parsedLog.args[6].toString(),
          // Protocol fees (PancakeSwap specific) - we'll store them but not use them for now
          protocolFeesToken0: parsedLog.args[7] ? parsedLog.args[7].toString() : '0',
          protocolFeesToken1: parsedLog.args[8] ? parsedLog.args[8].toString() : '0'
        };
      } else if (parsedLog.args.toObject) {
        args = parsedLog.args.toObject();
      } else {
        // Manual conversion for older ethers versions
        const names = parsedLog.fragment.inputs.map(input => input.name);
        names.forEach((name, index) => {
          const value = parsedLog.args[index];
          // Convert BigInt to string for JSON serialization
          args[name] = typeof value === 'bigint' ? value.toString() : value;
        });
      }
      
      // Convert any remaining BigInt values to strings
      Object.keys(args).forEach(key => {
        if (typeof args[key] === 'bigint') {
          args[key] = args[key].toString();
        }
      });
      
      const eventData = {
        poolAddress,
        eventName: parsedLog.name,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        logIndex: log.logIndex || log.index, // Some providers use 'index' instead of 'logIndex'
        args: args,
        timestamp: Date.now()
      };

      this.emit('poolEvent', eventData);
    } catch (error) {
      // Log the error to see what's happening
      console.error(`Error processing log for pool ${poolAddress}:`, error.message);
    }
  }

  async handleEvent(poolAddress, eventName, event) {
    const eventData = {
      poolAddress,
      eventName,
      blockNumber: event.blockNumber,
      blockHash: event.blockHash,
      transactionHash: event.transactionHash,
      transactionIndex: event.transactionIndex,
      logIndex: event.logIndex,
      args: event.args.toObject(),
      timestamp: Date.now()
    };

    this.emit('poolEvent', eventData);
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    console.log('Stopped monitoring pools');
  }

  addPool(poolAddress) {
    if (this.contracts.has(poolAddress)) return;

    const contract = new ethers.Contract(poolAddress, POOL_ABI, this.provider);
    this.contracts.set(poolAddress, contract);
    this.poolAddresses.push(poolAddress);
  }

  removePool(poolAddress) {
    const contract = this.contracts.get(poolAddress);
    if (!contract) return;

    this.contracts.delete(poolAddress);
    this.poolAddresses = this.poolAddresses.filter(addr => addr !== poolAddress);
  }
}