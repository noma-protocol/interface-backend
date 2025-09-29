# WebSocket Session Management Specification

## Overview
The WebSocket server now implements persistent session management that allows authenticated sessions to survive connection drops and reconnections. This improves user experience by eliminating the need to re-authenticate after temporary network issues.

## Architecture

### SessionManager Class
Location: `blockchain-monitor/src/session-manager.js`

The SessionManager is responsible for:
- Creating and storing sessions independently from WebSocket connections
- Validating session tokens
- Managing session expiration
- Automatic cleanup of expired sessions

### Session Structure
```javascript
{
  token: "uuid-v4-token",
  address: "0x...", // Ethereum address (lowercase)
  username: "user123",
  createdAt: 1234567890, // Timestamp
  lastActivity: 1234567890 // Updated on each validation
}
```

## API Flow

### Initial Authentication
1. Client connects to WebSocket
2. Client sends authentication request:
   ```json
   {
     "type": "auth",
     "address": "0x...",
     "signature": "0x...",
     "message": "Sign this message..."
   }
   ```
3. Server validates signature
4. Server creates session via SessionManager
5. Server responds with session token:
   ```json
   {
     "type": "authenticated",
     "success": true,
     "address": "0x...",
     "username": "user123",
     "sessionToken": "uuid-token",
     "cooldownInfo": {...}
   }
   ```

### Session Validation (Reconnection)
1. Client reconnects to WebSocket
2. Client sends session check:
   ```json
   {
     "type": "checkAuth",
     "sessionToken": "uuid-token"
   }
   ```
3. Server validates token with SessionManager
4. If valid, server responds:
   ```json
   {
     "type": "checkAuthResponse",
     "authenticated": true,
     "address": "0x...",
     "username": "user123",
     "sessionToken": "uuid-token",
     "cooldownInfo": {...}
   }
   ```
5. If invalid/expired:
   ```json
   {
     "type": "checkAuthResponse",
     "authenticated": false
   }
   ```

## Session Management Rules

### Session Lifecycle
- **Creation**: New session created on successful authentication
- **Duration**: 30 minutes from creation
- **Activity**: Last activity updated on each validation
- **Expiration**: Sessions expire after 30 minutes regardless of activity
- **Cleanup**: Expired sessions cleaned up every 5 minutes

### One Session Per Address
- Each Ethereum address can have only one active session
- New authentication overwrites existing session for the same address
- Prevents session accumulation from multiple devices/tabs

### Connection Independence
- Sessions are stored in memory separately from WebSocket connections
- Connection ID is not tied to session token
- Multiple connections can use the same session token
- Sessions survive connection drops, server reconnects

## Frontend Implementation Guidelines

### Session Storage
```javascript
// Store session token after authentication
localStorage.setItem('wsSessionToken', response.sessionToken);
```

### Connection Handling
```javascript
class WebSocketClient {
  async connect() {
    this.ws = new WebSocket(url);
    
    this.ws.onopen = async () => {
      // Check for existing session
      const sessionToken = localStorage.getItem('wsSessionToken');
      
      if (sessionToken) {
        // Try to resume session
        this.ws.send(JSON.stringify({
          type: 'checkAuth',
          sessionToken
        }));
      }
    };
  }
  
  handleMessage(data) {
    switch (data.type) {
      case 'checkAuthResponse':
        if (data.authenticated) {
          // Session valid, update UI
          this.setAuthenticated(data);
        } else {
          // Session invalid, clear and re-auth
          localStorage.removeItem('wsSessionToken');
          this.promptAuthentication();
        }
        break;
        
      case 'authenticated':
        // Store new session
        localStorage.setItem('wsSessionToken', data.sessionToken);
        this.setAuthenticated(data);
        break;
    }
  }
}
```

### Best Practices
1. Always check for existing session on connection
2. Store session token in persistent storage (localStorage)
3. Handle session expiration gracefully
4. Clear stored token on authentication failure
5. Don't send signature if you have a valid session token

## Server Statistics
Connection stats now include session information:
```javascript
{
  totalConnections: 3,
  authenticatedConnections: 2,
  uniqueIPs: 1,
  ipBreakdown: [...],
  sessions: {
    total: 2,
    active: 2,
    expired: 0
  }
}
```

## Security Considerations
- Sessions expire after 30 minutes for security
- Session tokens are UUIDs (cryptographically random)
- One session per address prevents session hijacking
- No session data persisted to disk (memory only)
- Sessions cleared on server restart