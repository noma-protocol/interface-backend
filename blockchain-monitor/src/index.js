import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { BlockchainMonitor } from './blockchain-monitor.js';
import { EventStorage } from './event-storage.js';
import { LoanMonitor } from './loan-monitor.js';
import { LoanStorage } from './loan-storage.js';
import { WSServer } from './websocket-server.js';
import { AuthManager } from './auth-manager.js';
import { ReferralStore } from './referral-store.js';
import { ReferralTracker } from './referral-tracker.js';
import { HTTPServer } from './http-server.js';
import cache from './cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse command line arguments
const args = process.argv.slice(2);
const DEBUG = args.includes('--debug');

// Set up global debug flag
global.DEBUG = DEBUG;

// Load .env from blockchain-monitor directory
dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function loadPools() {
  try {
    const poolsPath = path.join(__dirname, '..', '..', 'data', 'pools.json');
    const poolsData = await fs.readFile(poolsPath, 'utf-8');
    const poolsConfig = JSON.parse(poolsData);
    return poolsConfig.pools
      .filter(pool => pool.enabled !== false)
      .map(pool => ({
        address: pool.address,
        symbol: pool.token0.symbol.toUpperCase(), // Capitalize token symbol
        name: pool.name,
        token0: pool.token0,
        token1: pool.token1
      }));
  } catch (error) {
    console.error('Failed to load pools from data/pools.json:', error.message);
    return [];
  }
}

async function loadVaults(rpcUrl) {
  try {
    // Import VaultService dynamically
    const { VaultService } = await import('./vaults.js');
    const vaultService = new VaultService(rpcUrl);

    console.log('Loading vaults from blockchain...');
    const allVaults = await vaultService.getAllVaults();

    if (allVaults.length === 0) {
      console.log('No vaults found on blockchain');
      return [];
    }

    console.log(`Found ${allVaults.length} vaults for loan monitoring`);

    // Map vault info to the format needed by LoanMonitor
    return allVaults.map(vault => ({
      address: vault.vaultAddress,
      tokenSymbol: vault.tokenSymbol || 'VAULT',
      tokenName: vault.tokenName || 'Lending Vault'
    }));
  } catch (error) {
    console.error('Failed to load vaults:', error.message);

    // Fallback to env var if API fails
    const vaultAddresses = process.env.VAULT_ADDRESSES
      ? process.env.VAULT_ADDRESSES.split(',').map(addr => addr.trim())
      : [];

    if (vaultAddresses.length > 0) {
      console.log(`Using ${vaultAddresses.length} vaults from VAULT_ADDRESSES env var`);
      return vaultAddresses.map(address => ({
        address,
        tokenSymbol: 'VAULT',
        tokenName: 'Lending Vault'
      }));
    }

    return [];
  }
}

