import { ethers } from 'ethers';
import axios from 'axios';
import cache from './cache.js';

// Token info for price calculations
const TOKEN_INFO = {
  '0x46c7c9b2c22e95e9b304cfcec7cf912b16faaefc': {
    symbol: 'BUN',
    decimals: 18,
    poolAddress: '0x90666407c841fe58358F3ed04a245c5F5bd6fD0A'
  },
  '0xccef72e0954e686098dd0db616a16d22e83a6b2f': {
    symbol: 'AVO',
    decimals: 18,
    poolAddress: '0x8Eb5C457F7a29554536Dc964B3FaDA2961Dd8212'
  }
};

// WMON address on MoveVM
const WMON_ADDRESS = '0x0000000000000000000000000000000000000000';

export class ReferralTracker {
  constructor(provider, referralStore, httpApiUrl = 'http://localhost:3004') {
    this.provider = provider;
    this.referralStore = referralStore;
    this.httpApiUrl = httpApiUrl;
    this.processedTxHashes = new Set();
    
    // Cache MON price - in production this would come from an oracle
    this.monPriceUSD = 0.10; // Default MON price in USD
    this.lastPriceUpdate = 0;
  }

  async initialize() {
    // In production, you would fetch MON price from a DEX or price oracle
    // For now, we'll just use a fixed price
    console.log(`ReferralTracker initialized with MON price: $${this.monPriceUSD}`);
  }

  async trackSwapEvent(eventData) {
    try {
      // Skip if we've already processed this transaction
      if (this.processedTxHashes.has(eventData.transactionHash)) {
        return;
      }
      
      this.processedTxHashes.add(eventData.transactionHash);
      
      // Only process Swap events
      if (eventData.eventName !== 'Swap') {
        return;
      }
      
      // Get transaction details to find the trader - check cache first
      let tx = await cache.getTransaction(eventData.transactionHash);
      
      if (!tx) {
        // Cache miss - fetch from provider
        tx = await this.provider.getTransaction(eventData.transactionHash);
        // Cache the transaction for future use
        cache.setTransaction(eventData.transactionHash, tx);
      }
      
      const userAddress = tx.from;
      const poolAddress = eventData.poolAddress;
      
      // Check if user is referred for this pool
      const referralData = this.referralStore.checkReferral(userAddress, poolAddress);
      
      if (!referralData.isReferred) {
        // User is not referred, skip tracking
        return;
      }
      
      console.log(`Found referral trade: ${userAddress} on pool ${poolAddress}`);
      
      // Calculate trade volume
      const tradeVolume = await this.calculateTradeVolume(eventData);
      
      if (!tradeVolume) {
        console.error('Could not calculate trade volume for', eventData.transactionHash);
        return;
      }
      
      // Track the trade
      const trade = await this.referralStore.trackTrade({
        userAddress,
        referralCode: referralData.referralCode,
        referrer: referralData.referrer,
        poolAddress,
        tokenAddress: tradeVolume.tokenAddress,
        volumeETH: tradeVolume.volumeMON.toString(), // Keep field name for compatibility
        volumeUSD: tradeVolume.volumeUSD.toString(),
        transactionHash: eventData.transactionHash,
        tokenSymbol: tradeVolume.tokenSymbol,
        type: tradeVolume.type
      });
      
      console.log(`Tracked referral trade: ${trade.id} - ${userAddress} traded ${tradeVolume.volumeMON} MON worth $${tradeVolume.volumeUSD}`);
      
      // Optionally notify via HTTP API
      if (this.httpApiUrl) {
        try {
          await axios.post(`${this.httpApiUrl}/api/referrals/track-trade`, trade);
        } catch (error) {
          console.error('Error notifying HTTP API:', error.message);
        }
      }
      
    } catch (error) {
      console.error('Error tracking swap event:', error);
    }
  }

  async calculateTradeVolume(eventData) {
    try {
      const args = eventData.args;
      
      // amount0 and amount1 are the token amounts swapped
      const amount0 = BigInt(args.amount0);
      const amount1 = BigInt(args.amount1);
      
      // Determine which token is WMON and which is the other token
      let tokenInfo, volumeMON, type;
      
      // Find token info based on pool address
      const tokenEntry = Object.entries(TOKEN_INFO).find(([, info]) => 
        info.poolAddress.toLowerCase() === eventData.poolAddress.toLowerCase()
      );
      
      if (!tokenEntry) {
        console.warn(`Unknown pool: ${eventData.poolAddress}`);
        return null;
      }
      
      tokenInfo = tokenEntry[1];
      const tokenAddress = tokenEntry[0];
      
      // In Uniswap V3, negative amounts indicate tokens going out, positive coming in
      // amount0 is for token0, amount1 is for token1
      // We need to determine which token is WMON (token1 in most pools)
      
      if (amount0 < 0n && amount1 > 0n) {
        // Token0 out, Token1 (WMON) in - this is a SELL of Token0
        volumeMON = this.formatEther(amount1 > 0n ? amount1 : -amount1);
        type = 'sell';
      } else if (amount0 > 0n && amount1 < 0n) {
        // Token0 in, Token1 (WMON) out - this is a BUY of Token0
        volumeMON = this.formatEther(amount1 > 0n ? amount1 : -amount1);
        type = 'buy';
      } else {
        console.warn('Unexpected swap amounts:', { amount0: amount0.toString(), amount1: amount1.toString() });
        return null;
      }
      
      const volumeUSD = volumeMON * this.monPriceUSD;
      
      return {
        volumeMON,
        volumeUSD,
        tokenAddress,
        tokenSymbol: tokenInfo.symbol,
        type
      };
      
    } catch (error) {
      console.error('Error calculating trade volume:', error);
      return null;
    }
  }

  formatEther(value) {
    // Convert BigInt to ETH (18 decimals)
    const absValue = value > 0n ? value : -value;
    return Number(ethers.formatEther(absValue));
  }

  // Clean up old processed tx hashes to prevent memory leak
  cleanupProcessedTxHashes() {
    // Keep only last 10000 tx hashes
    if (this.processedTxHashes.size > 10000) {
      const txArray = Array.from(this.processedTxHashes);
      const toKeep = txArray.slice(-5000);
      this.processedTxHashes = new Set(toKeep);
    }
  }
}