import { ethers } from 'ethers';
import EventEmitter from 'events';
import cache from './cache.js';
import { createProvider, checkProviderConnection } from './provider.js';
import { ProcessedTxTracker } from './processed-tx-tracker.js';

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
  constructor(rpcUrl, poolAddresses, poolMetadata = []) {
    super();
    this.provider = createProvider(rpcUrl);
    this.poolAddresses = poolAddresses;
    this.contracts = new Map();
    this.poolMetadata = new Map(); // Map poolAddress -> { symbol, name, etc }
    this.isRunning = false;
    this.requestQueue = [];
    this.lastRequestTime = 0;
    this.exchangeHelper = null;
    this.lastEventTime = Date.now(); // Track last event for heartbeat
    this.heartbeatInterval = null;
    this.connectionCheckInterval = null;
    this.lastBlockUpdateTime = Date.now(); // Track last block update
    this.processedTxTracker = new ProcessedTxTracker();
    this.isRecovering = false; // Track recovery state

    // Build pool metadata map
    for (const pool of poolMetadata) {
      this.poolMetadata.set(pool.address.toLowerCase(), pool);
    }
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

    // Initialize processed transaction tracker
    await this.processedTxTracker.initialize();
  }

  async start() {
    if (this.isRunning) return;

    // Check provider connection first
    const isConnected = await checkProviderConnection(this.provider);
    if (!isConnected) {
      throw new Error('Failed to connect to blockchain provider');
    }

    this.isRunning = true;

    // For WebSocket providers, set up event listeners for real-time updates
    if (this.provider.isWebSocketProvider) {
      console.log('Setting up WebSocket event listeners...');
      await this.setupWebSocketListeners();

      // Set up reconnection handler using callbacks
      this.provider.onReconnected = async () => {
        console.log('Provider reconnected, re-establishing event listeners...');
        await this.setupWebSocketListeners();
      };

      // Set up disconnection handler using callbacks
      this.provider.onDisconnected = () => {
        console.log('Provider disconnected, event listeners will be re-established on reconnection');
      };
    }

    // Start polling for events (works for both HTTP and WebSocket as backup)
    this.lastBlock = await this.provider.getBlockNumber();
    console.log(`Starting from block ${this.lastBlock}`);

    this.pollInterval = setInterval(async () => {
      await this.pollEvents();
    }, 20000); // Poll every 20 seconds to reduce API load

    // Start heartbeat monitoring to detect stalled connections
    this.startHeartbeat();

    // Start periodic connection health checks
    this.startConnectionHealthCheck();

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
      // Check if transaction was already processed
      if (this.processedTxTracker.isProcessed(log.transactionHash)) {
        console.log(`Skipping duplicate transaction: ${log.transactionHash}`);
        return;
      }

      // Parse the log to determine event type
      const parsedLog = contract.interface.parseLog(log);
      if (!parsedLog) return;
      
      // Only process Swap events from pools
      if (parsedLog.name !== 'Swap') {
        return;
      }
      
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
      
      // Get pool metadata
      const poolMeta = this.poolMetadata.get(poolAddress.toLowerCase());

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
        // Add token symbol (capitalized)
        tokenSymbol: poolMeta?.symbol || 'UNKNOWN',
        poolName: poolMeta?.name,
        timestamp: Date.now()
      };

      // Debug log for Swap events
      if (parsedLog.name === 'Swap') {
        console.log(`Swap event - Router: ${args.sender} -> ${args.recipient}, Actual: ${actualSender} -> ${actualRecipient}`);
      }

      // Mark transaction as processed BEFORE emitting to prevent race conditions
      this.processedTxTracker.markProcessed(log.transactionHash);

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
      // Check if transaction was already processed
      if (this.processedTxTracker.isProcessed(log.transactionHash)) {
        console.log(`Skipping duplicate ExchangeHelper transaction: ${log.transactionHash}`);
        return;
      }

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

      // Mark transaction as processed BEFORE emitting to prevent race conditions
      this.processedTxTracker.markProcessed(log.transactionHash);

      // Emit as a special event type for ExchangeHelper trades
      this.emit('exchangeHelperEvent', eventData);

    } catch (error) {
      console.error('Error processing ExchangeHelper log:', error.message);
    }
  }

  async setupWebSocketListeners() {
    // Remove all existing listeners first to prevent duplicates
    for (const contract of this.contracts.values()) {
      contract.removeAllListeners();
    }
    if (this.exchangeHelper) {
      this.exchangeHelper.removeAllListeners();
    }

    // Set up real-time event listeners for each pool
    for (const [poolAddress, contract] of this.contracts) {
      try {
        // Listen to all events but filter to Swap only in processLog
        contract.on('*', async (event) => {
          console.log(`Real-time event from pool ${poolAddress}:`, event.eventName);
          this.lastEventTime = Date.now(); // Update heartbeat
          await this.processLog(poolAddress, contract, event.log);
        });
      } catch (error) {
        console.error(`Error setting up listeners for pool ${poolAddress}:`, error);
      }
    }

    // Set up listener for ExchangeHelper events
    if (this.exchangeHelper) {
      this.exchangeHelper.on('*', async (event) => {
        console.log(`Real-time ExchangeHelper event:`, event.eventName);
        this.lastEventTime = Date.now(); // Update heartbeat
        await this.processExchangeHelperLog(event.log);
      });
    }

    // Listen for new blocks (useful for updating lastBlock)
    this.provider.removeAllListeners('block'); // Remove old listener
    this.provider.on('block', (blockNumber) => {
      this.lastBlock = blockNumber;
      this.lastBlockUpdateTime = Date.now(); // Update block heartbeat
    });
  }

  startHeartbeat() {
    // Check every 2 minutes if we're receiving events or block updates
    this.heartbeatInterval = setInterval(async () => {
      const now = Date.now();
      const timeSinceLastBlock = now - this.lastBlockUpdateTime;

      // If no block updates for 5 minutes, something is wrong
      if (timeSinceLastBlock > 5 * 60 * 1000) {
        console.error(`⚠️ HEARTBEAT FAILED: No block updates for ${Math.round(timeSinceLastBlock / 1000)}s`);
        console.error('Connection appears stalled. Attempting automatic recovery...');
        this.emit('connectionStalled');

        // Attempt automatic recovery
        await this.recoverConnection();
      } else {
        console.log(`✓ Heartbeat OK - Last block update: ${Math.round(timeSinceLastBlock / 1000)}s ago`);
      }
    }, 2 * 60 * 1000); // Check every 2 minutes
  }

  startConnectionHealthCheck() {
    // Check provider connection health every 5 minutes
    this.connectionCheckInterval = setInterval(async () => {
      try {
        const isConnected = await checkProviderConnection(this.provider);
        if (!isConnected) {
          console.error('⚠️ CONNECTION HEALTH CHECK FAILED');
          console.error('Attempting automatic recovery...');
          this.emit('connectionFailed');

          // Attempt automatic recovery
          await this.recoverConnection();
        } else {
          console.log('✓ Connection health check passed');
        }
      } catch (error) {
        console.error('Connection health check error:', error.message);
        // Attempt recovery on health check errors too
        await this.recoverConnection();
      }
    }, 5 * 60 * 1000); // Check every 5 minutes
  }

  async recoverConnection() {
    // Prevent multiple simultaneous recovery attempts
    if (this.isRecovering) {
      console.log('Recovery already in progress, skipping...');
      return;
    }

    this.isRecovering = true;
    console.log('🔄 Starting connection recovery...');

    try {
      // Step 1: Remove all existing listeners to prevent duplicates
      console.log('   1. Removing existing event listeners...');
      if (this.provider.isWebSocketProvider) {
        this.provider.removeAllListeners();
        for (const contract of this.contracts.values()) {
          contract.removeAllListeners();
        }
        if (this.exchangeHelper) {
          this.exchangeHelper.removeAllListeners();
        }
      }

      // Step 2: Try to get current block to test connection
      console.log('   2. Testing provider connection...');
      let connectionOk = false;
      try {
        await this.provider.getBlockNumber();
        connectionOk = true;
        console.log('   ✓ Provider connection is working');
      } catch (error) {
        console.error('   ✗ Provider connection failed:', error.message);
      }

      // Step 3: Re-establish event listeners
      if (connectionOk && this.provider.isWebSocketProvider) {
        console.log('   3. Re-establishing WebSocket event listeners...');
        await this.setupWebSocketListeners();
      }

      // Step 4: Reset heartbeat timestamp
      this.lastBlockUpdateTime = Date.now();
      console.log('   4. Reset heartbeat timestamp');

      // Step 5: Verify recovery
      console.log('   5. Verifying recovery...');
      await this.sleep(5000); // Wait 5 seconds
      const currentBlock = await this.provider.getBlockNumber();
      console.log(`   ✓ Recovery successful! Current block: ${currentBlock}`);

      this.emit('connectionRecovered');

    } catch (error) {
      console.error('❌ Connection recovery failed:', error.message);
      console.error('The monitor will continue attempting recovery on next heartbeat check.');
    } finally {
      this.isRecovering = false;
    }
  }

  async scanHistoricalBlocks(hoursBack = 24) {
    try {
      const currentBlock = await this.provider.getBlockNumber();
      const currentBlockData = await this.provider.getBlock(currentBlock);
      const currentTimestamp = currentBlockData.timestamp;

      // Calculate block range (approximate)
      const secondsBack = hoursBack * 60 * 60;
      const targetTimestamp = currentTimestamp - secondsBack;

      // Estimate blocks back (assuming ~2 second block time for most EVM chains)
      const estimatedBlocksBack = Math.floor(secondsBack / 2);
      const fromBlock = Math.max(0, currentBlock - estimatedBlocksBack);

      console.log(`🔍 Starting historical scan from block ${fromBlock} to ${currentBlock} (last ${hoursBack} hours)`);
      console.log(`   Estimated ${estimatedBlocksBack} blocks to scan`);
      console.log(`   Currently tracking ${this.processedTxTracker.processedTxs.size} processed transactions`);

      let totalEventsFound = 0;
      let duplicatesSkipped = 0;
      const maxBlockRange = 1000; // Scan in chunks of 1000 blocks

      for (let startBlock = fromBlock; startBlock <= currentBlock; startBlock += maxBlockRange) {
        const endBlock = Math.min(startBlock + maxBlockRange - 1, currentBlock);

        console.log(`   Scanning blocks ${startBlock} to ${endBlock}...`);

        // Query all pools
        for (const [address, contract] of this.contracts) {
          try {
            const filter = {
              address: address,
              fromBlock: startBlock,
              toBlock: endBlock
            };

            const events = await this.rateLimitedRequest(async () => {
              return await this.provider.getLogs(filter);
            });

            if (events.length > 0) {
              console.log(`   Found ${events.length} events for pool ${address} in blocks ${startBlock}-${endBlock}`);

              // Count duplicates
              const beforeCount = this.processedTxTracker.processedTxs.size;
              for (const log of events) {
                if (this.processedTxTracker.isProcessed(log.transactionHash)) {
                  duplicatesSkipped++;
                }
                totalEventsFound++;
              }

              // Process all events (duplicates will be skipped in processLog)
              for (const log of events) {
                await this.processLog(address, contract, log);
              }
            }

            await this.sleep(RATE_LIMIT_CONFIG.requestDelay);

          } catch (error) {
            console.error(`Error scanning pool ${address}:`, error.message);
          }
        }

        // Scan ExchangeHelper events
        if (this.exchangeHelper) {
          try {
            const exchangeHelperFilter = {
              address: EXCHANGE_HELPER_ADDRESS,
              fromBlock: startBlock,
              toBlock: endBlock
            };

            const exchangeEvents = await this.rateLimitedRequest(async () => {
              return await this.provider.getLogs(exchangeHelperFilter);
            });

            if (exchangeEvents.length > 0) {
              console.log(`   Found ${exchangeEvents.length} ExchangeHelper events in blocks ${startBlock}-${endBlock}`);

              // Count duplicates
              for (const log of exchangeEvents) {
                if (this.processedTxTracker.isProcessed(log.transactionHash)) {
                  duplicatesSkipped++;
                }
                totalEventsFound++;
              }

              // Process all events (duplicates will be skipped in processExchangeHelperLog)
              for (const log of exchangeEvents) {
                await this.processExchangeHelperLog(log);
              }
            }

            await this.sleep(RATE_LIMIT_CONFIG.requestDelay);

          } catch (error) {
            console.error(`Error scanning ExchangeHelper:`, error.message);
          }
        }

        // Progress update
        const progress = ((endBlock - fromBlock) / (currentBlock - fromBlock) * 100).toFixed(1);
        console.log(`   Progress: ${progress}% (${endBlock - fromBlock} / ${currentBlock - fromBlock} blocks)`);
      }

      const newEvents = totalEventsFound - duplicatesSkipped;
      console.log(`✅ Historical scan complete!`);
      console.log(`   Total events found: ${totalEventsFound}`);
      console.log(`   Duplicates skipped: ${duplicatesSkipped}`);
      console.log(`   New events processed: ${newEvents}`);

      return { totalEventsFound, duplicatesSkipped, newEvents };

    } catch (error) {
      console.error('Error during historical block scan:', error);
      throw error;
    }
  }

  async stop() {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.connectionCheckInterval) {
      clearInterval(this.connectionCheckInterval);
      this.connectionCheckInterval = null;
    }

    // Remove WebSocket listeners if using WebSocket provider
    if (this.provider.isWebSocketProvider) {
      this.provider.removeAllListeners();
      for (const contract of this.contracts.values()) {
        contract.removeAllListeners();
      }
      if (this.exchangeHelper) {
        this.exchangeHelper.removeAllListeners();
      }
    }

    // Stop and save processed tx tracker
    await this.processedTxTracker.stop();

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