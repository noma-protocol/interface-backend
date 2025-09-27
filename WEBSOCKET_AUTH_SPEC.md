# WebSocket Authentication Implementation Specification

## Overview

This document outlines the authentication implementation for the blockchain monitor WebSocket connection on the frontend. The system supports both authenticated and unauthenticated connections.

## Public Access (No Authentication Required)

The following blockchain data endpoints are publicly accessible without authentication:

- **Subscribe to Pools** - Monitor specific pool events
- **Get Event History** - Retrieve historical blockchain events
- **Get Latest Events** - Get recent blockchain events
- **Get Global Trades** - Access aggregated trade data from all pools
- **Receive Real-time Events** - Get live blockchain event streams

## Authenticated Access

Authentication is only required for interactive features:

- **Trollbox Chat** - Send and receive chat messages
- **Change Username** - Modify your display name

## Authentication Flow

### 1. Initial Connection

When establishing a WebSocket connection, the client receives a welcome message:

```javascript
{
  "type": "connection",
  "clientId": "client-1234567890-abc123xyz",
  "message": "Connected to blockchain event stream",
  "requiresAuth": false,
  "authMessage": "Authentication optional for public blockchain data"
}
```

### 2. Authentication Process

#### 2.1 Message Signing

The client must sign a message with their Ethereum wallet to authenticate:

```javascript
// Message format
const message = `Sign this message to authenticate with the blockchain monitor at ${Date.now()}`;

// Using ethers.js v6
const signer = await provider.getSigner();
const signature = await signer.signMessage(message);
const address = await signer.getAddress();
```

#### 2.2 Sending Authentication

Send the authentication data to the WebSocket server:

```javascript
const authMessage = {
  type: 'auth',
  address: address,
  signature: signature,
  message: message
};

websocket.send(JSON.stringify(authMessage));
```

#### 2.3 Authentication Response

The server responds with authentication status:

**Success Response:**
```javascript
{
  "type": "authenticated",
  "success": true,
  "address": "0x742d35Cc6634C0532925a3b844Bc9e7595f8f852",
  "username": "anon-7595f8f852",
  "sessionToken": "550e8400-e29b-41d4-a716-446655440000",
  "cooldownInfo": {
    "changeCount": 0,
    "canChange": true
  }
}
```

**Failure Response:**
```javascript
{
  "type": "auth",
  "success": false,
  "error": "Invalid signature"
}
```

## Frontend Implementation

### 1. WebSocket Connection Manager

```javascript
class BlockchainWebSocket {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.isAuthenticated = false;
    this.clientId = null;
    this.sessionToken = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 3000;
    this.eventHandlers = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
        
        this.ws.onopen = () => {
          console.log('WebSocket connected');
          this.reconnectAttempts = 0;
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(JSON.parse(event.data));
        };

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          reject(error);
        };

        this.ws.onclose = () => {
          console.log('WebSocket disconnected');
          this.handleDisconnect();
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  handleMessage(message) {
    switch (message.type) {
      case 'connection':
        this.clientId = message.clientId;
        this.emit('connected', message);
        break;
        
      case 'authenticated':
        this.isAuthenticated = true;
        this.sessionToken = message.sessionToken;
        this.emit('authenticated', message);
        break;
        
      case 'auth':
        if (!message.success) {
          this.emit('authError', message.error);
        }
        break;
        
      case 'event':
        this.emit('blockchainEvent', message.data);
        break;
        
      case 'requireAuth':
        this.emit('authRequired', message);
        break;
        
      default:
        this.emit(message.type, message);
    }
  }

  async authenticate(provider) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    try {
      // Get signer from provider
      const signer = await provider.getSigner();
      const address = await signer.getAddress();
      
      // Create timestamp message
      const timestamp = Date.now();
      const message = `Sign this message to authenticate with the blockchain monitor at ${timestamp}`;
      
      // Sign message
      const signature = await signer.signMessage(message);
      
      // Send authentication
      this.send({
        type: 'auth',
        address,
        signature,
        message
      });
      
      // Wait for authentication response
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Authentication timeout'));
        }, 10000);
        
        this.once('authenticated', (data) => {
          clearTimeout(timeout);
          resolve(data);
        });
        
        this.once('authError', (error) => {
          clearTimeout(timeout);
          reject(new Error(error));
        });
      });
    } catch (error) {
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

  subscribe(pools = []) {
    this.send({
      type: 'subscribe',
      pools: pools
    });
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      throw new Error('WebSocket not connected');
    }
  }

  // Event emitter methods
  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(handler);
  }

  once(event, handler) {
    const onceHandler = (...args) => {
      handler(...args);
      this.off(event, onceHandler);
    };
    this.on(event, onceHandler);
  }

  off(event, handler) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    }
  }

  emit(event, data) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(handler => handler(data));
    }
  }

  handleDisconnect() {
    this.isAuthenticated = false;
    this.emit('disconnected');
    
    // Attempt to reconnect
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`Reconnecting... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
      
      setTimeout(() => {
        this.connect().catch(console.error);
      }, this.reconnectDelay);
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
```

### 2. React Hook Implementation

```javascript
import { useState, useEffect, useCallback, useRef } from 'react';
import { useWeb3 } from '@web3-react/core';

