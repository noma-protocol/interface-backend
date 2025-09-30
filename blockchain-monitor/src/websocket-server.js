import { WebSocketServer } from 'ws';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { MessageStore } from './message-store.js';
import { UsernameStore } from './username-store.js';
import { RateLimiter } from './rate-limiter.js';
import { SessionManager } from './session-manager.js';

// Stream Room class for managing viewers
class StreamRoom {
  constructor(streamId, broadcaster, broadcasterAddress) {
    this.streamId = streamId;
    this.broadcaster = broadcaster;
    this.broadcasterAddress = broadcasterAddress;
    this.viewers = new Map(); // Map of viewerId -> viewer info
    this.createdAt = Date.now();
  }

  addViewer(viewerId, viewerInfo) {
    this.viewers.set(viewerId, viewerInfo);
  }

  removeViewer(viewerId) {
    this.viewers.delete(viewerId);
  }

  getViewerCount() {
    return this.viewers.size;
  }

  broadcast(message, excludeId = null) {
    // Send to all viewers except excluded one
    for (const [viewerId, viewer] of this.viewers) {
      if (viewerId !== excludeId && viewer.ws && viewer.ws.readyState === 1) {
        viewer.ws.send(JSON.stringify(message));
      }
    }
  }
}

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
    this.addressToClientId = new Map(); // address -> clientId mapping
    
    // Trollbox components
    this.messageStore = new MessageStore();
    this.usernameStore = new UsernameStore();
    this.rateLimiter = new RateLimiter();
    this.kickedUsers = new Map(); // Track kicked users
    this.sessionManager = new SessionManager(); // Persistent session management
    this.activeStreams = new Map(); // Track active streams by streamId
    this.streamRooms = new Map(); // Track stream rooms with viewers
    this.pendingIceCandidates = new Map(); // Buffer ICE candidates until offer/answer exchange: connectionKey -> [candidates]

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

      // Send connection confirmation
      ws.send(JSON.stringify({
        type: 'connection',
        clientId: clientId,
        message: 'Connected to streaming server'
      }));

      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message.toString());

          // All messages go through handlers - handlers will do their own routing
          await this.handleMessage(clientId, data);
        } catch (error) {
          console.error('Error handling message:', error);
          console.error('Raw message:', message.toString());
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid message format',
            details: error.message
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
        
        // Handle client leaving streams they joined
        if (clientInfo && clientInfo.joinedStreams) {
          for (const streamId of clientInfo.joinedStreams) {
            // Remove from stream room
            const room = this.streamRooms.get(streamId);
            if (room) {
              room.removeViewer(clientId);
            }
            
            const streamInfo = this.activeStreams.get(streamId);
            if (streamInfo) {
              // Notify streamer that viewer left
              const streamerClient = this.clients.get(streamInfo.clientId);
              if (streamerClient) {
                streamerClient.ws.send(JSON.stringify({
                  type: 'stream-notification',
                  action: 'viewer-left',
                  streamId,
                  viewer: clientInfo.address || 'anonymous',
                  timestamp: Date.now()
                }));
              }
              
              // Notify other viewers
              for (const [otherId, otherClient] of this.clients) {
                if (otherId !== clientId && otherId !== streamInfo.clientId &&
                    otherClient.joinedStreams && otherClient.joinedStreams.has(streamId)) {
                  const leaverUsername = this.usernameStore.getUsername(clientInfo.address) || 'anonymous';
                  otherClient.ws.send(JSON.stringify({
                    type: 'stream-notification',
                    action: 'user-left',
                    streamId,
                    user: clientInfo.address || 'anonymous',
                    username: leaverUsername,
                    timestamp: Date.now()
                  }));
                }
              }
            }
          }
        }
        
        // End any active streams for this client
        for (const [streamId, streamInfo] of this.activeStreams) {
          if (streamInfo.clientId === clientId) {
            this.activeStreams.delete(streamId);
            this.streamRooms.delete(streamId);

            // Notify all clients that the stream ended
            const notification = {
              type: 'stream-notification',
              action: 'ended',
              streamId,
              streamer: streamInfo.streamer,
              username: streamInfo.username,
              title: streamInfo.title,
              roomId: streamInfo.roomId,
              message: `📴 ${streamInfo.username}'s stream ended unexpectedly`,
              timestamp: Date.now()
            };

            for (const [otherId, otherClient] of this.clients) {
              if (otherId !== clientId) {
                otherClient.ws.send(JSON.stringify(notification));
              }
            }
          }
        }

        // Notify about peer connection cleanup - tell all clients to clean up connections to this peer
        const peerDisconnectNotification = {
          type: 'peer-disconnected',
          peerId: clientId,
          peerAddress: clientInfo.address,
          timestamp: Date.now()
        };

        for (const [otherId, otherClient] of this.clients) {
          if (otherId !== clientId && otherClient.ws.readyState === 1) {
            otherClient.ws.send(JSON.stringify(peerDisconnectNotification));
          }
        }

        // Remove client from map
        this.clients.delete(clientId);
        
        // Clean up address mapping
        if (clientInfo && clientInfo.address) {
          this.addressToClientId.delete(clientInfo.address);
        }
        
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

      // Send connection confirmation with recent messages
      const recentMessages = this.messageStore.getRecentMessages(50);
      ws.send(JSON.stringify({
        type: 'connection',
        clientId,
        message: 'Connected to blockchain event stream',
        requiresAuth: false,
        authMessage: 'Authentication optional for public blockchain data',
        recentMessages
      }));
    });

    console.log(`WebSocket server listening on port ${this.port}`);
  }

  async handleMessage(clientId, data) {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Log message handling for debugging
    if (data.type && data.type.startsWith('webrtc')) {
      console.log(`[WebRTC] Handling ${data.type} from ${client.address || clientId}`);
      if (data.to) console.log(`[WebRTC] Target: ${data.to}`);
    }

    // Log stream-related messages
    if (data.type && (data.type.includes('stream') || data.type === 'register-address')) {
      console.log(`[Message] ${data.type} from ${client.address || clientId}`, data);
    }

    try {
      switch (data.type) {
      case 'auth':
        await this.handleAuth(client, data);
        break;

      case 'register-address':
        await this.handleRegisterAddress(client, data);
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
        
      case 'getMessages':
        await this.handleGetMessages(client, data);
        break;

      case 'request-active-streams':
        await this.handleRequestActiveStreams(client);
        break;

      case 'get-active-streams':
        await this.handleGetActiveStreams(client);
        break;

      case 'request-active-streams':
        await this.handleRequestActiveStreams(client);
        break;

      case 'stream-notification':
        await this.handleStreamNotification(client, data);
        break;

      case 'stream-start':
        await this.handleStreamStart(client, data);
        break;

      case 'stream-end':
        await this.handleStreamEnd(client, data);
        break;

      case 'viewer-leave':
        await this.handleViewerLeave(client, data);
        break;

      case 'viewer-join':
        await this.handleViewerJoin(client, data);
        break;

      case 'direct-message':
        // Direct messages should have been routed already if they had a 'to' field
        // This handles the fallback case
        await this.handleDirectMessage(client, data);
        break;

      case 'stream-joined':
        await this.handleStreamJoined(client, data);
        break;

      // WebRTC signaling messages
      case 'webrtc-request':
        await this.handleWebRTCRequest(client, data);
        break;
        
      case 'webrtc-offer':
        await this.handleWebRTCOffer(client, data);
        break;
        
      case 'webrtc-answer':
        await this.handleWebRTCAnswer(client, data);
        break;
        
      case 'webrtc-ice':
        await this.handleWebRTCIce(client, data);
        break;

      case 'join':
        await this.handleJoin(client, data);
        break;

      case 'leave':
        await this.handleLeave(client, data);
        break;

      case 'offer':
        await this.handleRoomOffer(client, data);
        break;

      case 'answer':
        await this.handleRoomAnswer(client, data);
        break;

      case 'ice-candidate':
        await this.handleRoomIceCandidate(client, data);
        break;

      case 'test-request-offer':
        await this.handleTestRequestOffer(client, data);
        break;

      case 'echo':
        await this.handleEcho(client, data);
        break;

      case 'broadcast-test':
        await this.handleBroadcastTest(client, data);
        break;

      // Debug handler to test message routing
      case 'debug-route':
        await this.handleDebugRoute(client, data);
        break;
        
      // Debug handler to list connected clients
      case 'debug-clients':
        await this.handleDebugClients(client);
        break;

      default:
        client.ws.send(JSON.stringify({
          type: 'error',
          message: `Unknown message type: ${data.type}`
        }));
      }
    } catch (error) {
      console.error('Error in handleMessage:', error);
      console.error('Message type:', data.type);
      console.error('Message data:', JSON.stringify(data));
      throw error;
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
        
        // Track connection by address for direct routing
        if (address) {
          // Remove any existing connection for this address
          for (const [id, c] of this.clients) {
            if (id !== client.id && c.address === address) {
              console.log(`Removing duplicate connection for ${address}`);
              c.ws.close(1000, 'Duplicate connection');
            }
          }
          // Update address mapping
          this.addressToClientId.set(address, client.id);
        }
        
        // Get username
        const username = this.usernameStore.getUsername(address);
        
        // Get or create session
        const session = this.sessionManager.getOrCreateSession(address, username);
        client.sessionToken = session.token;
        
        console.log(`Session for ${address}:`, {
          token: session.token,
          username: session.username,
          clientId: client.id,
          isNew: session.createdAt === Date.now()
        });
        
        // Get recent messages for authenticated users
        const recentMessages = this.messageStore.getRecentMessages(50);
        const userCount = this.getActiveUserCount();
        
        client.ws.send(JSON.stringify({
          type: 'authenticated',
          success: true,
          address,
          username,
          sessionToken: session.token,
          cooldownInfo: {
            changeCount: this.usernameStore.getChangeCount(address),
            canChange: this.usernameStore.canChangeUsername(address)
          },
          recentMessages,
          userCount
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

  async handleGetMessages(client, data) {
    const { limit = 50 } = data;
    const messages = this.messageStore.getRecentMessages(limit);
    
    client.ws.send(JSON.stringify({
      type: 'messages',
      messages
    }));
  }

  async handleRequestActiveStreams(client) {
    // Get all pools that have at least one subscriber
    const allActivePools = new Set();
    
    for (const [clientId, otherClient] of this.clients) {
      if (otherClient.pools && otherClient.pools.length > 0) {
        otherClient.pools.forEach(pool => allActivePools.add(pool));
      }
    }
    
    // Get all active video streams with viewer count
    const activeStreams = Array.from(this.activeStreams.values()).map(stream => {
      const room = this.streamRooms.get(stream.streamId);
      const viewerCount = room ? room.getViewerCount() : 0;
      
      return {
        streamId: stream.streamId,
        roomId: stream.roomId,
        streamer: stream.streamer,
        username: stream.username,
        title: stream.title,
        description: stream.description,
        quality: stream.quality,
        startedAt: stream.startedAt,
        viewerCount,
        clientId: stream.clientId,
        isStreamerOnline: this.clients.has(stream.clientId)
      };
    });
    
    // Send pools, streams, and client's subscriptions
    client.ws.send(JSON.stringify({
      type: 'active-streams',
      pools: Array.from(allActivePools), // All pools with active subscribers
      mySubscriptions: client.pools || [], // This client's subscriptions
      activeStreams: activeStreams // All active video streams
    }));
  }

  async handleGetActiveStreams(client) {
    // Get all pools that have at least one subscriber
    const allActivePools = new Set();
    
    for (const [clientId, otherClient] of this.clients) {
      if (otherClient.pools && otherClient.pools.length > 0) {
        otherClient.pools.forEach(pool => allActivePools.add(pool));
      }
    }
    
    // Get all active video streams with viewer count
    const activeStreams = Array.from(this.activeStreams.values()).map(stream => {
      const room = this.streamRooms.get(stream.streamId);
      const viewerCount = room ? room.getViewerCount() : 0;
      
      return {
        streamId: stream.streamId,
        roomId: stream.roomId,
        streamer: stream.streamer,
        username: stream.username,
        title: stream.title,
        description: stream.description,
        quality: stream.quality,
        startedAt: stream.startedAt,
        viewerCount,
        clientId: stream.clientId,
        isStreamerOnline: this.clients.has(stream.clientId)
      };
    });
    
    // Send pools, streams, and client's subscriptions
    client.ws.send(JSON.stringify({
      type: 'active-streams',
      pools: Array.from(allActivePools), // All pools with active subscribers
      mySubscriptions: client.pools || [], // This client's subscriptions
      activeStreams: activeStreams // All active video streams
    }));
  }

  async handleStreamNotification(client, data) {
    // Handle stream notification requests
    // This could be used to notify about stream status changes or events
    const { action, pool, roomId, message } = data;
    
    // Send acknowledgment back to the client
    client.ws.send(JSON.stringify({
      type: 'stream-notification-ack',
      action,
      pool,
      message,
      timestamp: Date.now()
    }));
    
    // If this is a broadcast notification, send to all subscribed clients
    if (action === 'broadcast' && (pool || roomId)) {
      const targetPool = pool || roomId;
      const notification = {
        type: 'stream-notification',
        pool: targetPool,
        roomId,
        message,
        from: client.address || 'anonymous',
        timestamp: Date.now()
      };
      
      // Broadcast to all clients subscribed to this pool
      for (const [clientId, otherClient] of this.clients) {
        if (clientId !== client.id) {
          // If targetPool exists and client has pool subscriptions, check if they're subscribed
          if (targetPool && otherClient.pools && otherClient.pools.length > 0) {
            if (otherClient.pools.includes(targetPool.toLowerCase())) {
              otherClient.ws.send(JSON.stringify(notification));
            }
          } else {
            // If no pool specified or client has no specific subscriptions, send to all
            otherClient.ws.send(JSON.stringify(notification));
          }
        }
      }
    }
  }

  async handleStreamStart(client, data) {
    // Handle when a user starts streaming
    const { title, roomId, streamId: providedStreamId, pool, description, quality, streamer } = data;
    // Use the streamer address from the message if client is not authenticated
    const streamerAddress = client.address || streamer || data.from;
    const username = this.usernameStore.getUsername(streamerAddress) || data.username || 'anonymous';
    const streamId = providedStreamId || roomId || `stream-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    
    console.log('[Stream Start]', {
      streamId,
      title,
      streamer: streamerAddress,
      clientId: client.id,
      clientAddress: client.address
    });
    
    // Store active stream
    const streamInfo = {
      streamId,
      streamer: streamerAddress || client.id,
      username,
      title: title || 'Untitled Stream',
      roomId: roomId || streamId,
      pool,
      description: description || '',
      quality,
      startedAt: data.startedAt || Date.now(),
      clientId: client.id,
      viewerCount: 0
    };
    this.activeStreams.set(streamId, streamInfo);
    
    // Create stream room
    const room = new StreamRoom(streamId, client, streamerAddress);
    this.streamRooms.set(streamId, room);
    
    // Create stream message
    const message = `🎥 ${username} started streaming: "${title || 'Untitled Stream'}"`;
    
    // Send acknowledgment to the streamer
    client.ws.send(JSON.stringify({
      type: 'stream-start-ack',
      streamId,
      action: 'started',
      message,
      timestamp: Date.now()
    }));
    
    // Broadcast to all clients - using test-webRTC format
    const notification = {
      type: 'stream-start',
      streamId,
      title: title || 'Untitled Stream',
      description: description || '',
      streamer: streamerAddress || client.id
    };
    
    // Also send legacy format for compatibility
    const legacyNotification = {
      type: 'stream-notification',
      action: 'started',
      streamId,
      roomId,
      streamer: streamerAddress || 'anonymous',
      username,
      title,
      description,
      quality,
      message,
      timestamp: Date.now()
    };
    
    console.log('[Stream Start] Broadcasting notifications');
    
    // Send to all connected clients
    for (const [clientId, otherClient] of this.clients) {
      if (otherClient.ws.readyState === 1) {
        // Send both formats
        otherClient.ws.send(JSON.stringify(notification));
        if (clientId !== client.id) {
          otherClient.ws.send(JSON.stringify(legacyNotification));
        }
      }
    }
  }

  async handleStreamEnd(client, data) {
    // Handle when a user ends streaming
    const { streamId } = data;
    
    const streamInfo = this.activeStreams.get(streamId);
    if (!streamInfo) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Stream not found'
      }));
      return;
    }
    
    // Check if client owns this stream
    if (streamInfo.clientId !== client.id) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Unauthorized to end this stream'
      }));
      return;
    }
    
    // Remove from active streams and rooms
    this.activeStreams.delete(streamId);
    this.streamRooms.delete(streamId);
    
    // Create end message
    const message = `📴 ${streamInfo.username} ended streaming: "${streamInfo.title}"`;
    
    // Send acknowledgment to the streamer
    client.ws.send(JSON.stringify({
      type: 'stream-end-ack',
      streamId,
      action: 'ended',
      message,
      timestamp: Date.now()
    }));
    
    // Broadcast to all clients - using test-webRTC format
    const notification = {
      type: 'stream-end',
      streamId: streamId,
      streamer: streamInfo.streamer
    };
    
    // Also send legacy format for compatibility
    const legacyNotification = {
      type: 'stream-notification',
      action: 'ended',
      streamId,
      streamer: streamInfo.streamer,
      username: streamInfo.username,
      title: streamInfo.title,
      roomId: streamInfo.roomId,
      message,
      timestamp: Date.now()
    };
    
    console.log('[Stream End] Broadcasting notifications');
    
    // Send to all connected clients
    for (const [clientId, otherClient] of this.clients) {
      if (otherClient.ws.readyState === 1) {
        // Send both formats
        otherClient.ws.send(JSON.stringify(notification));
        if (clientId !== client.id) {
          otherClient.ws.send(JSON.stringify(legacyNotification));
        }
      }
    }
    
    console.log(`[Stream End] Stream ${streamId} ended`);
  }

  async handleViewerJoin(client, data) {
    // Handle when a viewer joins a stream
    const { streamId, roomId } = data;
    const targetStreamId = streamId || roomId;

    if (!targetStreamId) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Stream ID required'
      }));
      return;
    }

    // Check if stream exists
    const streamInfo = this.activeStreams.get(targetStreamId);
    if (!streamInfo) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Stream not found'
      }));
      return;
    }

    // Track that this client joined the stream
    if (!client.joinedStreams) {
      client.joinedStreams = new Set();
    }
    client.joinedStreams.add(targetStreamId);

    // Add to stream room for viewer count tracking
    const room = this.streamRooms.get(targetStreamId);
    if (room) {
      room.addViewer(client.id, {
        ws: client.ws,
        address: client.address,
        username: this.usernameStore.getUsername(client.address) || 'anonymous',
        joinedAt: Date.now()
      });
    }

    // Send stream info to the viewer
    client.ws.send(JSON.stringify({
      type: 'viewer-join-ack',
      streamId: targetStreamId,
      streamInfo: {
        title: streamInfo.title,
        streamer: streamInfo.streamer,
        username: streamInfo.username,
        description: streamInfo.description,
        quality: streamInfo.quality,
        startedAt: streamInfo.startedAt
      },
      timestamp: Date.now()
    }));

    // Notify the streamer that a viewer joined
    const streamerClient = this.clients.get(streamInfo.clientId);
    if (streamerClient) {
      const viewerUsername = this.usernameStore.getUsername(client.address) || 'anonymous';
      streamerClient.ws.send(JSON.stringify({
        type: 'stream-notification',
        action: 'viewer-joined',
        streamId: targetStreamId,
        viewer: client.address || 'anonymous',
        viewerUsername,
        timestamp: Date.now()
      }));
    }
  }

  async handleViewerLeave(client, data) {
    // Handle when a viewer leaves a stream
    const { streamId, roomId } = data;
    const targetStreamId = streamId || roomId;

    if (!targetStreamId) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Stream ID required'
      }));
      return;
    }

    // Remove from joined streams tracking
    if (client.joinedStreams) {
      client.joinedStreams.delete(targetStreamId);
    }

    // Remove from stream room for viewer count tracking
    const room = this.streamRooms.get(targetStreamId);
    if (room) {
      room.removeViewer(client.id);
    }

    // Send acknowledgment to the viewer
    client.ws.send(JSON.stringify({
      type: 'viewer-leave-ack',
      streamId: targetStreamId,
      timestamp: Date.now()
    }));

    // Notify the streamer that a viewer left
    const streamInfo = this.activeStreams.get(targetStreamId);
    if (streamInfo) {
      const streamerClient = this.clients.get(streamInfo.clientId);
      if (streamerClient) {
        streamerClient.ws.send(JSON.stringify({
          type: 'stream-notification',
          action: 'viewer-left',
          streamId: targetStreamId,
          viewer: client.address || 'anonymous',
          timestamp: Date.now()
        }));
      }
    }
  }

  async handleDirectMessage(client, data) {
    // Handle direct messages between users
    const { recipient, recipientAddress, message } = data;
    
    if (!message || !message.trim()) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Message content is required'
      }));
      return;
    }
    
    // Find recipient by address or username
    let recipientClient = null;
    let recipientId = null;
    
    if (recipientAddress) {
      // Find by address
      for (const [id, c] of this.clients) {
        if (c.address && c.address.toLowerCase() === recipientAddress.toLowerCase()) {
          recipientClient = c;
          recipientId = id;
          break;
        }
      }
    } else if (recipient) {
      // Find by username
      for (const [id, c] of this.clients) {
        const username = this.usernameStore.getUsername(c.address);
        if (username && username.toLowerCase() === recipient.toLowerCase()) {
          recipientClient = c;
          recipientId = id;
          break;
        }
      }
    }
    
    if (!recipientClient) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Recipient not found or offline'
      }));
      return;
    }
    
    const senderUsername = this.usernameStore.getUsername(client.address) || 'anonymous';
    const timestamp = Date.now();
    
    // Send message to recipient
    recipientClient.ws.send(JSON.stringify({
      type: 'direct-message',
      from: client.address || 'anonymous',
      fromUsername: senderUsername,
      message: message.trim(),
      timestamp
    }));
    
    // Send acknowledgment to sender
    client.ws.send(JSON.stringify({
      type: 'direct-message-ack',
      to: recipientClient.address || recipientId,
      toUsername: this.usernameStore.getUsername(recipientClient.address) || recipient,
      message: message.trim(),
      timestamp
    }));
  }

  async handleStreamJoined(client, data) {
    // Handle when a user confirms they've joined a stream
    // This is similar to viewer-join but might be used for different purposes
    const { streamId, roomId } = data;
    const targetStreamId = streamId || roomId;
    
    if (!targetStreamId) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Stream ID required'
      }));
      return;
    }
    
    // Check if stream exists
    const streamInfo = this.activeStreams.get(targetStreamId);
    if (!streamInfo) {
      client.ws.send(JSON.stringify({
        type: 'error',
        message: 'Stream not found'
      }));
      return;
    }
    
    // Track that this client joined the stream
    if (!client.joinedStreams) {
      client.joinedStreams = new Set();
    }
    client.joinedStreams.add(targetStreamId);
    
    // Add to stream room
    const room = this.streamRooms.get(targetStreamId);
    if (room) {
      room.addViewer(client.id, {
        ws: client.ws,
        address: client.address,
        username: this.usernameStore.getUsername(client.address) || 'anonymous',
        joinedAt: Date.now()
      });
    }
    
    // Send acknowledgment with stream details
    client.ws.send(JSON.stringify({
      type: 'stream-joined-ack',
      streamId: targetStreamId,
      streamInfo: {
        title: streamInfo.title,
        streamer: streamInfo.streamer,
        username: streamInfo.username,
        description: streamInfo.description,
        quality: streamInfo.quality,
        startedAt: streamInfo.startedAt
      },
      timestamp: Date.now()
    }));
    
    // Notify streamer about the viewer
    const streamerClient = this.clients.get(streamInfo.clientId);
    if (streamerClient) {
      const viewerUsername = this.usernameStore.getUsername(client.address) || 'anonymous';
      streamerClient.ws.send(JSON.stringify({
        type: 'stream-notification',
        action: 'viewer-joined',
        streamId: targetStreamId,
        viewer: client.address || 'anonymous',
        viewerUsername,
        timestamp: Date.now()
      }));
    }
    
    // Broadcast to other viewers that someone joined
    for (const [clientId, otherClient] of this.clients) {
      if (clientId !== client.id && clientId !== streamInfo.clientId && 
          otherClient.joinedStreams && otherClient.joinedStreams.has(targetStreamId)) {
        const joinerUsername = this.usernameStore.getUsername(client.address) || 'anonymous';
        otherClient.ws.send(JSON.stringify({
          type: 'stream-notification',
          action: 'user-joined',
          streamId: targetStreamId,
          user: client.address || 'anonymous',
          username: joinerUsername,
          timestamp: Date.now()
        }));
      }
    }
  }

  // Helper function to find WebSocket by address or ID
  findWebSocketByAddress(addressOrId) {
    if (!addressOrId) return null;
    
    // First try to find by address using the mapping
    const clientId = this.addressToClientId.get(addressOrId);
    if (clientId) {
      return this.clients.get(clientId);
    }
    
    // If not found by address, try by client ID directly
    const clientById = this.clients.get(addressOrId);
    if (clientById) {
      return clientById;
    }
    
    // Fallback: search all clients (for backwards compatibility)
    for (const [id, client] of this.clients) {
      if (client.address && client.address.toLowerCase() === addressOrId.toLowerCase()) {
        return client;
      }
    }
    
    return null;
  }

  // Helper methods for ICE candidate buffering
  getConnectionKey(to, from, streamId) {
    // Create a unique key for each peer connection
    // Normalize addresses to handle both directions
    const normalized = [to, from].sort().join(':');
    return `${normalized}:${streamId || 'default'}`;
  }

  shouldBufferIceCandidate(connectionKey) {
    // Check if we've already processed offer/answer for this connection
    // If the connection key exists in pendingIceCandidates, it means we're still buffering
    // If it doesn't exist yet, we should start buffering
    // If it exists but is null, offer/answer was already exchanged
    return !this.pendingIceCandidates.has(connectionKey) ||
           this.pendingIceCandidates.get(connectionKey) !== null;
  }

  flushPendingIceCandidates(to, from, streamId) {
    const connectionKey = this.getConnectionKey(to, from, streamId);
    const bufferedCandidates = this.pendingIceCandidates.get(connectionKey);

    if (bufferedCandidates && bufferedCandidates.length > 0) {
      console.log(`[ICE Buffer] Flushing ${bufferedCandidates.length} buffered candidates for ${connectionKey}`);

      // Find target client
      const targetClient = this.clients.get(to) || this.findWebSocketByAddress(to);

      if (targetClient && targetClient.ws.readyState === 1) {
        // Send all buffered candidates
        bufferedCandidates.forEach(candidate => {
          targetClient.ws.send(JSON.stringify(candidate));
        });
      }
    }

    // Mark this connection as having exchanged offer/answer by setting to null
    this.pendingIceCandidates.set(connectionKey, null);
  }

  // WebRTC signaling handlers
  async handleWebRTCRequest(client, data) {
    // Viewer requests offer from broadcaster
    console.log('[WebRTC Request]', {
      from: client.address || client.id,
      to: data.to,
      action: data.action,
      streamId: data.streamId
    });
    
    if (data.action === 'request-offer' && data.to) {
      // Forward request to broadcaster
      const targetClient = this.findWebSocketByAddress(data.to);
      if (targetClient && targetClient.ws.readyState === 1) {
        const message = {
          type: 'webrtc-request',
          action: 'request-offer',
          streamId: data.streamId,
          from: client.address || client.id, // Always use server's verified client info
          fromClientId: client.id, // Also send client ID for direct routing
          fromAddress: client.address // And address for convenience
        };
        console.log('[WebRTC Request] Forwarding to broadcaster:', message);
        targetClient.ws.send(JSON.stringify(message));
      } else {
        console.log('[WebRTC Request] Broadcaster not found:', data.to);
        client.ws.send(JSON.stringify({
          type: 'error',
          message: 'Broadcaster not found'
        }));
      }
    }
  }

  async handleWebRTCOffer(client, data) {
    // Broadcaster sends offer to viewer
    if (data.to) {
      // Always use server's verified client info, never trust client-provided 'from'
      const from = client.address || client.id;

      // Try by clientId first
      let targetClient = this.clients.get(data.to);
      if (targetClient && targetClient.ws.readyState === 1) {
        targetClient.ws.send(JSON.stringify({
          type: 'webrtc-offer',
          streamId: data.streamId,
          from: from,
          fromClientId: client.id,
          fromAddress: client.address,
          offer: data.offer
        }));

        // Flush any buffered ICE candidates for this connection
        this.flushPendingIceCandidates(data.to, from, data.streamId);
        return;
      }

      // Try sending by address if clientId failed
      const targetByAddress = this.findWebSocketByAddress(data.to);
      if (targetByAddress && targetByAddress.ws.readyState === 1) {
        targetByAddress.ws.send(JSON.stringify({
          type: 'webrtc-offer',
          streamId: data.streamId,
          from: from,
          fromClientId: client.id,
          fromAddress: client.address,
          offer: data.offer
        }));

        // Flush any buffered ICE candidates for this connection
        this.flushPendingIceCandidates(data.to, from, data.streamId);
      }
    }
  }

  async handleWebRTCAnswer(client, data) {
    // Viewer sends answer to broadcaster
    if (data.to) {
      // Always use server's verified client info
      const from = client.address || client.id;

      // Try by address first
      let targetClient = this.findWebSocketByAddress(data.to);
      if (targetClient && targetClient.ws.readyState === 1) {
        targetClient.ws.send(JSON.stringify({
          type: 'webrtc-answer',
          streamId: data.streamId,
          from: from,
          fromClientId: client.id,
          fromAddress: client.address,
          answer: data.answer
        }));

        // Flush any buffered ICE candidates for this connection
        this.flushPendingIceCandidates(data.to, from, data.streamId);
        return;
      }

      // Try sending by clientId if address failed
      const targetById = this.clients.get(data.to);
      if (targetById && targetById.ws.readyState === 1) {
        targetById.ws.send(JSON.stringify({
          type: 'webrtc-answer',
          streamId: data.streamId,
          from: from,
          fromClientId: client.id,
          fromAddress: client.address,
          answer: data.answer
        }));

        // Flush any buffered ICE candidates for this connection
        this.flushPendingIceCandidates(data.to, from, data.streamId);
      }
    }
  }

  async handleWebRTCIce(client, data) {
    // Exchange ICE candidates
    if (data.to) {
      // Always use server's verified client info
      const from = client.address || client.id;
      const connectionKey = this.getConnectionKey(data.to, from, data.streamId);

      // Try both clientId and address
      const targetClient = this.clients.get(data.to);
      const targetByAddress = this.findWebSocketByAddress(data.to);
      const target = (targetClient && targetClient.ws.readyState === 1) ? targetClient :
                     (targetByAddress && targetByAddress.ws.readyState === 1) ? targetByAddress : null;

      if (target) {
        // Check if we should buffer this ICE candidate (offer/answer not yet exchanged)
        if (this.shouldBufferIceCandidate(connectionKey)) {
          // Buffer the candidate
          if (!this.pendingIceCandidates.has(connectionKey)) {
            this.pendingIceCandidates.set(connectionKey, []);
          }
          this.pendingIceCandidates.get(connectionKey).push({
            type: 'webrtc-ice',
            streamId: data.streamId,
            from: from,
            fromClientId: client.id,
            fromAddress: client.address,
            candidate: data.candidate
          });
          console.log(`[ICE Buffer] Buffered candidate for ${connectionKey}, total: ${this.pendingIceCandidates.get(connectionKey).length}`);
        } else {
          // Send immediately - offer/answer already exchanged
          target.ws.send(JSON.stringify({
            type: 'webrtc-ice',
            streamId: data.streamId,
            from: from,
            fromClientId: client.id,
            fromAddress: client.address,
            candidate: data.candidate
          }));
        }
        return;
      }

      // If target not found, log detailed info
      console.warn(`[ICE] Failed to send ICE candidate to ${data.to}`);
      console.warn(`[ICE] Sender: ${client.id} (${client.address})`);
      console.warn(`[ICE] Available clients: ${Array.from(this.clients.keys()).join(', ')}`);
      console.warn(`[ICE] targetClient found: ${!!targetClient}, targetByAddress found: ${!!targetByAddress}`);
      if (targetClient) console.warn(`[ICE] targetClient readyState: ${targetClient.ws.readyState}`);
      if (targetByAddress) console.warn(`[ICE] targetByAddress readyState: ${targetByAddress.ws.readyState}`);
    }
  }

  // Debug handler to test message routing
  async handleDebugRoute(client, data) {
    const { to, message } = data;
    
    console.log(`Debug route from ${client.address || client.id} to ${to}`);
    console.log(`Connected clients:`, Array.from(this.clients.entries()).map(([id, c]) => ({
      id,
      address: c.address,
      authenticated: c.authenticated
    })));
    
    if (to) {
      const target = this.findWebSocketByAddress(to);
      if (target) {
        target.ws.send(JSON.stringify({
          type: 'debug-message',
          from: client.address || client.id,
          message: message || 'Debug test',
          timestamp: Date.now()
        }));
        
        client.ws.send(JSON.stringify({
          type: 'debug-route-ack',
          success: true,
          sentTo: to
        }));
      } else {
        client.ws.send(JSON.stringify({
          type: 'debug-route-ack',
          success: false,
          error: 'Target not found',
          availableClients: Array.from(this.clients.values()).map(c => c.address).filter(Boolean)
        }));
      }
    }
  }
  
  // Debug handler to list all connected clients
  async handleDebugClients(client) {
    const clientsList = Array.from(this.clients.entries()).map(([id, c]) => ({
      id,
      address: c.address,
      authenticated: c.authenticated,
      joinedStreams: c.joinedStreams ? Array.from(c.joinedStreams) : [],
      isStreaming: Array.from(this.activeStreams.values()).some(s => s.clientId === id)
    }));
    
    client.ws.send(JSON.stringify({
      type: 'debug-clients',
      clients: clientsList,
      totalCount: this.clients.size,
      authenticatedCount: clientsList.filter(c => c.authenticated).length
    }));
  }

  async handleRequestActiveStreams(client) {
    // Send list of active streams
    const streamsList = Array.from(this.activeStreams.values());
    client.ws.send(JSON.stringify({
      type: 'active-streams',
      activeStreams: streamsList
    }));
  }

  async handleRegisterAddress(client, data) {
    // Associate Ethereum address with client
    if (data.address) {
      client.address = data.address;
      this.addressToClientId.set(data.address, client.id);
      console.log(`Client ${client.id} registered with address ${data.address}`);
    }
  }

  async handleJoin(client, data) {
    // Handle room join
    if (data.room && data.userId) {
      client.room = data.room;
      client.userId = data.userId;
      console.log(`User ${data.userId} joined room ${data.room}`);
      
      // Notify other users in room
      const roomMembers = [];
      for (const [otherClientId, otherClient] of this.clients) {
        if (otherClient.room === data.room && otherClientId !== client.id) {
          roomMembers.push(otherClient.userId);
          otherClient.ws.send(JSON.stringify({
            type: 'user-joined',
            userId: data.userId
          }));
        }
      }
      
      // Send current room members to new user
      client.ws.send(JSON.stringify({
        type: 'room-members',
        members: roomMembers
      }));
    }
  }

  async handleLeave(client, data) {
    // Handle user leaving room
    if (client.room && client.userId) {
      for (const [otherClientId, otherClient] of this.clients) {
        if (otherClient.room === client.room && otherClientId !== client.id) {
          otherClient.ws.send(JSON.stringify({
            type: 'user-left',
            userId: client.userId
          }));
        }
      }
      client.room = null;
      client.userId = null;
    }
  }

  async handleRoomOffer(client, data) {
    // Forward offer to all users in room
    if (client.room && data.data) {
      for (const [otherClientId, otherClient] of this.clients) {
        if (otherClient.room === client.room && otherClientId !== client.id && otherClient.ws.readyState === 1) {
          otherClient.ws.send(JSON.stringify({
            type: 'offer',
            data: data.data,
            from: client.userId || client.id
          }));
        }
      }
    }
  }

  async handleRoomAnswer(client, data) {
    // Forward answer to all users in room
    if (client.room && data.data) {
      for (const [otherClientId, otherClient] of this.clients) {
        if (otherClient.room === client.room && otherClientId !== client.id && otherClient.ws.readyState === 1) {
          otherClient.ws.send(JSON.stringify({
            type: 'answer',
            data: data.data,
            from: client.userId || client.id
          }));
        }
      }
    }
  }

  async handleRoomIceCandidate(client, data) {
    // Forward ICE candidate to all users in room
    if (client.room && data.data) {
      for (const [otherClientId, otherClient] of this.clients) {
        if (otherClient.room === client.room && otherClientId !== client.id && otherClient.ws.readyState === 1) {
          otherClient.ws.send(JSON.stringify({
            type: 'ice-candidate',
            data: data.data,
            from: client.userId || client.id
          }));
        }
      }
    }
  }

  async handleTestRequestOffer(client, data) {
    // Test version of offer request
    if (data.to) {
      // Forward test request to target
      const targetClient = this.findWebSocketByAddress(data.to);
      if (targetClient && targetClient.ws.readyState === 1) {
        targetClient.ws.send(JSON.stringify({
          type: 'test-request-offer',
          streamId: data.streamId,
          from: data.from || client.address,
          clientId: client.id
        }));
      } else {
        client.ws.send(JSON.stringify({
          type: 'error',
          message: 'Target not found'
        }));
      }
    }
  }

  async handleEcho(client, data) {
    // Testing endpoint - echo back
    client.ws.send(JSON.stringify(data));
  }

  async handleBroadcastTest(client, data) {
    // Testing endpoint - broadcast to all
    const broadcastMessage = {
      type: 'broadcast-test',
      message: data.message,
      from: client.id
    };
    
    for (const [otherId, otherClient] of this.clients) {
      if (otherClient.ws.readyState === 1) {
        otherClient.ws.send(JSON.stringify(broadcastMessage));
      }
    }
  }

  async handleCheckAuth(client, data) {
    const { sessionToken } = data;
    
    console.log(`CheckAuth request from client ${client.id} with token: ${sessionToken}`);
    
    // Validate session with SessionManager
    const session = this.sessionManager.getSession(sessionToken);
    
    if (session) {
      console.log(`Session found for token ${sessionToken}:`, {
        address: session.address,
        username: session.username,
        age: Date.now() - session.createdAt
      });
      // Session is valid - update client state
      client.authenticated = true;
      client.address = session.address;
      client.sessionToken = sessionToken;
      client.authTimestamp = session.createdAt;
      
      // Get current username (might have changed)
      const username = this.usernameStore.getUsername(session.address);
      
      // Get recent messages for authenticated users
      const recentMessages = this.messageStore.getRecentMessages(50);
      const userCount = this.getActiveUserCount();
      
      client.ws.send(JSON.stringify({
        type: 'checkAuthResponse',
        authenticated: true,
        address: session.address,
        username,
        sessionToken: sessionToken,
        cooldownInfo: {
          changeCount: this.usernameStore.getChangeCount(session.address),
          canChange: this.usernameStore.canChangeUsername(session.address)
        },
        recentMessages,
        userCount
      }));
      
      // Update user count
      this.updateUserCount();
    } else {
      // Session not found or expired
      console.log(`Session NOT found for token ${sessionToken}`);
      console.log('Current sessions:', this.sessionManager.getStats());
      
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