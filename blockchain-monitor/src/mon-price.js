import { ethers } from 'ethers';
import { getCache } from './cache.js';

const cache = getCache();

// Uniswap V3 Pool ABI (only what we need)
const poolABI = [
  {
    "inputs": [],
    "name": "slot0",
    "outputs": [
      {"internalType": "uint160", "name": "sqrtPriceX96", "type": "uint160"},
      {"internalType": "int24", "name": "tick", "type": "int24"},
      {"internalType": "uint16", "name": "observationIndex", "type": "uint16"},
      {"internalType": "uint16", "name": "observationCardinality", "type": "uint16"},
      {"internalType": "uint16", "name": "observationCardinalityNext", "type": "uint16"},
      {"internalType": "uint8", "name": "feeProtocol", "type": "uint8"},
      {"internalType": "bool", "name": "unlocked", "type": "bool"}
    ],
    "stateMutability": "view",
    "type": "function"
  }
];

export class MonPriceService {
  constructor(provider) {
    this.provider = provider;
    // Uniswap V3 MON/USDT pool address
    this.poolAddress = '0xE4baba78F933D58d52b7D564212b2C4CF910A36a';
    this.poolContract = new ethers.Contract(this.poolAddress, poolABI, this.provider);
    this.previousPrice = null;
  }

  async getMonPrice() {
    try {
      // Check cache first
      const cachedPrice = await cache.getContractState(
        'MonPriceService',
        'monPrice',
        []
      );
      
      if (cachedPrice) {
        console.log(`Using cached MON price: $${cachedPrice.toFixed(4)}`);
        return cachedPrice;
      }

      // Fetch fresh price from pool
      const slot0 = await this.poolContract.slot0();
      const sqrtPriceX96 = slot0[0];
      
      // Convert sqrtPriceX96 to price
      // Price = (sqrtPriceX96 / 2^96)^2
      const sqrtPrice = parseFloat(sqrtPriceX96.toString()) / Math.pow(2, 96);
      const price = sqrtPrice * sqrtPrice;
      
      // MON has 18 decimals, USDT has 6 decimals
      // So we need to adjust by 10^12
      const monPriceInUSD = price * Math.pow(10, 12);
      
      // Cache the price for 30 seconds
      cache.setContractState(
        'MonPriceService',
        'monPrice',
        [],
        monPriceInUSD,
        30 // 30 seconds cache
      );
      
      console.log(`Fetched MON price from Uniswap V3: $${monPriceInUSD.toFixed(4)}`);
      
      return monPriceInUSD;
    } catch (error) {
      console.error('Error fetching MON price:', error.message);
      // Return default price if fetch fails
      return 0.10;
    }
  }

  async getMonPriceWithChange() {
    const currentPrice = await this.getMonPrice();
    
    let priceChange = 0;
    if (this.previousPrice !== null && this.previousPrice !== 0) {
      priceChange = ((currentPrice - this.previousPrice) / this.previousPrice) * 100;
    }
    
    this.previousPrice = currentPrice;
    
    return {
      price: currentPrice,
      change: priceChange
    };
  }

  // Helper method to convert USD value to MON tokens
  usdToMon(usdAmount) {
    const monPrice = this.previousPrice || 0.10; // Use cached price or default
    return usdAmount / monPrice;
  }

  // Helper method to convert MON tokens to USD value
  monToUsd(monAmount) {
    const monPrice = this.previousPrice || 0.10; // Use cached price or default
    return monAmount * monPrice;
  }
}

// Singleton instance
let monPriceService = null;

export function getMonPriceService(provider) {
  if (!monPriceService) {
    monPriceService = new MonPriceService(provider);
  }
  return monPriceService;
}