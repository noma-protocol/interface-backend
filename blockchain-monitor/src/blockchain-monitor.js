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

// ExchangeHelper contract address and ABI
const EXCHANGE_HELPER_ADDRESS = process.env.EXCHANGE_HELPER_ADDRESS || '0xD82D7Bdd614bA07527351DE627C558Adbd0f7caE';
const EXCHANGE_HELPER_ABI = [
  'event BoughtTokensETH(address who, uint256 amount)',
  'event BoughtTokensWETH(address who, uint256 amount)',
  'event SoldTokensETH(address who, uint256 amount)',
  'event SoldTokensWETH(address who, uint256 amount)'
];

// Rate limiting configuration for QuickNode
const RATE_LIMIT_CONFIG = {
  requestsPerSecond: 5, // Further reduced to be safe with QuickNode limits
  requestDelay: 200, // 200ms between requests (5 requests/second)
  maxRetries: 3,
  retryDelay: 2000, // Increased initial retry delay
  backoffMultiplier: 2,
  enableEnhancedLookup: true // Enable enhanced tx lookup to get actual sender/recipient
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
    this.exchangeHelper = null;
  }

  async initialize() {
    // Initialize pool contracts
    for (const poolAddress of this.poolAddresses) {
      const contract = new ethers.Contract(poolAddress, POOL_ABI, this.provider);
      this.contracts.set(poolAddress, contract);
    }
    
    // Initialize ExchangeHelper contract
    if (EXCHANGE_HELPER_ADDRESS && EXCHANGE_HELPER_ADDRESS !== ethers.ZeroAddress) {
      this.exchangeHelper = new ethers.Contract(
        EXCHANGE_HELPER_ADDRESS,
        EXCHANGE_HELPER_ABI,
        this.provider
      );
      console.log(`ExchangeHelper contract initialized at ${EXCHANGE_HELPER_ADDRESS}`);
    } else {
      console.warn('No ExchangeHelper address configured');
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
    }, 20000); // Poll every 20 seconds to reduce API load

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
          
          // Also check for ExchangeHelper events if configured
          if (this.exchangeHelper) {
            try {
              const exchangeHelperFilter = {
                address: EXCHANGE_HELPER_ADDRESS,
                fromBlock: fromBlock,
                toBlock: toBlock
              };
              
              let exchangeEvents = await cache.getLogs(exchangeHelperFilter);
              
              if (exchangeEvents === undefined) {
                exchangeEvents = await this.rateLimitedRequest(async () => {
                  return await this.provider.getLogs(exchangeHelperFilter);
                });
                
                cache.setLogs(exchangeHelperFilter, exchangeEvents);
              }
              
              if (exchangeEvents.length > 0) {
                console.log(`Found ${exchangeEvents.length} ExchangeHelper events`);
              }
              
              for (const log of exchangeEvents) {
                await this.processExchangeHelperLog(log);
              }
              
              await this.sleep(RATE_LIMIT_CONFIG.requestDelay);
              
            } catch (error) {
              console.error(`Error querying ExchangeHelper events:`, error.message);
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
      
      // For Swap events, try to find the actual sender and recipient
      let actualSender = args.sender;
      let actualRecipient = args.recipient;
      
      // Only do enhanced lookup if enabled and for Swap events
      if (RATE_LIMIT_CONFIG.enableEnhancedLookup && parsedLog.name === 'Swap') {
        try {
          // Add delay to respect rate limits
          await this.sleep(RATE_LIMIT_CONFIG.requestDelay);
          
          // Get transaction details to find the actual sender
          const tx = await this.provider.getTransaction(log.transactionHash);
          actualSender = tx.from;
          
          // Add another delay before next request
          await this.sleep(RATE_LIMIT_CONFIG.requestDelay);
          
          // Get transaction receipt to analyze Transfer events
          const receipt = await this.provider.getTransactionReceipt(log.transactionHash);
          
          // Look for Transfer events in the same transaction
          // The last Transfer event usually shows where tokens were sent
          const transferEvents = receipt.logs.filter(txLog => {
            try {
              // Check if it's a Transfer event (topic0 = Transfer signature)
              return txLog.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
            } catch {
              return false;
            }
          });
          
          if (transferEvents.length > 0) {
            // Find Transfer events that happened after the Swap
            const swapLogIndex = log.logIndex || log.index;
            const relevantTransfers = transferEvents.filter(transfer => 
              (transfer.logIndex || transfer.index) > swapLogIndex
            );
            
            if (relevantTransfers.length > 0) {
              // The last transfer often shows the final recipient
              const lastTransfer = relevantTransfers[relevantTransfers.length - 1];
              // Transfer event: from (topic1), to (topic2)
              if (lastTransfer.topics[2]) {
                // Remove padding from address
                actualRecipient = '0x' + lastTransfer.topics[2].slice(26);
              }
            }
          }
        } catch (error) {
          console.error('Error fetching actual sender/recipient:', error.message);
          // Continue with router addresses if we can't get actual ones
        }
      }
      
      const eventData = {
        poolAddress,
        eventName: parsedLog.name,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        logIndex: log.logIndex || log.index, // Some providers use 'index' instead of 'logIndex'
        args: args,
        // Add actual sender/recipient info
        actualSender: actualSender,
        actualRecipient: actualRecipient,
        timestamp: Date.now()
      };

      // Debug log for Swap events
      if (parsedLog.name === 'Swap') {
        console.log(`Swap event - Router: ${args.sender} -> ${args.recipient}, Actual: ${actualSender} -> ${actualRecipient}`);
      }

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

  async processExchangeHelperLog(log) {
    try {
      // Parse the log to determine event type
      const parsedLog = this.exchangeHelper.interface.parseLog(log);
      if (!parsedLog) return;
      
      // Only process trade events
      const validEvents = ['BoughtTokensETH', 'BoughtTokensWETH', 'SoldTokensETH', 'SoldTokensWETH'];
      if (!validEvents.includes(parsedLog.name)) {
        return;
      }
      
      // Convert args to plain object
      const args = {
        who: parsedLog.args[0],
        amount: parsedLog.args[1].toString()
      };
      
      const eventData = {
        contractAddress: EXCHANGE_HELPER_ADDRESS,
        eventName: parsedLog.name,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        logIndex: log.logIndex || log.index,
        args: args,
        timestamp: Date.now(),
        isExchangeHelper: true // Flag to distinguish from pool events
      };
      
      console.log(`ExchangeHelper ${parsedLog.name} event - User: ${args.who}, Amount: ${args.amount}`);
      
      // Emit as a special event type for ExchangeHelper trades
      this.emit('exchangeHelperEvent', eventData);
      
    } catch (error) {
      console.error('Error processing ExchangeHelper log:', error.message);
    }
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