export function useBlockchainWebSocket(wsUrl) {
  const { provider, account } = useWeb3();
  const [isConnected, setIsConnected] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const wsRef = useRef(null);

  useEffect(() => {
    // Initialize WebSocket
    const ws = new BlockchainWebSocket(wsUrl);
    wsRef.current = ws;

    // Set up event handlers
    ws.on('connected', () => {
      setIsConnected(true);
      setError(null);
    });

    ws.on('disconnected', () => {
      setIsConnected(false);
      setIsAuthenticated(false);
    });

    ws.on('authenticated', (data) => {
      setIsAuthenticated(true);
      console.log('Authenticated as:', data.address);
    });

    ws.on('authError', (error) => {
      setError(`Authentication failed: ${error}`);
    });

    ws.on('blockchainEvent', (event) => {
      setEvents(prev => [...prev, event]);
    });

    // Connect
    ws.connect().catch(err => {
      setError(`Connection failed: ${err.message}`);
    });

    // Cleanup
    return () => {
      ws.disconnect();
    };
  }, [wsUrl]);

  const authenticate = useCallback(async () => {
    if (!wsRef.current || !provider) {
      setError('WebSocket not connected or no provider');
      return;
    }

    try {
      await wsRef.current.authenticate(provider);
    } catch (err) {
      setError(err.message);
    }
  }, [provider]);

  const subscribe = useCallback((pools) => {
    if (!wsRef.current) {
      setError('WebSocket not connected');
      return;
    }

    try {
      wsRef.current.subscribe(pools);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  return {
    isConnected,
    isAuthenticated,
    events,
    error,
    authenticate,
    subscribe,
    ws: wsRef.current
  };
}
```

### 3. React Component Example

```javascript
import React, { useEffect } from 'react';
import { useBlockchainWebSocket } from './useBlockchainWebSocket';

function BlockchainMonitor() {
  const {
    isConnected,
    isAuthenticated,
    events,
    error,
    authenticate,
    subscribe
  } = useBlockchainWebSocket('wss://your-websocket-server.com');

  useEffect(() => {
    if (isConnected && !isAuthenticated) {
      // Subscribe to public events without authentication
      subscribe(['0x123...', '0x456...']); // pool addresses
    }
  }, [isConnected, isAuthenticated, subscribe]);

  return (
    <div>
      <div className="status">
        <span>Connection: {isConnected ? 'Connected' : 'Disconnected'}</span>
        <span>Auth: {isAuthenticated ? 'Authenticated' : 'Not authenticated'}</span>
      </div>

      {error && (
        <div className="error">{error}</div>
      )}

      {isConnected && !isAuthenticated && (
        <button onClick={authenticate}>
          Authenticate with Wallet
        </button>
      )}

      <div className="events">
        <h3>Recent Events ({events.length})</h3>
        {events.map((event, index) => (
          <div key={index} className="event">
            <span>{event.eventName}</span>
            <span>{event.blockNumber}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

## Message Types

### Client to Server

1. **Authentication**
```javascript
{
  "type": "auth",
  "address": "0x...",
  "signature": "0x...",
  "message": "Sign this message..."
}
```

2. **Subscribe to Pools**
```javascript
{
  "type": "subscribe",
  "pools": ["0x123...", "0x456..."]
}
```

3. **Get History**
```javascript
{
  "type": "getHistory",
  "pools": ["0x123..."],
  "startTime": 1640995200000,
  "endTime": 1641081600000,
  "limit": 100
}
```

4. **Get Latest Events**
```javascript
{
  "type": "getLatest",
  "limit": 50
}
```

5. **Get Global Trades**
```javascript
{
  "type": "getGlobalTrades",
  "limit": 50
}
```

### Server to Client

1. **Connection Confirmation**
```javascript
{
  "type": "connection",
  "clientId": "client-123...",
  "message": "Connected to blockchain event stream",
  "requiresAuth": false
}
```

2. **Authentication Success**
```javascript
{
  "type": "authenticated",
  "success": true,
  "address": "0x...",
  "username": "user123",
  "sessionToken": "uuid"
}
```

3. **Blockchain Event**
```javascript
{
  "type": "event",
  "data": {
    "eventName": "Swap",
    "poolAddress": "0x...",
    "blockNumber": 12345678,
    "transactionHash": "0x...",
    "args": { ... }
  }
}
```

4. **Error**
```javascript
{
  "type": "error",
  "message": "Error description"
}
```

## Security Considerations

1. **Message Expiration**: Authentication messages include timestamps and expire after 5 minutes
2. **Signature Validation**: All signatures are validated against the claimed address
3. **Session Management**: Session tokens are generated server-side and should be stored securely
4. **Rate Limiting**: The server implements per-IP connection limits

## Best Practices

1. **Auto-reconnection**: Implement exponential backoff for reconnection attempts
2. **Error Handling**: Display user-friendly error messages for authentication failures
3. **State Management**: Use a state management solution (Redux, Zustand) for complex applications
4. **Performance**: Batch event updates to avoid excessive re-renders
5. **Security**: Never store private keys or signatures in application state

## Testing

```javascript
// Mock WebSocket for testing
class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = WebSocket.CONNECTING;
    setTimeout(() => {
      this.readyState = WebSocket.OPEN;
      this.onopen?.();
    }, 100);
  }

  send(data) {
    const message = JSON.parse(data);
    
    // Mock responses
    setTimeout(() => {
      if (message.type === 'auth') {
        this.onmessage?.({
          data: JSON.stringify({
            type: 'authenticated',
            success: true,
            address: message.address
          })
        });
      }
    }, 100);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  }
}

// Use in tests
global.WebSocket = MockWebSocket;
```

## Troubleshooting

1. **Connection Issues**
   - Check WebSocket URL protocol (ws:// for local, wss:// for HTTPS)
   - Verify server is running and accessible
   - Check for CORS issues

2. **Authentication Failures**
   - Ensure wallet is connected
   - Verify message format matches server expectations
   - Check signature encoding

3. **Event Reception**
   - Confirm subscription to correct pool addresses
   - Check authentication status for protected endpoints
   - Monitor browser console for WebSocket errors