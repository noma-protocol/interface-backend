# Unified WebSocket Server Architecture

## Important: Server Consolidation

There are TWO WebSocket servers in this codebase:

1. **blockchain-monitor** (Port 8080) - The MAIN unified server with:
   - Blockchain event monitoring
   - Trollbox chat functionality
   - Unified authentication with SessionManager
   - Single WebSocket connection for all features

2. **trollbox-server** (Port 9090) - Legacy standalone trollbox server
   - Separate authentication system
   - Should NOT be used when blockchain-monitor is running

## Frontend Implementation

### ❌ INCORRECT - Using Two Separate Connections
```javascript
// DON'T DO THIS - Creates separate sessions
const blockchainWS = new WebSocket('ws://localhost:8080');
const trollboxWS = new WebSocket('ws://localhost:9090');
```

### ✅ CORRECT - Single Connection to Unified Server
```javascript
// Single WebSocket connection for everything
const ws = new WebSocket('ws://localhost:8080');

// Use for both blockchain events and trollbox
ws.send(JSON.stringify({ type: 'subscribe', pools: [...] })); // Blockchain
ws.send(JSON.stringify({ type: 'message', content: 'Hello' })); // Trollbox
```

## Message Types Supported by Unified Server (Port 8080)

### Authentication
- `auth` - Authenticate with signature
- `checkAuth` - Validate existing session

### Blockchain Monitoring
- `subscribe` - Subscribe to pool events
- `unsubscribe` - Unsubscribe from pools
- `getHistory` - Get historical events
- `getLatest` - Get latest events
- `getGlobalTrades` - Get global trade data

### Trollbox Chat
- `message` - Send chat message
- `changeUsername` - Change username
- `ping` - Keep connection alive

## Session Management

The unified server (blockchain-monitor) uses SessionManager which provides:
- Sessions persist across reconnections
- 30-minute session timeout
- Single sign-on for all features
- One session token works for both blockchain and chat

## Migration Guide

If your frontend currently connects to both servers:

1. Remove connection to `ws://localhost:9090`
2. Update all WebSocket connections to use `ws://localhost:8080`
3. Use the same authentication for both features
4. Store and reuse the session token from authentication

## Running the Correct Server

```bash
# Start the unified server (blockchain-monitor)
cd blockchain-monitor
npm start

# The trollbox-server should NOT be running simultaneously
```

## Environment Variables

For blockchain-monitor (`.env`):
```
RPC_URL=your_rpc_url
WEBSOCKET_PORT=8080
HTTP_PORT=3004
```

## Architecture Benefits

1. **Single Authentication** - Users sign once for all features
2. **Shared Session** - One session token for everything  
3. **Reduced Complexity** - One WebSocket connection instead of two
4. **Better Performance** - Less overhead, fewer connections
5. **Unified State** - Authentication state shared across features