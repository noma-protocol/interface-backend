import { WebSocketServer } from 'ws';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { MessageStore } from './message-store.js';
import { UsernameStore } from './username-store.js';
import { RateLimiter } from './rate-limiter.js';
import { SessionManager } from './session-manager.js';

// Helper function to convert BigInt to string in nested objects
function bigIntReplacer(key, value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

export class WSServer extends EventEmitter {
  constructor(port, eventStorage, authManager) {
    super();
    this.port = port;
    this.eventStorage = eventStorage;
    this.authManager = authManager;
    this.wss = null;
    this.clients = new Map();
    
    // Trollbox components
    this.messageStore = new MessageStore();
    this.usernameStore = new UsernameStore();
    this.rateLimiter = new RateLimiter();
    this.kickedUsers = new Map(); // Track kicked users
    this.sessionManager = new SessionManager(); // Persistent session management
    
    // Admin addresses (can be configured)
    this.adminAddresses = new Set([
      // Add admin addresses here
    ]);
  }

  async start() {
    // Initialize trollbox stores
    await this.messageStore.initialize();
    await this.usernameStore.initialize();
    
    // Track connections per IP
    this.connectionsByIp = new Map();
    this.maxConnectionsPerIp = 10; // Increased from 5 to allow more connections during development
    this.connectionAttempts = new Map(); // Track failed connection attempts
    
    // Periodic connection health check
    this.startConnectionHealthCheck();
    
    // Cleanup rate limiter and connection attempts periodically
    setInterval(() => {
      this.rateLimiter.cleanup();
      // Clear connection attempts after 5 minutes
      this.connectionAttempts.clear();
    }, 60000);
    
    // Log connection stats periodically
    setInterval(() => {
      const stats = this.getConnectionStats();
      const sessionStats = this.sessionManager.getStats();
      if (stats.totalConnections > 0 || stats.connectionsByIp.size > 0) {
        console.log('Connection Stats:', {
          totalConnections: stats.totalConnections,
          authenticatedConnections: stats.authenticatedConnections,
          uniqueIPs: stats.connectionsByIp.size,
          ipBreakdown: Array.from(stats.connectionsByIp.entries()),
          sessions: sessionStats
        });
      }
    }, 30000); // Every 30 seconds

    this.wss = new WebSocketServer({ port: this.port });

    this.wss.on('connection', (ws, req) => {
      const clientId = this.generateClientId();
      const clientIp = req.socket.remoteAddress;
      const userAgent = req.headers['user-agent'];
      const origin = req.headers.origin;
      
      // Check connection limit per IP
      const currentConnections = this.connectionsByIp.get(clientIp) || 0;
      if (currentConnections >= this.maxConnectionsPerIp) {
        // Track failed attempts
        const attempts = this.connectionAttempts.get(clientIp) || 0;
        this.connectionAttempts.set(clientIp, attempts + 1);
        
        // Log only every 10th attempt to reduce spam
        if (attempts % 10 === 0) {
          console.log(`Connection rejected - IP ${clientIp} has ${currentConnections} connections (max: ${this.maxConnectionsPerIp}) - ${attempts} total attempts`);
        }
        
        ws.close(1008, 'Too many connections from this IP');
        return;
      }
      
      // Update connection count
      this.connectionsByIp.set(clientIp, currentConnections + 1);
      
      if (global.DEBUG) {
        console.log(`New WebSocket connection:`, {
          clientId,
          clientIp,
          origin,
          userAgent: userAgent?.substring(0, 50) + '...',
          totalClients: this.clients.size + 1,
          ipConnections: currentConnections + 1
        });
      } else {
        console.log(`New WebSocket connection from ${clientIp} (${this.clients.size + 1} total, ${currentConnections + 1} from this IP)`);
      }
      const client = {
        id: clientId,
        ws,
        authenticated: false,
        address: null,
        pools: [],
        clientIp,
        authTimestamp: null,
        sessionToken: null
      };

      this.clients.set(clientId, client);

      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message.toString());
          await this.handleMessage(clientId, data);
        } catch (error) {
          console.error('Error handling message:', error);
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid message format'
          }));
        }
      });
      
      // Handle pong responses for connection health check
      ws.on('pong', () => {
        const client = this.clients.get(clientId);
        if (client) {
          client.pendingPong = false;
        }
      });

      ws.on('close', () => {
        const clientInfo = this.clients.get(clientId);
        const wasAuthenticated = clientInfo ? clientInfo.authenticated : false;
        
        // Remove client from map
        this.clients.delete(clientId);
        this.updateUserCount();
        
        // Decrease connection count for this IP
        const currentConnections = this.connectionsByIp.get(clientIp) || 0;
        if (currentConnections > 1) {
          this.connectionsByIp.set(clientIp, currentConnections - 1);
        } else {
          this.connectionsByIp.delete(clientIp);
        }
        
        if (global.DEBUG) {
          console.log(`Client disconnected:`, {
            clientId,
            totalClients: this.clients.size,
            authenticated: wasAuthenticated,
            ipConnections: Math.max(0, currentConnections - 1)
          });
        } else {
          console.log(`Client disconnected from ${clientIp} (${this.clients.size} remaining, ${Math.max(0, currentConnections - 1)} from this IP)`);
        }
      });

      ws.on('error', (error) => {
        console.error(`WebSocket error for client ${clientId}:`, error);
      });

      // Send connection confirmation
      ws.send(JSON.stringify({
        type: 'connection',
        clientId,
        message: 'Connected to blockchain event stream',
        requiresAuth: false,
        authMessage: 'Authentication optional for public blockchain data'
      }));
    });

    console.log(`WebSocket server listening on port ${this.port}`);
  }

  async handleMessage(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client) return;

    switch (data.type) {
      case 'auth':
        await this.handleAuth(client, data);
        break;

      case 'subscribe':
        await this.handleSubscribe(client, data);
        break;

      case 'unsubscribe':
        await this.handleUnsubscribe(client, data);
        break;

      case 'getHistory':
        await this.handleGetHistory(client, data);
        break;

      case 'getLatest':
        await this.handleGetLatest(client, data);
        break;

      case 'getGlobalTrades':
        await this.handleGetGlobalTrades(client, data);
        break;

      // Trollbox message types
      case 'message':
        await this.handleChatMessage(client, data);
        break;
        
      case 'changeUsername':
        await this.handleChangeUsername(client, data);
        break;
        
      case 'ping':
        await this.handlePing(client);
        break;
        
      case 'checkAuth':
        await this.handleCheckAuth(client, data);
        break;

      default:
        client.ws.send(JSON.stringify({
          type: 'error',
          message: `Unknown message type: ${data.type}`
        }));
    }
  }

  async handleAuth(client, data) {
    try {
      const { address, signature, message } = data;
      
      const isValid = await this.authManager.verifySignature(address, signature, message);
      
      if (isValid) {
        client.authenticated = true;
        client.address = address;
        client.authTimestamp = Date.now();
        
        // Get username
        const username = this.usernameStore.getUsername(address);
        
        // Create or update session
        const session = this.sessionManager.createSession(address, username);
        client.sessionToken = session.token;
        
        client.ws.send(JSON.stringify({
          type: 'authenticated',
          success: true,
          address,
          username,
          sessionToken: session.token,
          cooldownInfo: {
            changeCount: this.usernameStore.getChangeCount(address),
            canChange: this.usernameStore.canChangeUsername(address)
          }
        }));
        
        // Update user count
        this.updateUserCount();
      } else {
        client.ws.send(JSON.stringify({
          type: 'auth',
          success: false,
          message: 'Invalid signature'
        }));
      }
    } catch (error) {
      console.error('Auth error:', error);
      client.ws.send(JSON.stringify({
        type: 'auth',
        success: false,
        message: 'Authentication failed'
      }));
    }
  }

  async handleSubscribe(client, data) {
    // Allow subscribing without authentication for public blockchain events
    if (global.DEBUG && !client.authenticated) {
      console.log('Client subscribing without authentication');
    }

    const { pools = [] } = data;
    
    pools.forEach(pool => {
      const normalizedPool = pool.toLowerCase();
      if (!client.pools.includes(normalizedPool)) {
        client.pools.push(normalizedPool);
      }
    });

    client.ws.send(JSON.stringify({
      type: 'subscribed',
      pools: client.pools
    }));
  }

  async handleUnsubscribe(client, data) {
    if (!client.authenticated) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Not authenticated'
      }));
      return;
    }

    const { pools = [] } = data;
    
    client.pools = client.pools.filter(pool => !pools.includes(pool));

    client.ws.send(JSON.stringify({
      type: 'unsubscribed',
      pools: client.pools
    }));
  }

  async handleGetHistory(client, data) {
    // Allow getting history without authentication for public blockchain events
    if (global.DEBUG && !client.authenticated) {
      console.log('Client getting history without authentication');
    }

    const { pools, startTime, endTime, limit = 1000 } = data;
    
    let events = this.eventStorage.getAllEvents();
    
    if (pools && pools.length > 0) {
      events = events.filter(event => 
        pools.includes(event.poolAddress)
      );
    } else if (client.pools.length > 0) {
      events = events.filter(event => 
        client.pools.includes(event.poolAddress)
      );
    }

    if (startTime) {
      events = events.filter(event => event.timestamp >= startTime);
    }
    
    if (endTime) {
      events = events.filter(event => event.timestamp <= endTime);
    }

    events = events.slice(-limit);

    client.ws.send(JSON.stringify({
      type: 'history',
      events,
      count: events.length
    }, bigIntReplacer));
  }

  async handleGetLatest(client, data) {
    // Allow getting latest events without authentication
    if (global.DEBUG && !client.authenticated) {
      console.log('Client getting latest events without authentication');
    }

    const { limit = 100 } = data;
    
    let events = this.eventStorage.getLatestEvents(limit);
    
    if (client.pools.length > 0) {
      events = events.filter(event => 
        client.pools.includes(event.poolAddress)
      );
    }

    client.ws.send(JSON.stringify({
      type: 'latest',
      events,
      count: events.length
    }, bigIntReplacer));
  }

  broadcastEvent(event) {
    for (const [clientId, client] of this.clients) {
      // Broadcast to all connected clients, not just authenticated ones
      
      // For ExchangeHelper events, there's no poolAddress
      // For Uniswap events, check pool subscriptions
      if (event.poolAddress) {
        const normalizedEventPool = event.poolAddress.toLowerCase();
        
        // If client has no specific subscriptions, they get ALL events
        // Otherwise, check if they're subscribed to this specific pool
        const isSubscribedToAll = client.pools.length === 0;
        const isSubscribedToThisPool = client.pools.includes(normalizedEventPool);
        
        if (!isSubscribedToAll && !isSubscribedToThisPool) {
          continue;
        }
      }
      
      if (client.ws.readyState === 1) {
        client.ws.send(JSON.stringify({
          type: 'event',
          data: event
        }, bigIntReplacer));
      }
    }
  }

  async handleGetGlobalTrades(client, data) {
    // Allow getting global trades without authentication
    if (global.DEBUG && !client.authenticated) {
      console.log('Client getting global trades without authentication');
    }

    // Get limit from request or default to 50
    const limit = data.limit || 50;
    
    // Get global trades across all pools
    const trades = this.eventStorage.getLatestGlobalTrades(Math.min(limit, 100));
    
    client.ws.send(JSON.stringify({
      type: 'globalTrades',
      trades,
      count: trades.length
    }, bigIntReplacer));
  }

  generateClientId() {
    return `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // Trollbox-specific methods
  async handleChatMessage(client, data) {
    if (!client.authenticated) {
      client.ws.send(JSON.stringify({
        type: 'requireAuth',
        message: 'Authentication required to send messages'
      }));
      return;
    }

    // Check if user is kicked
    if (this.isUserKicked(client.address)) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'You are temporarily banned from sending messages'
      }));
      return;
    }

    // Rate limiting
    if (this.rateLimiter.isRateLimited(client.address, 'message')) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Rate limit exceeded. Please slow down.'
      }));
      return;
    }

    const { content, replyTo } = data;

    // Validate message
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message content'
      }));
      return;
    }

    if (content.length > 500) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Message too long (max 500 characters)'
      }));
      return;
    }

    // Process commands
    if (content.startsWith('/')) {
      await this.handleCommand(client, content);
      return;
    }

    // Get username
    const username = this.usernameStore.getUsername(client.address);

    // Add message to store
    const message = await this.messageStore.addMessage(
      username,
      client.address,
      content,
      replyTo
    );

    // Broadcast to all authenticated clients
    this.broadcastMessage({
      type: 'message',
      message
    });
  }

  async handleChangeUsername(client, data) {
    if (!client.authenticated) {
      client.ws.send(JSON.stringify({
        type: 'requireAuth',
        message: 'Authentication required to change username'
      }));
      return;
    }

    const { username } = data;

    // Validate username
    if (!username || typeof username !== 'string') {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid username'
      }));
      return;
    }

    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 3 || trimmedUsername.length > 20) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Username must be between 3 and 20 characters'
      }));
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedUsername)) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Username can only contain letters, numbers, underscores, and hyphens'
      }));
      return;
    }

    // Try to set username
    const result = await this.usernameStore.setUsername(client.address, trimmedUsername);

    if (result.success) {
      // Update session with new username
      if (client.sessionToken) {
        this.sessionManager.updateSessionUsername(client.sessionToken, result.username);
      }
      
      client.ws.send(JSON.stringify({
        type: 'usernameChanged',
        username: result.username,
        cooldownDuration: result.cooldownDuration
      }));

      // Notify others
      this.broadcastMessage({
        type: 'userUpdate',
        address: client.address,
        username: result.username
      }, client.id);
    } else if (result.error === 'cooldown') {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: `Username change on cooldown. Try again in ${Math.ceil(result.remainingTime / 1000)} seconds`
      }));
    }
  }

  async handlePing(client) {
    client.ws.send(JSON.stringify({
      type: 'pong',
      timestamp: Date.now()
    }));
  }

  async handleCheckAuth(client, data) {
    const { sessionToken } = data;
    
    // Validate session with SessionManager
    const session = this.sessionManager.getSession(sessionToken);
    
    if (session) {
      // Session is valid - update client state
      client.authenticated = true;
      client.address = session.address;
      client.sessionToken = sessionToken;
      client.authTimestamp = session.createdAt;
      
      // Get current username (might have changed)
      const username = this.usernameStore.getUsername(session.address);
      
      client.ws.send(JSON.stringify({
        type: 'checkAuthResponse',
        authenticated: true,
        address: session.address,
        username,
        sessionToken: sessionToken,
        cooldownInfo: {
          changeCount: this.usernameStore.getChangeCount(session.address),
          canChange: this.usernameStore.canChangeUsername(session.address)
        }
      }));
      
      // Update user count
      this.updateUserCount();
    } else {
      // Session not found or expired
      client.authenticated = false;
      client.ws.send(JSON.stringify({
        type: 'checkAuthResponse',
        authenticated: false
      }));
    }
  }

  async handleCommand(client, content) {
    const parts = content.split(' ');
    const command = parts[0].toLowerCase();

    switch (command) {
      case '/help':
        client.ws.send(JSON.stringify({
          type: 'info',
          message: 'Available commands: /help, /slap <username>, /kick <username> (admin), /clearauth [username] (admin)'
        }));
        break;

      case '/slap':
        if (parts.length < 2) {
          client.ws.send(JSON.stringify({
            type: 'error',
            message: 'Usage: /slap <username>'
          }));
          return;
        }
        const targetUsername = parts.slice(1).join(' ');
        const senderUsername = this.usernameStore.getUsername(client.address);
        
        this.broadcastMessage({
          type: 'message',
          message: {
            id: uuidv4(),
            username: 'System',
            address: 'system',
            content: `${senderUsername} slaps ${targetUsername} with a large trout! 🐟`,
            timestamp: Date.now(),
            verified: true,
            isAction: true
          }
        });
        break;

      case '/kick':
        if (!this.adminAddresses.has(client.address)) {
          client.ws.send(JSON.stringify({
            type: 'error',
            message: 'Unauthorized command'
          }));
          return;
        }
        
        if (parts.length < 2) {
          client.ws.send(JSON.stringify({
            type: 'error',
            message: 'Usage: /kick <username>'
          }));
          return;
        }

        const kickUsername = parts.slice(1).join(' ');
        const kickedAddress = this.findAddressByUsername(kickUsername);
        
        if (kickedAddress) {
          this.kickUser(kickedAddress);
          this.broadcastMessage({
            type: 'message',
            message: {
              id: uuidv4(),
              username: 'System',
              address: 'system',
              content: `${kickUsername} has been kicked for 1 hour`,
              timestamp: Date.now(),
              verified: true,
              isAction: true
            }
          });
        }
        break;

      default:
        client.ws.send(JSON.stringify({
          type: 'error',
          message: 'Unknown command. Type /help for available commands.'
        }));
    }
  }

  broadcastMessage(data, excludeClientId = null) {
    for (const [clientId, client] of this.clients) {
      if (!client.authenticated) continue;
      if (excludeClientId && clientId === excludeClientId) continue;
      
      if (client.ws.readyState === 1) {
        client.ws.send(JSON.stringify(data));
      }
    }
  }

  kickUser(address) {
    const kickDuration = 60 * 60 * 1000; // 1 hour
    this.kickedUsers.set(address.toLowerCase(), Date.now() + kickDuration);
  }

  isUserKicked(address) {
    const kickedUntil = this.kickedUsers.get(address.toLowerCase());
    if (!kickedUntil) return false;
    
    if (Date.now() >= kickedUntil) {
      this.kickedUsers.delete(address.toLowerCase());
      return false;
    }
    
    return true;
  }

  findAddressByUsername(username) {
    for (const [clientId, client] of this.clients) {
      if (client.authenticated) {
        const clientUsername = this.usernameStore.getUsername(client.address);
        if (clientUsername.toLowerCase() === username.toLowerCase()) {
          return client.address;
        }
      }
    }
    return null;
  }

  getActiveUserCount() {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.authenticated) count++;
    }
    return count;
  }

  updateUserCount() {
    const userCount = this.getActiveUserCount();
    this.broadcastMessage({
      type: 'userCount',
      count: userCount
    });
  }

  getConnectionStats() {
    let authenticatedCount = 0;
    for (const client of this.clients.values()) {
      if (client.authenticated) authenticatedCount++;
    }
    
    return {
      totalConnections: this.clients.size,
      authenticatedConnections: authenticatedCount,
      connectionsByIp: new Map(this.connectionsByIp)
    };
  }

  stop() {
    if (this.wss) {
      this.wss.close();
      console.log('WebSocket server stopped');
    }
  }
  
  // Periodic health check to detect dead connections
  startConnectionHealthCheck() {
    setInterval(() => {
      this.clients.forEach((client, clientId) => {
        // Check if connection is alive
        if (client.ws.readyState === client.ws.OPEN) {
          // Send ping to check if client is still alive
          client.ws.ping();
          
          // Mark as pending pong
          client.pendingPong = true;
          
          // Set timeout to close if no pong received
          setTimeout(() => {
            if (client.pendingPong && this.clients.has(clientId)) {
              if (global.DEBUG) {
                console.log(`Closing stale connection: ${clientId}`);
              }
              client.ws.terminate(); // Force close
            }
          }, 5000); // 5 second timeout
        } else if (client.ws.readyState !== client.ws.CONNECTING) {
          // Connection is closed or closing, clean it up
          this.clients.delete(clientId);
          const clientIp = client.clientIp;
          const currentConnections = this.connectionsByIp.get(clientIp) || 0;
          if (currentConnections > 1) {
            this.connectionsByIp.set(clientIp, currentConnections - 1);
          } else {
            this.connectionsByIp.delete(clientIp);
          }
        }
      });
    }, 30000); // Check every 30 seconds
  }
}