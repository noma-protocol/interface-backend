import { WebSocketServer } from 'ws';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { MessageStore } from './message-store.js';
import { UsernameStore } from './username-store.js';
import { RateLimiter } from './rate-limiter.js';

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
    
    // Admin addresses (can be configured)
    this.adminAddresses = new Set([
      // Add admin addresses here
    ]);
  }

  async start() {
    // Initialize trollbox stores
    await this.messageStore.initialize();
    await this.usernameStore.initialize();
    
    // Cleanup rate limiter periodically
    setInterval(() => {
      this.rateLimiter.cleanup();
    }, 60000);

    this.wss = new WebSocketServer({ port: this.port });

    this.wss.on('connection', (ws, req) => {
      console.log('New WebSocket connection');
      
      const clientId = this.generateClientId();
      const clientIp = req.socket.remoteAddress;
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

      ws.on('close', () => {
        this.clients.delete(clientId);
        this.updateUserCount();
        console.log(`Client ${clientId} disconnected`);
      });

      ws.on('error', (error) => {
        console.error(`WebSocket error for client ${clientId}:`, error);
      });

      // Send welcome message with recent chat history
      const recentMessages = this.messageStore.getRecentMessages(50);
      ws.send(JSON.stringify({
        type: 'welcome',
        clientId,
        message: 'Connected to event stream',
        recentMessages,
        userCount: this.getActiveUserCount()
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
        client.sessionToken = uuidv4();
        
        // Get username
        const username = this.usernameStore.getUsername(address);
        
        client.ws.send(JSON.stringify({
          type: 'authenticated',
          success: true,
          address,
          username,
          sessionToken: client.sessionToken,
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
    if (!client.authenticated) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Not authenticated'
      }));
      return;
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
    if (!client.authenticated) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Not authenticated'
      }));
      return;
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
    if (!client.authenticated) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Not authenticated'
      }));
      return;
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
      if (!client.authenticated) continue;
      
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
    if (!client.authenticated) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Not authenticated'
      }));
      return;
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
    
    // Check if client is authenticated and session is valid
    if (client.authenticated && client.sessionToken === sessionToken) {
      // Check session age (30 minute timeout)
      const sessionAge = Date.now() - client.authTimestamp;
      const maxSessionAge = 30 * 60 * 1000; // 30 minutes
      
      if (sessionAge > maxSessionAge) {
        // Session expired
        client.authenticated = false;
        client.ws.send(JSON.stringify({
          type: 'clearAuth',
          message: 'Session expired. Please re-authenticate.'
        }));
        return;
      }
      
      // Session is valid
      const username = this.usernameStore.getUsername(client.address);
      client.ws.send(JSON.stringify({
        type: 'checkAuthResponse',
        authenticated: true,
        address: client.address,
        username,
        sessionToken: client.sessionToken,
        cooldownInfo: {
          changeCount: this.usernameStore.getChangeCount(client.address),
          canChange: this.usernameStore.canChangeUsername(client.address)
        }
      }));
    } else {
      // Not authenticated or invalid session
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

  stop() {
    if (this.wss) {
      this.wss.close();
      console.log('WebSocket server stopped');
    }
  }
}