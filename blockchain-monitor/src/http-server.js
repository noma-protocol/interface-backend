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
    
    // Load tokens from blockchain-monitor/data/tokens.json
    try {
      const tokensPath = path.join(__dirname, '..', 'data', 'tokens.json');
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
      const startTime = Date.now();

      // Add timeout promise
      const timeout = 30000; // 30 seconds
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timeout')), timeout)
      );

      try {
        if (!this.vaultService) {
          return res.status(503).json({
            error: 'Vault service not initialized'
          });
        }

        const { address } = req.query;

        let result;
        if (address) {
          // Get vaults for specific address with timeout
          result = await Promise.race([
            this.vaultService.getVaultsByAddress(address),
            timeoutPromise
          ]);
        } else {
          // Get all vaults with timeout
          result = await Promise.race([
            this.vaultService.getAllVaults(),
            timeoutPromise
          ]);
        }

        const duration = Date.now() - startTime;
        console.log(`[Vaults] Request completed in ${duration}ms, returned ${result.length} vaults`);

        res.json(JSON.parse(JSON.stringify(result, (_, v) =>
          typeof v === 'bigint' ? v.toString() : v
        )));
      } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`[Vaults] Error after ${duration}ms:`, error.message);

        if (error.message === 'Request timeout') {
          res.status(504).json({
            error: 'Request timeout',
            details: 'The vault service is processing a large request. Please try again in a moment.',
            duration: duration
          });
        } else {
          res.status(500).json({
            error: 'Internal server error',
            details: error.message
          });
        }
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

    // Get tokens by deployer address
    this.app.get('/api/tokens/deployer/:address', (req, res) => {
      try {
        const { address } = req.params;
        const tokens = this.tokens.filter(
          token => token.deployerAddress?.toLowerCase() === address.toLowerCase()
        );
        res.json({ tokens });
      } catch (error) {
        console.error('Error fetching tokens by deployer:', error);
        res.status(500).json({ error: 'Failed to retrieve tokens' });
      }
    });

    // Save new token
    this.app.post('/api/tokens', async (req, res) => {
      try {
        const tokenData = req.body;

        // Validate required fields
        const requiredFields = ['tokenName', 'tokenSymbol', 'tokenSupply', 'price', 'floorPrice'];
        const missingFields = requiredFields.filter(field => !tokenData[field]);

        if (missingFields.length > 0) {
          return res.status(400).json({
            error: 'Missing required fields',
            missingFields
          });
        }

        // Add metadata
        const newToken = {
          ...tokenData,
          id: this.generateTokenId(),
          timestamp: new Date().toISOString(),
          status: 'pending'
        };

        this.tokens.push(newToken);
        await this.saveTokens();

        res.status(201).json({
          message: 'Token saved successfully',
          token: newToken
        });
      } catch (error) {
        console.error('Error saving token:', error);
        res.status(500).json({ error: 'Failed to save token' });
      }
    });

    // Update token status
    this.app.patch('/api/tokens/:id/status', async (req, res) => {
      try {
        const { id } = req.params;
        const { status, transactionHash, contractAddress } = req.body;

        if (!status || !['success', 'failed', 'deployed'].includes(status)) {
          return res.status(400).json({
            error: 'Invalid status. Must be "success", "failed", or "deployed"'
          });
        }

        const tokenIndex = this.tokens.findIndex(token => token.id === id);

        if (tokenIndex === -1) {
          return res.status(404).json({ error: 'Token not found' });
        }

        this.tokens[tokenIndex] = {
          ...this.tokens[tokenIndex],
          status,
          ...(transactionHash && { transactionHash }),
          ...(contractAddress && { contractAddress }),
          updatedAt: new Date().toISOString()
        };

        await this.saveTokens();

        res.json({
          message: 'Token status updated successfully',
          token: this.tokens[tokenIndex]
        });
      } catch (error) {
        console.error('Error updating token status:', error);
        res.status(500).json({ error: 'Failed to update token status' });
      }
    });

    // Find tokens by symbol
    this.app.get('/api/tokens/by-symbol/:symbol', (req, res) => {
      try {
        const { symbol } = req.params;
        const tokens = this.tokens.filter(token =>
          token.tokenSymbol === symbol ||
          (token.tokenSymbol === `p-${symbol}`) // Also check for presale tokens
        );

        if (tokens.length === 0) {
          return res.status(404).json({ error: 'No tokens found with this symbol' });
        }

        res.json({ tokens });
      } catch (error) {
        console.error('Error finding tokens by symbol:', error);
        res.status(500).json({ error: 'Failed to find tokens' });
      }
    });

    // Export tokens as JSON
    this.app.get('/api/tokens/export', (req, res) => {
      try {
        const data = { tokens: this.tokens };
        const filename = `tokens_export_${new Date().toISOString().split('T')[0]}.json`;

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.json(data);
      } catch (error) {
        console.error('Error exporting tokens:', error);
        res.status(500).json({ error: 'Failed to export tokens' });
      }
    });

    // Get token statistics
    this.app.get('/api/tokens/stats', (req, res) => {
      try {
        const stats = {
          total: this.tokens.length,
          pending: this.tokens.filter(t => t.status === 'pending').length,
          success: this.tokens.filter(t => t.status === 'success').length,
          deployed: this.tokens.filter(t => t.status === 'deployed').length,
          failed: this.tokens.filter(t => t.status === 'failed').length,
          lastDeployment: this.tokens.length > 0
            ? this.tokens[this.tokens.length - 1].timestamp
            : null
        };
        res.json(stats);
      } catch (error) {
        console.error('Error fetching token stats:', error);
        res.status(500).json({ error: 'Failed to get statistics' });
      }
    });
  }

  generateTokenId() {
    return `token-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  async saveTokens() {
    try {
      const tokensPath = path.join(__dirname, '..', 'data', 'tokens.json');
      await fs.writeFile(tokensPath, JSON.stringify({ tokens: this.tokens }, null, 2));
    } catch (error) {
      console.error('Error saving tokens:', error);
      throw error;
    }
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