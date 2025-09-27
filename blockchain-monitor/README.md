# Blockchain Monitor WebSocket Server

A server-side blockchain event monitor that listens for events on Uniswap V3 pools and serves blockchain data via WebSocket to connected clients.

## Features

- Real-time blockchain event monitoring for multiple pools
- Persistent JSON-based event history storage
- WebSocket server for real-time event streaming
- Public access to blockchain data (no authentication required)
- Optional wallet signature-based authentication for chat features
- Client-specific event filtering
- Global trades aggregation across all pools

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables:
```bash
cp .env.example .env
```

Edit `.env` with your configuration:
- `RPC_URL`: Ethereum RPC endpoint
- `WEBSOCKET_PORT`: WebSocket server port (default: 8080)
- `HISTORY_FILE_PATH`: Path to store event history JSON file
- `POOL_ADDRESSES`: Comma-separated list of pool addresses to monitor (optional)

3. Start the server:
```bash
npm start
```

## WebSocket API

### Public Endpoints (No Authentication Required)

All blockchain data endpoints are publicly accessible:

- `subscribe` - Subscribe to pool events
- `getHistory` - Get historical events
- `getLatest` - Get recent events
- `getGlobalTrades` - Get aggregated trades from all pools

### Authentication (Optional)

Authentication is only required for chat features. Send wallet signature to authenticate:
```json
{
  "type": "auth",
  "address": "0x...",
  "signature": "0x...",
  "message": "Sign this message..."
}
```

### Subscribe to Pools

Subscribe to specific pools:
```json
{
  "type": "subscribe",
  "pools": ["0x...", "0x..."]
}
```

### Get History

Retrieve historical events:
```json
{
  "type": "getHistory",
  "pools": ["0x..."],
  "startTime": 1234567890,
  "endTime": 1234567890,
  "limit": 1000
}
```

### Get Latest Events

Get most recent events:
```json
{
  "type": "getLatest",
  "limit": 100
}
```

### Get Global Trades

Get the last 50 trades across all pools:
```json
{
  "type": "getGlobalTrades",
  "limit": 50
}
```

Response includes trade information with formatted details:
```json
{
  "type": "globalTrades",
  "trades": [{
    "poolAddress": "0x...",
    "eventName": "Swap",
    "blockNumber": 12345,
    "transactionHash": "0x...",
    "args": { ... },
    "tradeInfo": {
      "type": "buy" | "sell",
      "amount0": "...",
      "amount1": "...",
      "sender": "0x...",
      "recipient": "0x..."
    }
  }],
  "count": 50
}
```

## Event Types Monitored

- Swap
- Mint
- Burn
- Collect
- Flash

## Architecture

- `blockchain-monitor.js`: Monitors blockchain for pool events
- `event-storage.js`: Manages persistent JSON storage
- `websocket-server.js`: Handles WebSocket connections and messaging
- `auth-manager.js`: Manages wallet signature authentication
- `referral-store.js`: Manages referral relationships and trade tracking
- `referral-tracker.js`: Tracks trades from referred users
- `http-server.js`: REST API for referrals and vault queries
- `vaults.js`: Service for querying Noma protocol vaults
- `index.js`: Main application entry point

## Additional APIs

The blockchain monitor includes HTTP REST APIs:

- **Referral API**: Track referral relationships and trade volumes
  - Documentation: [REFERRAL_API.md](./REFERRAL_API.md)
  - Base URL: `http://localhost:3004/api/referrals`

- **Vault API**: Query Noma protocol vault information
  - Documentation: [VAULT_API.md](./VAULT_API.md)
  - Base URL: `http://localhost:3004/vault`