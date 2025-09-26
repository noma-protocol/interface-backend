import { ethers } from 'ethers';
import axios from 'axios';
import cache from './cache.js';
import { getMonPriceService } from './mon-price.js';

// ExchangeHelper contract address and ABI
const EXCHANGE_HELPER_ADDRESS = process.env.EXCHANGE_HELPER_ADDRESS || '0xD82D7Bdd614bA07527351DE627C558Adbd0f7caE';

// ExchangeHelper ABI for trade events
const EXCHANGE_HELPER_ABI = [
  'event BoughtTokensETH(address who, uint256 amount)',
  'event BoughtTokensWETH(address who, uint256 amount)',
  'event SoldTokensETH(address who, uint256 amount)',
  'event SoldTokensWETH(address who, uint256 amount)'
];

// Token info for price calculations and referral tracking
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
    
    // Initialize MON price service
    this.monPriceService = getMonPriceService(provider);
    this.monPriceUSD = 0.10; // Default MON price in USD (fallback)
    this.lastPriceUpdate = 0;
    
    // Create ExchangeHelper contract instance
    this.exchangeHelper = null;
  }

  async initialize() {
    // Initialize ExchangeHelper contract
    if (EXCHANGE_HELPER_ADDRESS && EXCHANGE_HELPER_ADDRESS !== ethers.ZeroAddress) {
      this.exchangeHelper = new ethers.Contract(
        EXCHANGE_HELPER_ADDRESS,
        EXCHANGE_HELPER_ABI,
        this.provider
      );
      console.log(`ReferralTracker initialized with ExchangeHelper at ${EXCHANGE_HELPER_ADDRESS}`);
    } else {
      console.warn('ReferralTracker: No ExchangeHelper address configured');
    }
    
    // Fetch initial MON price
    try {
      this.monPriceUSD = await this.monPriceService.getMonPrice();
    } catch (error) {
      console.error('Failed to fetch MON price, using default:', error.message);
    }
    
    console.log(`ReferralTracker initialized with MON price: $${this.monPriceUSD.toFixed(4)}`);
  }

  // Main method to track ExchangeHelper events
  async trackExchangeHelperEvent(eventData) {
    try {
      // Skip if we've already processed this transaction
      if (this.processedTxHashes.has(eventData.transactionHash)) {
        return;
      }
      
      this.processedTxHashes.add(eventData.transactionHash);
      
      // Only process ExchangeHelper trade events
      const validEvents = ['BoughtTokensETH', 'BoughtTokensWETH', 'SoldTokensETH', 'SoldTokensWETH'];
      if (!validEvents.includes(eventData.eventName)) {
        return;
      }
      
      // Extract trader address from event args
      const traderAddress = eventData.args.who || eventData.args[0];
      const amount = eventData.args.amount || eventData.args[1];
      
      // Determine which pool this trade was on by analyzing the transaction
      const poolAddress = await this.determinePoolFromTransaction(eventData.transactionHash);
      
      if (!poolAddress) {
        console.warn(`Could not determine pool for ExchangeHelper trade: ${eventData.transactionHash}`);
        return;
      }
      
      // Check if user is referred for this pool
      const referralData = this.referralStore.checkReferral(traderAddress, poolAddress);
      
      if (!referralData.isReferred) {
        // User is not referred, skip tracking
        return;
      }
      
      console.log(`Found referral trade: ${traderAddress} on pool ${poolAddress} via ExchangeHelper`);
      
      // Calculate trade volume based on the event type
      const tradeVolume = await this.calculateTradeVolumeFromExchangeHelper(
        eventData.eventName,
        amount,
        poolAddress
      );
      
      if (!tradeVolume) {
        console.error('Could not calculate trade volume for', eventData.transactionHash);
        return;
      }
      
      // Track the trade
      const trade = await this.referralStore.trackTrade({
        userAddress: traderAddress,
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
      
      console.log(`Tracked referral trade: ${trade.id} - ${traderAddress} traded ${tradeVolume.volumeMON} MON worth $${tradeVolume.volumeUSD}`);
      
      // Optionally notify via HTTP API
      if (this.httpApiUrl) {
        try {
          await axios.post(`${this.httpApiUrl}/api/referrals/track-trade`, trade);
        } catch (error) {
          console.error('Error notifying HTTP API:', error.message);
        }
      }
      
    } catch (error) {
      console.error('Error tracking ExchangeHelper event:', error);
    }
  }

  // Legacy method for backward compatibility - redirects to ExchangeHelper tracking
  async trackSwapEvent(eventData) {
    // If it's an actual Swap event from a pool, we need to check if there's a corresponding
    // ExchangeHelper event in the same transaction
    console.log('Legacy trackSwapEvent called - checking for ExchangeHelper events in same tx');
    
    // For now, we'll just log a warning since pool swaps should be tracked via ExchangeHelper
    console.warn(`Pool Swap event detected but should be using ExchangeHelper events: ${eventData.transactionHash}`);
  }

  async determinePoolFromTransaction(txHash) {
    try {
      // Get transaction receipt to analyze the logs
      let receipt = await cache.getTransaction(txHash + '_receipt');
      
      if (!receipt) {
        receipt = await this.provider.getTransactionReceipt(txHash);
        cache.setTransaction(txHash + '_receipt', receipt);
      }
      
      // Look for Swap events in the logs to determine which pool was used
      for (const log of receipt.logs) {
        // Check if this is a Swap event (topic0 matches Swap event signature)
        const swapEventSignature = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
        
        if (log.topics[0] === swapEventSignature) {
          // This is a Swap event, the address is the pool
          const poolAddress = log.address;
          
          // Verify this pool is one we track
          const tokenEntry = Object.entries(TOKEN_INFO).find(([, info]) => 
            info.poolAddress.toLowerCase() === poolAddress.toLowerCase()
          );
          
          if (tokenEntry) {
            return poolAddress;
          }
        }
      }
      
      return null;
    } catch (error) {
      console.error('Error determining pool from transaction:', error);
      return null;
    }
  }

  async calculateTradeVolumeFromExchangeHelper(eventName, amount, poolAddress) {
    try {
      // Find token info based on pool address
      const tokenEntry = Object.entries(TOKEN_INFO).find(([, info]) => 
        info.poolAddress.toLowerCase() === poolAddress.toLowerCase()
      );
      
      if (!tokenEntry) {
        console.warn(`Unknown pool in ExchangeHelper trade: ${poolAddress}`);
        return null;
      }
      
      const [tokenAddress, tokenInfo] = tokenEntry;
      
      // Determine trade type based on event name
      let type;
      if (eventName.startsWith('Bought')) {
        type = 'buy';
      } else if (eventName.startsWith('Sold')) {
        type = 'sell';
      } else {
        console.warn(`Unknown ExchangeHelper event type: ${eventName}`);
        return null;
      }
      
      // Amount is already in MON/WMON units
      const volumeMON = this.formatEther(amount);
      // Update MON price if needed (every 30 seconds)
      if (Date.now() - this.lastPriceUpdate > 30000) {
        try {
          this.monPriceUSD = await this.monPriceService.getMonPrice();
          this.lastPriceUpdate = Date.now();
        } catch (error) {
          console.error('Failed to update MON price:', error.message);
        }
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
      console.error('Error calculating trade volume from ExchangeHelper:', error);
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

  // Get the ExchangeHelper contract address for external use
  getExchangeHelperAddress() {
    return EXCHANGE_HELPER_ADDRESS;
  }

  // Check if ExchangeHelper is configured
  hasExchangeHelper() {
    return this.exchangeHelper !== null;
  }
}