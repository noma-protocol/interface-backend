import { WebSocketServer } from 'ws';
import { EventEmitter } from 'events';

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
  }

  start() {
    this.wss = new WebSocketServer({ port: this.port });

    this.wss.on('connection', (ws, req) => {
      console.log('New WebSocket connection');
      
      const clientId = this.generateClientId();
      const client = {
        id: clientId,
        ws,
        authenticated: false,
        address: null,
        pools: []
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
        console.log(`Client ${clientId} disconnected`);
      });

      ws.on('error', (error) => {
        console.error(`WebSocket error for client ${clientId}:`, error);
      });

      ws.send(JSON.stringify({
        type: 'connection',
        clientId,
        message: 'Connected to event stream'
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
        
        client.ws.send(JSON.stringify({
          type: 'auth',
          success: true,
          address
        }));
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
      
      const normalizedEventPool = event.poolAddress.toLowerCase();
      
      // If client has no specific subscriptions, they get ALL events
      // Otherwise, check if they're subscribed to this specific pool
      const isSubscribedToAll = client.pools.length === 0;
      const isSubscribedToThisPool = client.pools.includes(normalizedEventPool);
      
      if (isSubscribedToAll || isSubscribedToThisPool) {
        if (client.ws.readyState === 1) {
          client.ws.send(JSON.stringify({
            type: 'event',
            data: event
          }, bigIntReplacer));
        }
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

  stop() {
    if (this.wss) {
      this.wss.close();
      console.log('WebSocket server stopped');
    }
  }
}