import INomaFactory from "../../assets/NomaFactory.json" assert { type: "json" };
import INomaVault from "../../assets/BaseVault.json" assert { type: "json" };
import IUniswapV3Factory from "../../assets/IUniswapV3Factory.json" assert { type: "json"};
import deployment from "../../assets/deployment.json" assert { type: "json" };
import { ethers } from "ethers";
import cache from './cache.js';
import config from "../config.js";
const { feeTiers, protocolAddresses } = config;

const ZeroAddress = ethers.ZeroAddress;
const CHAIN_ID = "10143";
const NomaFactoryAddress = deployment[CHAIN_ID].Factory;

export class VaultService {
  constructor(rpcUrl) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.nomaFactoryContract = new ethers.Contract(
      NomaFactoryAddress,
      INomaFactory.abi,
      this.provider
    );
  }

  async getAllVaults() {
    try {
      // Check cache for deployers first
      let deployers = await cache.getContractState(NomaFactoryAddress, 'getDeployers');
      
      if (!deployers) {
        // Cache miss - fetch from contract
        deployers = await this.nomaFactoryContract.getDeployers();
        // Cache for 5 minutes
        cache.setContractState(NomaFactoryAddress, 'getDeployers', [], deployers, 300);
      }
      
      console.log(`Found ${deployers.length} deployers`);

      const allVaultAddresses = [];

      // Fetch vaults for each deployer with caching
      for (const deployer of deployers) {
        try {
          let vaults = await cache.getContractState(NomaFactoryAddress, 'getVaults', [deployer]);
          
          if (!vaults) {
            // Add delay before RPC call
            await new Promise(resolve => setTimeout(resolve, 100));
            // Cache miss - fetch from contract
            vaults = await this.nomaFactoryContract.getVaults(deployer);
            // Cache for 5 minutes
            cache.setContractState(NomaFactoryAddress, 'getVaults', [deployer], vaults, 300);
          }
          
          allVaultAddresses.push(...vaults);
        } catch (error) {
          console.error(`Error fetching vaults for deployer ${deployer}:`, error);
        }
      }

      console.log(`Found ${allVaultAddresses.length} total vaults`);

      // Fetch vault info for each vault
      const vaultInfos = [];
      for (const vaultAddress of allVaultAddresses) {
        try {
          // Add delay between vault info fetches
          await new Promise(resolve => setTimeout(resolve, 200));
          const vaultInfo = await this.getVaultInfo(vaultAddress);
          if (vaultInfo) {
            vaultInfos.push(vaultInfo);
          }
        } catch (error) {
          console.error(`Error fetching info for vault ${vaultAddress}:`, error);
        }
      }

      return vaultInfos;
    } catch (error) {
      console.error('Error in getAllVaults:', error);
      throw error;
    }
  }

  async getVaultDescription(vaultAddress) {
    try {
      // Check cache first
      let description = await cache.getContractState(NomaFactoryAddress, 'getVaultDescription', [vaultAddress]);
      
      if (!description) {
        // Add delay before RPC call
        await new Promise(resolve => setTimeout(resolve, 100));
        // Cache miss - fetch from contract
        description = await this.nomaFactoryContract.getVaultDescription(vaultAddress);
        // Cache for 5 minutes  
        cache.setContractState(NomaFactoryAddress, 'getVaultDescription', [vaultAddress], description, 300);
      }
      
      // Check if description is undefined or null
      if (!description) {
        console.warn(`getVaultDescription returned null/undefined for ${vaultAddress}`);
        return null;
      }
      
      // Handle both struct and array return formats first to get token addresses
      let data;
      if (Array.isArray(description)) {
        // Array format: [tokenName, tokenSymbol, tokenDecimals, token0, token1, deployer, vault, presaleContract, stakingContract]
        data = {
          tokenName: description[0],
          tokenSymbol: description[1],
          tokenDecimals: description[2],
          token0: description[3],
          token1: description[4],
          deployer: description[5],
          vault: description[6],
          presaleContract: description[7],
          stakingContract: description[8]
        };
      } else {
        // Object format
        data = description;
      }
      
      // First check if we already have the pool address cached
      let cachedPoolAddress = await cache.getContractState(
        'PoolDiscovery',
        'findPool',
        [data.token0, data.token1]
      );
      
      let poolAddress = ZeroAddress;
      
      if (cachedPoolAddress && cachedPoolAddress !== ZeroAddress) {
        console.log(`Using cached pool for ${data.tokenSymbol}: ${cachedPoolAddress}`);
        poolAddress = cachedPoolAddress;
      } else {
        console.log(`Searching for pool for ${data.tokenSymbol} - token0: ${data.token0}, token1: ${data.token1}`);
      }
      
      try {
        if (poolAddress === ZeroAddress) {
        // First try Uniswap V3 with all fee tiers
        const uniswapFactory = new ethers.Contract(
          protocolAddresses.uniswapV3Factory,
          IUniswapV3Factory.abi,
          this.provider
        );
        
        // Try each fee tier from config
        for (const feeTier of feeTiers) {
          // Try both token orders (token0/token1 and token1/token0)
          for (const [tokenA, tokenB] of [[data.token0, data.token1], [data.token1, data.token0]]) {
            // Check cache first
            let pool = await cache.getContractState(
              protocolAddresses.uniswapV3Factory, 
              'getPool', 
              [tokenA, tokenB, feeTier]
            );
            
            if (!pool) {
              // Add delay before RPC call to respect rate limits
              await new Promise(resolve => setTimeout(resolve, 100));
              pool = await uniswapFactory.getPool(tokenA, tokenB, feeTier);
              cache.setContractState(
                protocolAddresses.uniswapV3Factory,
                'getPool',
                [tokenA, tokenB, feeTier],
                pool,
                0 // Permanent - pool addresses never change
              );
            }
            
            if (pool && pool !== ZeroAddress) {
              poolAddress = pool;
              break; // Found a pool, stop searching
            }
          }
          
          if (poolAddress !== ZeroAddress) {
            break; // Found a pool, stop searching fee tiers
          }
        }
        
        // If no pool found with Uniswap, try PancakeSwap with all fee tiers
        if (poolAddress === ZeroAddress) {
          const pancakeFactory = new ethers.Contract(
            protocolAddresses.pancakeV3Factory,
            IUniswapV3Factory.abi,
            this.provider
          );
          
          // Try each fee tier for PancakeSwap
          for (const feeTier of feeTiers) {
            // Try both token orders (token0/token1 and token1/token0)
            for (const [tokenA, tokenB] of [[data.token0, data.token1], [data.token1, data.token0]]) {
              let pool = await cache.getContractState(
                protocolAddresses.pancakeV3Factory,
                'getPool',
                [tokenA, tokenB, feeTier]
              );
              
              if (!pool) {
                // Add delay before RPC call to respect rate limits
                await new Promise(resolve => setTimeout(resolve, 100));
                pool = await pancakeFactory.getPool(tokenA, tokenB, feeTier);
                cache.setContractState(
                  protocolAddresses.pancakeV3Factory,
                  'getPool',
                  [tokenA, tokenB, feeTier],
                  pool,
                  0 // Permanent - pool addresses never change
                );
              }
              
              if (pool && pool !== ZeroAddress) {
                poolAddress = pool;
                console.log(`Found PancakeSwap pool for ${data.tokenSymbol} at ${pool} with fee tier ${feeTier}`);
                break; // Found a pool, stop searching
              }
            }
            
            if (poolAddress !== ZeroAddress) {
              break; // Found a pool, stop searching fee tiers
            }
          }
        }
        } // Close the if (poolAddress === ZeroAddress) block
        
        // Cache the found pool address permanently
        if (poolAddress !== ZeroAddress) {
          cache.setContractState(
            'PoolDiscovery',
            'findPool',
            [data.token0, data.token1],
            poolAddress,
            0 // Permanent cache - pools are immutable
          );
        }
      } catch (error) {
        console.error(`Error fetching pool address for vault ${vaultAddress}:`, error.message);
      }
      
      // Convert the struct to a plain object with safe access
      return {
        tokenName: data.tokenName || 'Unknown',
        tokenSymbol: data.tokenSymbol || 'UNKNOWN',
        tokenDecimals: data.tokenDecimals || 18,
        token0: data.token0 || ethers.ZeroAddress,
        token1: data.token1 || ethers.ZeroAddress,
        deployer: data.deployer || ethers.ZeroAddress,
        vault: data.vault || vaultAddress,
        presaleContract: data.presaleContract || ethers.ZeroAddress,
        stakingContract: data.stakingContract || ethers.ZeroAddress,
        poolAddress: poolAddress
      };
    } catch (error) {
      // Handle specific error types
      if (error.code === 'CALL_EXCEPTION') {
        console.warn(`Vault ${vaultAddress} might not exist or be accessible on current network`);
      } else {
        console.error(`Error fetching vault description for ${vaultAddress}:`, error.message);
      }
      return null;
    }
  }

  async getVaultInfo(vaultAddress) {
    try {
      // Check if we have the complete vault info cached
      const cachedVaultInfo = await cache.getContractState(
        'VaultManager',
        'getCompleteVaultInfo',
        [vaultAddress]
      );
      
      if (cachedVaultInfo) {
        return cachedVaultInfo;
      }
      
      // Fetch both vault info and description in parallel
      const [vaultInfoData, vaultDescription] = await Promise.all([
        this.getVaultInfoOnly(vaultAddress),
        this.getVaultDescription(vaultAddress)
      ]);

      // If either call failed, return null
      if (!vaultInfoData || !vaultDescription) {
        console.error(`Failed to fetch complete vault data for ${vaultAddress}`);
        return null;
      }

      // Blend both objects into a comprehensive vault information object
      const completeVaultInfo = {
        // Vault identification
        address: vaultAddress,
        deployer: vaultDescription.deployer,
        
        // Token information from description
        tokenName: vaultDescription.tokenName,
        tokenSymbol: vaultDescription.tokenSymbol,
        tokenDecimals: vaultDescription.tokenDecimals,
        
        // Token addresses (from both, should match)
        token0: vaultDescription.token0,
        token1: vaultDescription.token1,
        
        // Associated contracts
        presaleContract: vaultDescription.presaleContract,
        stakingContract: vaultDescription.stakingContract,
        poolAddress: vaultDescription.poolAddress,
        
        // Vault metrics from getVaultInfo
        liquidityRatio: vaultInfoData.liquidityRatio,
        circulatingSupply: vaultInfoData.circulatingSupply,
        spotPriceX96: vaultInfoData.spotPriceX96,
        anchorCapacity: vaultInfoData.anchorCapacity,
        floorCapacity: vaultInfoData.floorCapacity,
        newFloor: vaultInfoData.newFloor,
        totalInterest: vaultInfoData.totalInterest
      };
      
      // Cache the complete vault info for 5 minutes
      cache.setContractState(
        'VaultManager',
        'getCompleteVaultInfo',
        [vaultAddress],
        completeVaultInfo,
        300 // 5 minutes
      );
      
      return completeVaultInfo;
    } catch (error) {
      console.error(`Error fetching comprehensive vault info for ${vaultAddress}:`, error);
      return null;
    }
  }

  async getVaultInfoOnly(vaultAddress) {
    try {
      // Check cache first
      let vaultInfo = await cache.getContractState(vaultAddress, 'getVaultInfo');
      
      if (!vaultInfo) {
        // Cache miss - create contract and fetch
        const vaultContract = new ethers.Contract(
          vaultAddress,
          INomaVault.abi,
          this.provider
        );

        // Fetch VaultInfo struct from getVaultInfo() method
        vaultInfo = await vaultContract.getVaultInfo();
        
        // Cache for 1 minute (vault info changes more frequently)
        cache.setContractState(vaultAddress, 'getVaultInfo', [], vaultInfo, 60);
      }
      
      // Check if vaultInfo is undefined or null
      if (!vaultInfo) {
        console.warn(`getVaultInfo returned null/undefined for ${vaultAddress}`);
        return null;
      }
      
      // ethers v6 returns Result objects for structs
      // Try to access totalInterest if it exists at index 8
      let totalInterest = BigInt(0);
      try {
        if (vaultInfo[8] !== undefined) {
          totalInterest = vaultInfo[8];
        }
      } catch (e) {
        // If accessing index 8 throws, it doesn't exist
        // This is expected for vaults with 8 fields total
      }
      
      // Build the data object with what we can access
      const data = {
        liquidityRatio: vaultInfo[0],
        circulatingSupply: vaultInfo[1],
        spotPriceX96: vaultInfo[2],
        anchorCapacity: vaultInfo[3],
        floorCapacity: vaultInfo[4],
        token0: vaultInfo[5],
        token1: vaultInfo[6],
        newFloor: vaultInfo[7],
        totalInterest: totalInterest
      };
      
      // Safely convert BigNumbers to strings
      return {
        liquidityRatio: data.liquidityRatio ? data.liquidityRatio.toString() : '0',
        circulatingSupply: data.circulatingSupply ? data.circulatingSupply.toString() : '0',
        spotPriceX96: data.spotPriceX96 ? data.spotPriceX96.toString() : '0',
        anchorCapacity: data.anchorCapacity ? data.anchorCapacity.toString() : '0',
        floorCapacity: data.floorCapacity ? data.floorCapacity.toString() : '0',
        token0: data.token0 || ethers.ZeroAddress,
        token1: data.token1 || ethers.ZeroAddress,
        newFloor: data.newFloor ? data.newFloor.toString() : '0',
        totalInterest: data.totalInterest ? data.totalInterest.toString() : '0'
      };
    } catch (error) {
      console.error(`Error fetching vault info for ${vaultAddress}:`, error.message);
      return null;
    }
  }

  async getVaultsByAddress(searchAddress) {
    try {
      const allVaults = await this.getAllVaults();
      
      // Filter vaults by address, token0, or token1
      return allVaults.filter(vault => 
        vault.address?.toLowerCase() === searchAddress.toLowerCase() ||
        vault.token0?.toLowerCase() === searchAddress.toLowerCase() ||
        vault.token1?.toLowerCase() === searchAddress.toLowerCase()
      );
    } catch (error) {
      console.error('Error in getVaultsByAddress:', error);
      throw error;
    }
  }
}