import fs from 'fs/promises';
import path from 'path';

// Helper function to convert BigInt to string in nested objects
function bigIntReplacer(key, value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

// Helper function to convert string back to BigInt when needed
function bigIntReviver(key, value) {
  // Common BigInt fields in loan events
  const bigIntFields = ['borrowAmount', 'duration'];
  if (bigIntFields.includes(key) && typeof value === 'string' && /^\d+$/.test(value)) {
    return BigInt(value);
  }
  return value;
}

/**
 * LoanStorage - Stores and manages loan operation history
 *
 * Stores loan events with the following structure:
 * {
 *   id: string, // Unique identifier: transactionHash-logIndex
 *   vaultAddress: string,
 *   eventName: string, // 'Borrow', 'Payback', 'RollLoan', 'DefaultLoans'
 *   blockNumber: number,
 *   blockHash: string,
 *   transactionHash: string,
 *   transactionIndex: number,
 *   logIndex: number,
 *   args: object, // Event-specific arguments
 *   timestamp: number, // Event timestamp
 *   storedAt: number // When it was stored in our system
 * }
 */
export class LoanStorage {
  constructor(filePath, vaultMetadata = []) {
    this.filePath = filePath;
    this.loans = [];
    this.isInitialized = false;

    // Build vault metadata map for quick lookups
    this.vaultMetadata = new Map();
    for (const vault of vaultMetadata) {
      this.vaultMetadata.set(vault.address.toLowerCase(), vault);
    }
  }

  async initialize() {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });

      try {
        const data = await fs.readFile(this.filePath, 'utf-8');
        this.loans = JSON.parse(data, bigIntReviver);
        console.log(`Loaded ${this.loans.length} loan events from storage`);
      } catch (error) {
        if (error.code === 'ENOENT') {
          this.loans = [];
          await this.save();
          console.log('Created new loan storage file');
        } else {
          throw error;
        }
      }

      this.isInitialized = true;
    } catch (error) {
      console.error('Failed to initialize loan storage:', error);
      throw error;
    }
  }

  async addLoan(loanEvent) {
    if (!this.isInitialized) {
      throw new Error('LoanStorage not initialized');
    }

    const loanId = this.generateLoanId(loanEvent);

    // Check if loan event already exists
    const existingLoan = this.loans.find(l => l.id === loanId);
    if (existingLoan) {
      console.log(`Loan event ${loanId} already exists in storage, skipping`);
      return existingLoan;
    }

    const loanWithId = {
      ...loanEvent,
      id: loanId,
      storedAt: Date.now()
    };

    this.loans.push(loanWithId);
    await this.save();

    return loanWithId;
  }

  async save() {
    try {
      await fs.writeFile(this.filePath, JSON.stringify(this.loans, bigIntReplacer, 2));
    } catch (error) {
      console.error('Failed to save loan events:', error);
      throw error;
    }
  }

  generateLoanId(loanEvent) {
    return `${loanEvent.transactionHash}-${loanEvent.logIndex}`;
  }

  enrichLoanWithVaultInfo(loan) {
    // Add vault metadata if not present
    if (!loan.vaultSymbol && loan.vaultAddress) {
      const vaultMeta = this.vaultMetadata.get(loan.vaultAddress.toLowerCase());
      if (vaultMeta) {
        return {
          ...loan,
          vaultSymbol: vaultMeta.tokenSymbol,
          vaultName: vaultMeta.tokenName
        };
      }
    }
    return loan;
  }

  getAllLoans() {
    return this.loans.map(l => this.enrichLoanWithVaultInfo(l));
  }

  getLoansSince(timestamp) {
    return this.loans
      .filter(loan => loan.timestamp >= timestamp)
      .map(l => this.enrichLoanWithVaultInfo(l));
  }

  getLoansByVault(vaultAddress) {
    return this.loans
      .filter(loan =>
        loan.vaultAddress.toLowerCase() === vaultAddress.toLowerCase()
      )
      .map(l => this.enrichLoanWithVaultInfo(l));
  }

  getLoansByUser(userAddress) {
    return this.loans
      .filter(loan =>
        loan.args.who && loan.args.who.toLowerCase() === userAddress.toLowerCase()
      )
      .map(l => this.enrichLoanWithVaultInfo(l));
  }

  getLoansByTransactionHash(txHash) {
    return this.loans
      .filter(loan => loan.transactionHash === txHash)
      .map(l => this.enrichLoanWithVaultInfo(l));
  }

  getLoansByType(eventName) {
    return this.loans
      .filter(loan => loan.eventName === eventName)
      .map(l => this.enrichLoanWithVaultInfo(l));
  }

  getLoanCount() {
    return this.loans.length;
  }

  getLatestLoans(limit = 100) {
    return this.loans
      .slice(-limit)
      .reverse()
      .map(l => this.enrichLoanWithVaultInfo(l));
  }

  /**
   * Get loan statistics by user
   * @param {string} userAddress - User's address
   * @returns {object} Statistics including total borrowed, total repaid, active loans
   */
  getLoanStatsByUser(userAddress) {
    const userLoans = this.getLoansByUser(userAddress);

    const borrows = userLoans.filter(l => l.eventName === 'Borrow');
    const paybacks = userLoans.filter(l => l.eventName === 'Payback');
    const rolls = userLoans.filter(l => l.eventName === 'RollLoan');

    // Calculate total borrowed amount
    const totalBorrowed = borrows.reduce((sum, loan) => {
      return sum + BigInt(loan.args.borrowAmount || '0');
    }, BigInt(0));

    return {
      userAddress,
      totalBorrows: borrows.length,
      totalPaybacks: paybacks.length,
      totalRolls: rolls.length,
      totalBorrowed: totalBorrowed.toString(),
      loans: userLoans
    };
  }

  /**
   * Get loan statistics by vault
   * @param {string} vaultAddress - Vault's address
   * @returns {object} Statistics including total borrows, total amount borrowed
   */
  getLoanStatsByVault(vaultAddress) {
    const vaultLoans = this.getLoansByVault(vaultAddress);

    const borrows = vaultLoans.filter(l => l.eventName === 'Borrow');
    const paybacks = vaultLoans.filter(l => l.eventName === 'Payback');
    const rolls = vaultLoans.filter(l => l.eventName === 'RollLoan');
    const defaults = vaultLoans.filter(l => l.eventName === 'DefaultLoans');

    // Calculate total borrowed amount
    const totalBorrowed = borrows.reduce((sum, loan) => {
      return sum + BigInt(loan.args.borrowAmount || '0');
    }, BigInt(0));

    // Get unique borrowers
    const uniqueBorrowers = new Set(
      vaultLoans
        .filter(l => l.args.who)
        .map(l => l.args.who.toLowerCase())
    );

    return {
      vaultAddress,
      totalBorrows: borrows.length,
      totalPaybacks: paybacks.length,
      totalRolls: rolls.length,
      totalDefaults: defaults.length,
      totalBorrowed: totalBorrowed.toString(),
      uniqueBorrowers: uniqueBorrowers.size,
      loans: vaultLoans
    };
  }

  async clearOldLoans(daysToKeep = 90) {
    const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
    const originalCount = this.loans.length;

    this.loans = this.loans.filter(loan => loan.timestamp >= cutoffTime);

    if (this.loans.length < originalCount) {
      await this.save();
      console.log(`Cleared ${originalCount - this.loans.length} old loan events`);
    }
  }

  async removeDuplicates() {
    const originalCount = this.loans.length;
    const seenIds = new Set();
    const uniqueLoans = [];

    for (const loan of this.loans) {
      const id = loan.id || this.generateLoanId(loan);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        uniqueLoans.push({ ...loan, id });
      } else {
        console.log(`Removing duplicate loan event: ${id}`);
      }
    }

    this.loans = uniqueLoans;
    const removedCount = originalCount - this.loans.length;

    if (removedCount > 0) {
      await this.save();
      console.log(`Removed ${removedCount} duplicate loan events from storage`);
    }

    return removedCount;
  }
}
