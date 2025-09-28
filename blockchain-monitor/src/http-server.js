import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ReferralStore } from './referral-store.js';
import { VaultService } from './vaults.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class HTTPServer {
  constructor(port = 3004, referralStore = null, rpcUrl = null) {
    this.port = port;
    this.app = express();
    this.referralStore = referralStore || new ReferralStore();
    this.vaultService = rpcUrl ? new VaultService(rpcUrl) : null;
    this.tokens = [];
    
    // Middleware
    this.app.use(cors());
    this.app.use(express.json());
    
    // Setup routes
    this.setupRoutes();
  }

  async initialize() {
    // Only initialize if we created our own store
    if (!this.referralStore.isInitialized) {
      await this.referralStore.initialize();
      console.log('HTTP server referral store initialized');
    }
    
    // Load tokens from data/tokens.json
    try {
      const tokensPath = path.join(__dirname, '..', '..', 'data', 'tokens.json');
      const tokensData = await fs.readFile(tokensPath, 'utf-8');
      const parsed = JSON.parse(tokensData);
      this.tokens = parsed.tokens || [];
      console.log(`Loaded ${this.tokens.length} tokens from tokens.json`);
    } catch (error) {
      console.error('Error loading tokens.json:', error);
      this.tokens = [];
    }
  }

  setupRoutes() {
    // Health check
    this.app.get('/api/health', (req, res) => {
      res.json({ status: 'ok', timestamp: Date.now() });
    });

    // Register a referral code
    this.app.post('/api/referrals/register-code', async (req, res) => {
      try {
        const { code, address } = req.body;
        
        if (!code || !address) {
          return res.status(400).json({ 
            error: 'Missing required fields: code, address' 
          });
        }
        
        const success = await this.referralStore.registerCode(code, address);
        
        if (success) {
          res.json({ 
            success: true, 
            message: 'Referral code registered successfully' 
          });
        } else {
          res.status(400).json({ 
            error: 'Code already exists for a different address' 
          });
        }
      } catch (error) {
        console.error('Error registering code:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Register a new referral relationship
    this.app.post('/api/referrals/register', async (req, res) => {
      try {
        const { userAddress, referralCode, poolAddress } = req.body;
        
        if (!userAddress || !referralCode || !poolAddress) {
          return res.status(400).json({ 
            error: 'Missing required fields: userAddress, referralCode, poolAddress' 
          });
        }
        
        // Get referrer address from code
        const referrerAddress = this.referralStore.getReferrerByCode(referralCode);
        
        if (!referrerAddress) {
          return res.status(404).json({ 
            error: 'Invalid referral code' 
          });
        }
        
        // Check if user is trying to refer themselves
        if (userAddress.toLowerCase() === referrerAddress.toLowerCase()) {
          return res.status(400).json({ 
            error: 'Cannot refer yourself' 
          });
        }
        
        const result = await this.referralStore.registerReferral(
          userAddress, 
          referrerAddress, 
          referralCode, 
          poolAddress
        );
        
        if (result.success) {
          res.json(result);
        } else {
          res.status(400).json(result);
        }
      } catch (error) {
        console.error('Error registering referral:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Track a trade made by a referred user
    this.app.post('/api/referrals/track-trade', async (req, res) => {
      try {
        const { 
          userAddress, 
          referralCode, 
          poolAddress,
          tokenAddress,
          volumeETH, 
          volumeUSD, 
          transactionHash, 
          tokenSymbol, 
          type 
        } = req.body;
        
        if (!userAddress || !poolAddress || !transactionHash) {
          return res.status(400).json({ 
            error: 'Missing required fields' 
          });
        }
        
        // Get referrer from referral check
        const referralData = this.referralStore.checkReferral(userAddress, poolAddress);
        
        if (!referralData.isReferred) {
          return res.status(400).json({ 
            error: 'User is not referred for this pool' 
          });
        }
        
        const trade = await this.referralStore.trackTrade({
          userAddress,
          referralCode: referralData.referralCode,
          referrer: referralData.referrer,
          poolAddress,
          tokenAddress: tokenAddress || poolAddress,
          volumeETH,
          volumeUSD,
          transactionHash,
          tokenSymbol,
          type
        });
        
        res.json({ 
          success: true, 
          trade 
        });
      } catch (error) {
        console.error('Error tracking trade:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Get referral statistics for an address
    this.app.get('/api/referrals/stats/:address', (req, res) => {
      try {
        const { address } = req.params;
        const stats = this.referralStore.getReferralStats(address);
        res.json(stats);
      } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Check if a user was referred for a specific pool
    this.app.get('/api/referrals/check/:userAddress/:poolAddress', (req, res) => {
      try {
        const { userAddress, poolAddress } = req.params;
        const referralData = this.referralStore.checkReferral(userAddress, poolAddress);
        res.json(referralData);
      } catch (error) {
        console.error('Error checking referral:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Get referrals by code and optionally by pool
    this.app.get('/api/referrals/code/:code/:poolAddress?', (req, res) => {
      try {
        const { code, poolAddress } = req.params;
        const referrals = this.referralStore.getReferralsByCode(code, poolAddress);
        res.json(referrals);
      } catch (error) {
        console.error('Error getting referrals by code:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Get all referral codes (for admin/debugging)
    this.app.get('/api/referrals/codes', (req, res) => {
      try {
        res.json(this.referralStore.codes);
      } catch (error) {
        console.error('Error getting codes:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Get recent trades (for admin/debugging)
    this.app.get('/api/referrals/trades/recent', (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 100;
        const recentTrades = this.referralStore.trades
          .slice(-limit)
          .reverse();
        res.json(recentTrades);
      } catch (error) {
        console.error('Error getting recent trades:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Get vault information
    this.app.get('/vaults', async (req, res) => {
      try {
        if (!this.vaultService) {
          return res.status(503).json({ 
            error: 'Vault service not initialized' 
          });
        }

        const { address } = req.query;
        
        if (address) {
          // Get vaults for specific address
          const vaults = await this.vaultService.getVaultsByAddress(address);
          res.json(JSON.parse(JSON.stringify(vaults, (_, v) => 
            typeof v === 'bigint' ? v.toString() : v
          )));
        } else {
          // Get all vaults
          const vaults = await this.vaultService.getAllVaults();
          res.json(JSON.parse(JSON.stringify(vaults, (_, v) => 
            typeof v === 'bigint' ? v.toString() : v
          )));
        }
      } catch (error) {
        console.error('Error fetching vaults:', error);
        res.status(500).json({ 
          error: 'Internal server error', 
          details: error.message 
        });
      }
    });

    // Get tokens
    this.app.get('/api/tokens', (req, res) => {
      try {
        // Filter only deployed tokens by default unless explicitly requested
        const includeAll = req.query.includeAll === 'true';
        
        const tokens = includeAll ? this.tokens : this.tokens.filter(token => 
          token.status === 'deployed' || token.status === 'success'
        );
        
        res.json({ tokens });
      } catch (error) {
        console.error('Error fetching tokens:', error);
        res.status(500).json({ error: 'Failed to retrieve tokens' });
      }
    });
  }

  start() {
    this.server = this.app.listen(this.port, () => {
      console.log(`HTTP server listening on port ${this.port}`);
      console.log(`Referral API available at http://localhost:${this.port}/api/referrals`);
      console.log(`Tokens API available at http://localhost:${this.port}/api/tokens`);
      console.log(`Vault API available at http://localhost:${this.port}/vaults`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
    }
  }
}