async function main() {
  try {
    console.log('Initializing services...');
    if (DEBUG) {
      console.log('Debug mode enabled');
    }

    const rpcUrl = process.env.RPC_URL;
    const websocketPort = parseInt(process.env.WEBSOCKET_PORT) || 8080;
    const httpPort = parseInt(process.env.HTTP_PORT) || 3004;
    // Use shared data directory (same as pools.json location)
    const historyFilePath = process.env.HISTORY_FILE_PATH || path.join(__dirname, '..', '..', 'data', 'events-history.json');
    const autoRestartHours = parseFloat(process.env.AUTO_RESTART_HOURS) || 0;
    const historicalScanHours = parseFloat(process.env.HISTORICAL_SCAN_HOURS) || 0;

    if (!rpcUrl) {
      throw new Error('RPC_URL environment variable is required');
    }

    const pools = await loadPools();
    const poolAddresses = process.env.POOL_ADDRESSES
      ? process.env.POOL_ADDRESSES.split(',').map(addr => addr.trim())
      : pools.map(p => p.address);

    const vaults = await loadVaults(rpcUrl);
    const vaultAddresses = vaults.map(v => v.address);

    console.log('Initializing services...');

    const eventStorage = new EventStorage(historyFilePath, pools);
    await eventStorage.initialize();

    // Clean up any existing duplicates
    console.log('Checking for duplicate events in storage...');
    await eventStorage.removeDuplicates();

    // Initialize loan storage for vault lending events
    const loanHistoryFilePath = path.join(__dirname, '..', '..', 'data', 'loans-history.json');
    const loanStorage = new LoanStorage(loanHistoryFilePath, vaults);
    await loanStorage.initialize();

    // Clean up any existing duplicate loans
    console.log('Checking for duplicate loan events in storage...');
    await loanStorage.removeDuplicates();

    const authManager = new AuthManager();

    const blockchainMonitor = new BlockchainMonitor(rpcUrl, poolAddresses, pools);
    await blockchainMonitor.initialize();

    // Initialize referral system
    const referralStore = new ReferralStore();
    await referralStore.initialize();

    const referralTracker = new ReferralTracker(
      blockchainMonitor.provider,
      referralStore,
      `http://localhost:${httpPort}`
    );
    await referralTracker.initialize();

    // Initialize loan monitor for vault lending events
    let loanMonitor = null;
    if (vaultAddresses.length > 0) {
      loanMonitor = new LoanMonitor(blockchainMonitor.provider, vaultAddresses);
      await loanMonitor.initialize();
      console.log(`Loan monitoring enabled for ${vaultAddresses.length} vaults`);
    }

    // Initialize HTTP server for referral API (pass the same referral store, rpcUrl, and loan storage)
    const httpServer = new HTTPServer(httpPort, referralStore, rpcUrl, loanStorage);
    await httpServer.initialize();
    httpServer.start();

    const wsServer = new WSServer(websocketPort, eventStorage, authManager);
    // Pass loan storage to WebSocket server for loan event broadcasting
    wsServer.loanStorage = loanStorage;

    blockchainMonitor.on('poolEvent', async (eventData) => {
      console.log(`New ${eventData.eventName} event from pool ${eventData.poolAddress}`);

      const storedEvent = await eventStorage.addEvent(eventData);

      console.log(`Broadcasting ${eventData.eventName} event from pool ${eventData.poolAddress} with id ${storedEvent.id}`);
      wsServer.broadcastEvent(storedEvent);

      // Track referral trades (legacy - for pools that don't use ExchangeHelper)
      if (eventData.eventName === 'Swap') {
        await referralTracker.trackSwapEvent(eventData);
      }
    });

    // Handle ExchangeHelper events for referral tracking
    blockchainMonitor.on('exchangeHelperEvent', async (eventData) => {
      console.log(`New ExchangeHelper ${eventData.eventName} event - User: ${eventData.args.who}`);

      // Store the event
      const storedEvent = await eventStorage.addEvent(eventData);

      // Broadcast to WebSocket clients
      wsServer.broadcastEvent(storedEvent);

      // Track referral trades through ExchangeHelper
      await referralTracker.trackExchangeHelperEvent(eventData);
    });

    // Handle loan events from vaults
    if (loanMonitor) {
      loanMonitor.on('loanEvent', async (loanData) => {
        console.log(`New ${loanData.eventName} event from vault ${loanData.vaultAddress}`);

        // Store the loan event
        const storedLoan = await loanStorage.addLoan(loanData);

        console.log(`Broadcasting ${loanData.eventName} loan event from vault ${loanData.vaultAddress} with id ${storedLoan.id}`);

        // Broadcast to WebSocket clients
        wsServer.broadcastLoanEvent(storedLoan);
      });
    }

    wsServer.start();
    await blockchainMonitor.start();

    // Start loan monitor if configured
    if (loanMonitor) {
      await loanMonitor.start();
    }

    console.log('Blockchain monitor started successfully');
    console.log(`Monitoring ${poolAddresses.length} pools`);
    if (loanMonitor) {
      console.log(`Monitoring ${vaultAddresses.length} vaults for loan events`);
    }
    console.log(`WebSocket server running on port ${websocketPort}`);
    console.log(`HTTP referral API running on port ${httpPort}`);

    // Listen for connection recovery events
    blockchainMonitor.on('connectionRecovered', () => {
      console.log('✅ Connection recovered successfully!');
    });

    // Perform historical block scan if configured
    if (historicalScanHours > 0) {
      console.log(`\n📚 Starting historical block scan (${historicalScanHours} hours)...`);
      try {
        await blockchainMonitor.scanHistoricalBlocks(historicalScanHours);
      } catch (error) {
        console.error('Historical scan failed:', error.message);
        console.log('Continuing with normal operation...');
      }

      // Also scan for historical loan events
      if (loanMonitor) {
        console.log(`\n📚 Starting historical loan event scan (${historicalScanHours} hours)...`);
        try {
          await loanMonitor.scanHistoricalBlocks(historicalScanHours);
        } catch (error) {
          console.error('Historical loan scan failed:', error.message);
          console.log('Continuing with normal operation...');
        }
      }
    } else {
      console.log('Historical block scanning disabled (set HISTORICAL_SCAN_HOURS to enable)');
    }

    // Set up automatic restart if configured
    if (autoRestartHours > 0) {
      const restartMs = autoRestartHours * 60 * 60 * 1000;
      console.log(`\n⏰ Auto-restart enabled: Server will restart after ${autoRestartHours} hour(s)`);

      setTimeout(async () => {
        console.log('\n🔄 Auto-restart triggered - Restarting server...');
        await blockchainMonitor.stop();
        if (loanMonitor) await loanMonitor.stop();
        wsServer.stop();
        httpServer.stop();
        // Exit with code 0 so process manager (like PM2) can restart it
        process.exit(0);
      }, restartMs);
    } else {
      console.log('Auto-restart disabled (set AUTO_RESTART_HOURS to enable)');
    }

    // Start cache statistics logging
    cache.startStatsLogging(60000); // Log every minute
    console.log('Cache statistics logging enabled (every 60 seconds)');

    // Log processed tx stats periodically
    setInterval(() => {
      const stats = blockchainMonitor.processedTxTracker.getStats();
      console.log(`📊 Processed TX Stats - Total: ${stats.total}, Last 24h: ${stats.last24h}, Last 48h: ${stats.last48h}`);
    }, 10 * 60 * 1000); // Every 10 minutes

    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      await blockchainMonitor.stop();
      if (loanMonitor) await loanMonitor.stop();
      wsServer.stop();
      httpServer.stop();
      process.exit(0);
    });

    // Cleanup old events daily
    setInterval(async () => {
      await eventStorage.clearOldEvents(30);
      await loanStorage.clearOldLoans(90); // Keep loan history for 90 days
    }, 24 * 60 * 60 * 1000);

    // Cleanup old processed transaction hashes daily (older than 48 hours)
    setInterval(async () => {
      console.log('Running scheduled cleanup of old processed transaction hashes...');
      await blockchainMonitor.processedTxTracker.cleanup();
    }, 24 * 60 * 60 * 1000);

  } catch (error) {
    console.error('Failed to start blockchain monitor:', error);
    process.exit(1);
  }
}

main();