import { ethers } from 'ethers';
import EventEmitter from 'events';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load ExtVault ABI for lending events
let ExtVaultABI;
try {
  const abiPath = path.join(__dirname, '..', '..', 'assets', 'ExtVault.json');
  const abiData = JSON.parse(await fs.readFile(abiPath, 'utf-8'));
  ExtVaultABI = abiData.abi;
} catch (error) {
  console.error('Failed to load ExtVault ABI:', error);
  ExtVaultABI = [];
}

/**
 * LoanMonitor - Monitors lending vault events (Borrow, Payback, RollLoan, DefaultLoans)
 *
 * Emits 'loanEvent' when a loan operation is detected with the following structure:
 * {
 *   vaultAddress: string,
 *   eventName: 'Borrow' | 'Payback' | 'RollLoan' | 'DefaultLoans',
 *   blockNumber: number,
 *   blockHash: string,
 *   transactionHash: string,
 *   transactionIndex: number,
 *   logIndex: number,
 *   args: object, // Event-specific arguments
 *   timestamp: number
 * }
 */
export class LoanMonitor extends EventEmitter {
  constructor(provider, vaultAddresses = []) {
    super();
    this.provider = provider;
    this.vaultAddresses = vaultAddresses;
    this.vaultContracts = new Map();
    this.isRunning = false;
    this.lastBlockUpdateTime = Date.now();
  }

  async initialize() {
    console.log(`Initializing LoanMonitor for ${this.vaultAddresses.length} vaults...`);

    // Create contract instances for each vault using the full ABI
    for (const vaultAddress of this.vaultAddresses) {
      const contract = new ethers.Contract(vaultAddress, ExtVaultABI, this.provider);
      this.vaultContracts.set(vaultAddress.toLowerCase(), contract);
    }

    console.log(`LoanMonitor initialized with ${this.vaultContracts.size} vault contracts`);
  }

  async start() {
    if (this.isRunning) {
      console.log('LoanMonitor already running');
      return;
    }

    // Check if provider supports WebSocket
    if (this.provider.isWebSocketProvider) {
      console.log('Setting up WebSocket event listeners for loan events...');
      await this.setupWebSocketListeners();
    } else {
      console.warn('Provider does not support WebSocket, loan monitoring will use polling');
      // Could implement polling here if needed
    }

    this.isRunning = true;
    console.log('LoanMonitor started');
  }

  async setupWebSocketListeners() {
    for (const [vaultAddress, contract] of this.vaultContracts) {
      // Listen for Borrow events
      contract.on('Borrow', async (who, borrowAmount, duration, event) => {
        await this.handleLoanEvent('Borrow', vaultAddress, event, {
          who,
          borrowAmount: borrowAmount.toString(),
          duration: duration.toString()
        });
      });

      // Listen for Payback events
      contract.on('Payback', async (who, event) => {
        await this.handleLoanEvent('Payback', vaultAddress, event, {
          who
        });
      });

      // Listen for RollLoan events
      contract.on('RollLoan', async (who, event) => {
        await this.handleLoanEvent('RollLoan', vaultAddress, event, {
          who
        });
      });

      // Listen for DefaultLoans events
      contract.on('DefaultLoans', async (event) => {
        await this.handleLoanEvent('DefaultLoans', vaultAddress, event, {});
      });

      console.log(`Loan event listeners registered for vault: ${vaultAddress}`);
    }
  }

  async handleLoanEvent(eventName, vaultAddress, event, parsedArgs) {
    try {
      this.lastBlockUpdateTime = Date.now();

      const loanEvent = {
        vaultAddress,
        eventName,
        blockNumber: event.log.blockNumber,
        blockHash: event.log.blockHash,
        transactionHash: event.log.transactionHash,
        transactionIndex: event.log.transactionIndex,
        logIndex: event.log.index,
        args: parsedArgs,
        timestamp: Date.now()
      };

      // Emit the loan event for storage and broadcasting
      this.emit('loanEvent', loanEvent);

      console.log(`📋 ${eventName} event detected on vault ${vaultAddress} by ${parsedArgs.who || 'system'}`);
    } catch (error) {
      console.error(`Error handling ${eventName} event:`, error);
    }
  }

  async removeListeners() {
    console.log('Removing loan event listeners...');
    for (const contract of this.vaultContracts.values()) {
      contract.removeAllListeners();
    }
  }

  async stop() {
    if (!this.isRunning) return;

    await this.removeListeners();
    this.isRunning = false;
    console.log('LoanMonitor stopped');
  }

  /**
   * Scan historical blocks for loan events
   * @param {number} hoursBack - How many hours to scan back
   */
  async scanHistoricalBlocks(hoursBack = 24) {
    const currentBlock = await this.provider.getBlockNumber();
    const blocksBack = Math.floor((hoursBack * 60 * 60) / 1); // Assuming 1 second per block
    const startBlock = Math.max(0, currentBlock - blocksBack);

    console.log(`\n📚 Scanning ${hoursBack} hours of loan events (blocks ${startBlock} to ${currentBlock})...`);

    let totalEvents = 0;

    for (const [vaultAddress, contract] of this.vaultContracts) {
      try {
        // Create filters for each event type
        const borrowFilter = contract.filters.Borrow();
        const paybackFilter = contract.filters.Payback();
        const rollLoanFilter = contract.filters.RollLoan();
        const defaultLoansFilter = contract.filters.DefaultLoans();

        // Query all event types in parallel
        const [borrowEvents, paybackEvents, rollLoanEvents, defaultLoansEvents] = await Promise.all([
          contract.queryFilter(borrowFilter, startBlock, currentBlock),
          contract.queryFilter(paybackFilter, startBlock, currentBlock),
          contract.queryFilter(rollLoanFilter, startBlock, currentBlock),
          contract.queryFilter(defaultLoansFilter, startBlock, currentBlock)
        ]);

        // Process Borrow events
        for (const event of borrowEvents) {
          const parsedLog = event.args;
          await this.handleLoanEvent('Borrow', vaultAddress, { log: event }, {
            who: parsedLog.who,
            borrowAmount: parsedLog.borrowAmount.toString(),
            duration: parsedLog.duration.toString()
          });
          totalEvents++;
        }

        // Process Payback events
        for (const event of paybackEvents) {
          const parsedLog = event.args;
          await this.handleLoanEvent('Payback', vaultAddress, { log: event }, {
            who: parsedLog.who
          });
          totalEvents++;
        }

        // Process RollLoan events
        for (const event of rollLoanEvents) {
          const parsedLog = event.args;
          await this.handleLoanEvent('RollLoan', vaultAddress, { log: event }, {
            who: parsedLog.who
          });
          totalEvents++;
        }

        // Process DefaultLoans events
        for (const event of defaultLoansEvents) {
          await this.handleLoanEvent('DefaultLoans', vaultAddress, { log: event }, {});
          totalEvents++;
        }

        if (borrowEvents.length + paybackEvents.length + rollLoanEvents.length + defaultLoansEvents.length > 0) {
          console.log(`   Found ${borrowEvents.length + paybackEvents.length + rollLoanEvents.length + defaultLoansEvents.length} loan events for vault ${vaultAddress}`);
        }
      } catch (error) {
        console.error(`Error scanning historical loan events for vault ${vaultAddress}:`, error);
      }
    }

    console.log(`✅ Historical loan scan complete! Total events found: ${totalEvents}`);
    return totalEvents;
  }
}
