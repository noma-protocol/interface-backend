import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class ReferralStore {
  constructor() {
    this.referrals = { referred_users: {}, referrers: {} };
    this.trades = [];
    this.codes = {};
    
    // File paths
    this.referralsPath = path.join(__dirname, '../../data/referrals.json');
    this.tradesPath = path.join(__dirname, '../../data/referral_trades.json');
    this.codesPath = path.join(__dirname, '../../data/referral_codes.json');
  }

  async initialize() {
    try {
      // Ensure data directory exists
      await fs.mkdir(path.dirname(this.referralsPath), { recursive: true });
      
      // Load existing data
      await this.loadReferrals();
      await this.loadTrades();
      await this.loadCodes();
      
      console.log('ReferralStore initialized');
      console.log(`Loaded ${Object.keys(this.referrals.referred_users).length} referred users`);
      console.log(`Loaded ${Object.keys(this.referrals.referrers).length} referrers`);
      console.log(`Loaded ${this.trades.length} trades`);
      console.log(`Loaded ${Object.keys(this.codes).length} referral codes`);
    } catch (error) {
      console.error('Failed to initialize ReferralStore:', error);
      throw error;
    }
  }

  async loadReferrals() {
    try {
      const data = await fs.readFile(this.referralsPath, 'utf-8');
      const parsed = JSON.parse(data);
      
      // Validate the structure
      if (!parsed || typeof parsed !== 'object') {
        console.warn('Invalid referrals data, initializing with defaults');
        this.referrals = { referred_users: {}, referrers: {} };
        await this.saveReferrals();
      } else {
        // Ensure required properties exist
        this.referrals = {
          referred_users: parsed.referred_users || {},
          referrers: parsed.referrers || {}
        };
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('No referrals file found, creating new one');
        this.referrals = { referred_users: {}, referrers: {} };
        await this.saveReferrals();
      } else if (error instanceof SyntaxError) {
        console.error('Invalid JSON in referrals file, resetting to defaults');
        this.referrals = { referred_users: {}, referrers: {} };
        await this.saveReferrals();
      } else {
        throw error;
      }
    }
  }

  async loadTrades() {
    try {
      const data = await fs.readFile(this.tradesPath, 'utf-8');
      this.trades = JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.trades = [];
        await this.saveTrades();
      } else {
        throw error;
      }
    }
  }

  async loadCodes() {
    try {
      const data = await fs.readFile(this.codesPath, 'utf-8');
      const parsed = JSON.parse(data);
      
      // Validate the structure
      if (!parsed || typeof parsed !== 'object') {
        console.warn('Invalid codes data, initializing with defaults');
        this.codes = {};
        await this.saveCodes();
      } else {
        this.codes = parsed;
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('No codes file found, creating new one');
        this.codes = {};
        await this.saveCodes();
      } else if (error instanceof SyntaxError) {
        console.error('Invalid JSON in codes file, resetting to defaults');
        this.codes = {};
        await this.saveCodes();
      } else {
        throw error;
      }
    }
  }

  async saveReferrals() {
    await fs.writeFile(this.referralsPath, JSON.stringify(this.referrals, null, 2));
  }

  async saveTrades() {
    await fs.writeFile(this.tradesPath, JSON.stringify(this.trades, null, 2));
  }

  async saveCodes() {
    await fs.writeFile(this.codesPath, JSON.stringify(this.codes, null, 2));
  }

  normalizeCode(code) {
    if (!code) return null;
    
    // Normalize code format - always store without 0x prefix for short codes
    if (code.length <= 10) { // Short code (8 chars + optional 0x)
      return code.startsWith('0x') ? code.slice(2) : code;
    } else { // Legacy long code - keep 0x prefix
      return code.startsWith('0x') ? code : `0x${code}`;
    }
  }

  async registerCode(code, address) {
    const normalizedAddress = address.toLowerCase();
    const normalizedCode = this.normalizeCode(code);
    
    if (!normalizedCode) return false;
    
    // Check if code already exists
    if (this.codes[normalizedCode] && this.codes[normalizedCode] !== normalizedAddress) {
      return false;
    }
    
    this.codes[normalizedCode] = normalizedAddress;
    await this.saveCodes();
    return true;
  }

  async registerReferral(referredAddress, referrerAddress, referralCode, poolAddress) {
    const normalizedReferredAddress = referredAddress.toLowerCase();
    const normalizedReferrerAddress = referrerAddress.toLowerCase();
    const normalizedPoolAddress = poolAddress.toLowerCase();
    const normalizedCode = this.normalizeCode(referralCode);
    
    // Use pool-specific keys
    const referralKey = `${normalizedReferredAddress}:${normalizedPoolAddress}`;
    const referrerKey = `${normalizedReferrerAddress}:${normalizedPoolAddress}`;
    
    // Check if already referred for this pool
    if (this.referrals.referred_users[referralKey]) {
      return {
        success: false,
        message: 'User already referred for this pool'
      };
    }
    
    // Add referred user
    this.referrals.referred_users[referralKey] = {
      referrer: normalizedReferrerAddress,
      referralCode: normalizedCode,
      poolAddress: normalizedPoolAddress,
      timestamp: Date.now()
    };
    
    // Add to referrer's list
    if (!this.referrals.referrers[referrerKey]) {
      this.referrals.referrers[referrerKey] = {
        code: normalizedCode,
        poolAddress: normalizedPoolAddress,
        referred: []
      };
    }
    
    if (!this.referrals.referrers[referrerKey].referred.includes(normalizedReferredAddress)) {
      this.referrals.referrers[referrerKey].referred.push(normalizedReferredAddress);
    }
    
    // Register the code if not already registered
    await this.registerCode(normalizedCode, normalizedReferrerAddress);
    
    await this.saveReferrals();
    
    return {
      success: true,
      message: 'Referral registered successfully'
    };
  }

  async trackTrade(tradeData) {
    const trade = {
      id: uuidv4(),
      timestamp: Date.now(),
      userAddress: tradeData.userAddress.toLowerCase(),
      referralCode: this.normalizeCode(tradeData.referralCode),
      referrer: tradeData.referrer ? tradeData.referrer.toLowerCase() : null,
      poolAddress: tradeData.poolAddress.toLowerCase(),
      tokenAddress: tradeData.tokenAddress ? tradeData.tokenAddress.toLowerCase() : tradeData.poolAddress.toLowerCase(),
      volumeETH: tradeData.volumeETH,
      volumeUSD: tradeData.volumeUSD,
      transactionHash: tradeData.transactionHash,
      tokenSymbol: tradeData.tokenSymbol,
      type: tradeData.type // 'buy' or 'sell'
    };
    
    this.trades.push(trade);
    
    // Keep only last 10000 trades
    if (this.trades.length > 10000) {
      this.trades = this.trades.slice(-10000);
    }
    
    await this.saveTrades();
    return trade;
  }

  checkReferral(userAddress, poolAddress) {
    const normalizedUserAddress = userAddress.toLowerCase();
    const normalizedPoolAddress = poolAddress.toLowerCase();
    const referralKey = `${normalizedUserAddress}:${normalizedPoolAddress}`;
    
    const referralData = this.referrals.referred_users[referralKey];
    
    if (referralData) {
      return {
        isReferred: true,
        referrer: referralData.referrer,
        referralCode: referralData.referralCode,
        timestamp: referralData.timestamp,
        poolAddress: referralData.poolAddress
      };
    }
    
    return {
      isReferred: false
    };
  }

  getReferrerByCode(code) {
    const normalizedCode = this.normalizeCode(code);
    return this.codes[normalizedCode] || null;
  }

  getReferralStats(address) {
    const normalizedAddress = address.toLowerCase();
    const stats = {
      address: normalizedAddress,
      totalReferred: 0,
      referralsByPool: {},
      totalVolume: {
        ETH: 0,
        USD: 0
      },
      volumeByPool: {},
      recentTrades: []
    };
    
    // Count referrals by pool
    Object.entries(this.referrals.referrers).forEach(([key, data]) => {
      const [referrerAddress, poolAddress] = key.split(':');
      if (referrerAddress === normalizedAddress) {
        stats.totalReferred += data.referred.length;
        stats.referralsByPool[poolAddress] = data.referred.length;
      }
    });
    
    // Calculate volume from trades
    const referredUsers = new Set();
    Object.entries(this.referrals.referred_users).forEach(([key, data]) => {
      if (data.referrer === normalizedAddress) {
        const [userAddress] = key.split(':');
        referredUsers.add(userAddress);
      }
    });
    
    // Filter trades by referred users
    const referredTrades = this.trades.filter(trade => 
      referredUsers.has(trade.userAddress)
    );
    
    referredTrades.forEach(trade => {
      const volumeETH = parseFloat(trade.volumeETH) || 0;
      const volumeUSD = parseFloat(trade.volumeUSD) || 0;
      
      stats.totalVolume.ETH += volumeETH;
      stats.totalVolume.USD += volumeUSD;
      
      // Volume by pool
      const pool = trade.poolAddress;
      if (!stats.volumeByPool[pool]) {
        stats.volumeByPool[pool] = { ETH: 0, USD: 0 };
      }
      stats.volumeByPool[pool].ETH += volumeETH;
      stats.volumeByPool[pool].USD += volumeUSD;
    });
    
    // Get recent trades (last 100)
    stats.recentTrades = referredTrades
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 100);
    
    return stats;
  }

  getReferralsByCode(code, poolAddress) {
    const normalizedCode = this.normalizeCode(code);
    const normalizedPoolAddress = poolAddress ? poolAddress.toLowerCase() : null;
    
    const referrerAddress = this.codes[normalizedCode];
    if (!referrerAddress) {
      return {
        code: normalizedCode,
        referrer: null,
        referrals: []
      };
    }
    
    const referrals = [];
    
    Object.entries(this.referrals.referrers).forEach(([key, data]) => {
      const [refAddress, refPoolAddress] = key.split(':');
      
      if (refAddress === referrerAddress && data.code === normalizedCode) {
        if (!normalizedPoolAddress || refPoolAddress === normalizedPoolAddress) {
          data.referred.forEach(userAddress => {
            referrals.push({
              userAddress,
              poolAddress: refPoolAddress,
              referralKey: `${userAddress}:${refPoolAddress}`
            });
          });
        }
      }
    });
    
    return {
      code: normalizedCode,
      referrer: referrerAddress,
      referrals
    };
  }
}