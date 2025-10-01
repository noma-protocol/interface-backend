# Room-Level Chat API Specification

## Overview

The WebSocket server supports room-based chat functionality, allowing messages to be isolated to specific rooms. This enables separate chat contexts for streams, pools, direct messages, and other grouped conversations.

## Room Types

### 1. Global Room
- **Room ID**: No room field (null/undefined)
- **Description**: Default chat room accessible to all authenticated users
- **Auto-join**: No
- **Use case**: General trollbox chat

### 2. Stream Room
- **Room ID**: `stream:{streamId}`
- **Description**: Chat room for a specific live stream
- **Auto-join**: Yes (when joining stream via `viewer-join`)
- **Auto-leave**: Yes (when leaving stream via `viewer-leave`)
- **Use case**: Stream-specific chat for viewers and streamer

### 3. Pool Room
- **Room ID**: `pool:{poolAddress}`
- **Description**: Chat room for a specific trading pool
- **Auto-join**: No
- **Use case**: Pool-specific discussions

### 4. Direct Message Room
- **Room ID**: `dm:{sortedAddresses}` (e.g., `dm:0x123...0xabc`)
- **Description**: Private 1-on-1 chat between two users
- **Auto-join**: No
- **Use case**: Private messaging

### 5. Custom Room
- **Room ID**: Any string not matching above patterns
- **Description**: Custom chat rooms
- **Auto-join**: No
- **Use case**: Ad-hoc group chats

## Client → Server Messages

### Join Room

Join a chat room to send and receive messages.

```json
{
  "type": "join-room",
  "roomId": "stream:abc123"
}
```

**Parameters:**
- `roomId` (string, required): The room identifier to join

**Response:**
```json
{
  "type": "room-joined",
  "roomId": "stream:abc123",
  "memberCount": 5,
  "timestamp": 1234567890
}
```

**Errors:**
- Invalid room ID: Returns error message

**Side Effects:**
- Creates room if it doesn't exist
- Adds client to room members
- Broadcasts `room-member-joined` to other members

### Leave Room

Leave a chat room.

```json
{
  "type": "leave-room",
  "roomId": "stream:abc123"
}
```

**Parameters:**
- `roomId` (string, required): The room identifier to leave

**Response:**
```json
{
  "type": "room-left",
  "roomId": "stream:abc123",
  "timestamp": 1234567890
}
```

**Errors:**
- Invalid room ID: Returns error message
- Room not found: Returns error message

**Side Effects:**
- Removes client from room members
- Broadcasts `room-member-left` to remaining members
- Deletes room if empty (along with message history)

### Get Room Messages

Retrieve message history for a specific room.

```json
{
  "type": "getRoomMessages",
  "roomId": "stream:abc123",
  "limit": 50
}
```

**Parameters:**
- `roomId` (string, required): The room identifier
- `limit` (number, optional): Maximum messages to retrieve (default: 50)

**Response:**
```json
{
  "type": "room-messages",
  "roomId": "stream:abc123",
  "messages": [
    {
      "id": "1234567890-abc123",
      "username": "Alice",
      "address": "0x123...",
      "content": "Hello room!",
      "timestamp": 1234567890,
      "verified": true,
      "replyTo": null,
      "room": "stream:abc123"
    }
  ],
  "timestamp": 1234567890
}
```

**Errors:**
- Invalid room ID: Returns error message

**Notes:**
- Returns empty array if room has no messages
- Returns last N messages based on limit

### Send Room Message

Send a message to a specific room.

```json
{
  "type": "message",
  "content": "Hello everyone!",
  "room": "stream:abc123",
  "replyTo": "msg-id-123"
}
```

**Parameters:**
- `content` (string, required): Message content (max 500 characters)
- `room` (string, optional): Room ID to send message to. If omitted, sends to global chat
- `replyTo` (string, optional): ID of message being replied to

**Requirements:**
- Must be authenticated
- Must have joined the room (via `join-room` or auto-join)
- Subject to rate limiting (per-user)
- Cannot send if kicked/banned

**Response:**
Broadcasts to all room members:
```json
{
  "type": "message",
  "message": {
    "id": "1234567890-abc123",
    "username": "Alice",
    "address": "0x123...",
    "content": "Hello everyone!",
    "timestamp": 1234567890,
    "verified": true,
    "replyTo": "msg-id-123",
    "room": "stream:abc123"
  }
}
```

**Errors:**
- Not authenticated: Returns `requireAuth`
- Not in room: Returns error "You must join the room before sending messages"
- Rate limited: Returns error "Rate limit exceeded"
- Kicked: Returns error "You are temporarily banned"
- Invalid content: Returns error message

## Server → Client Messages

### Room Joined Confirmation

Sent to client after successfully joining a room.

```json
{
  "type": "room-joined",
  "roomId": "stream:abc123",
  "memberCount": 5,
  "timestamp": 1234567890
}
```

### Room Member Joined

Broadcast to existing room members when someone joins.

```json
{
  "type": "room-member-joined",
  "roomId": "stream:abc123",
  "memberId": "client-123",
  "memberAddress": "0x123...",
  "username": "Alice",
  "memberCount": 6,
  "timestamp": 1234567890
}
```

### Room Left Confirmation

Sent to client after leaving a room.

```json
{
  "type": "room-left",
  "roomId": "stream:abc123",
  "timestamp": 1234567890
}
```

### Room Member Left

Broadcast to remaining room members when someone leaves.

```json
{
  "type": "room-member-left",
  "roomId": "stream:abc123",
  "memberId": "client-123",
  "memberAddress": "0x123...",
  "username": "Alice",
  "memberCount": 5,
  "timestamp": 1234567890
}
```

### Room Message

Message sent within a room context.

```json
{
  "type": "message",
  "message": {
    "id": "1234567890-abc123",
    "username": "Alice",
    "address": "0x123...",
    "content": "Hello!",
    "timestamp": 1234567890,
    "verified": true,
    "replyTo": null,
    "room": "stream:abc123"
  }
}
```

**Note:** The `room` field distinguishes room messages from global messages.

### Room Messages History

Response containing room message history.

```json
{
  "type": "room-messages",
  "roomId": "stream:abc123",
  "messages": [...],
  "timestamp": 1234567890
}
```

## Auto-Join Behavior

### Stream Rooms

When a client sends `viewer-join`:

```json
{
  "type": "viewer-join",
  "streamId": "abc123"
}
```

The server automatically:
1. Joins the client to `stream:abc123` chat room
2. Returns `roomId` in the acknowledgment:

```json
{
  "type": "viewer-join-ack",
  "streamId": "abc123",
  "roomId": "stream:abc123",
  "streamInfo": {...},
  "timestamp": 1234567890
}
```

When a client sends `viewer-leave`, the server automatically leaves the stream's chat room.

## Server State

### Room Storage

```javascript
this.rooms = new Map(); // Map<roomId, Set<clientId>>
this.roomMessages = new Map(); // Map<roomId, Message[]>
```

**Room Members:**
- Stored as Set of client IDs
- Efficient membership checking
- Automatic cleanup on disconnect

**Room Messages:**
- Stored as array per room
- Limited to last 100 messages per room
- In-memory only (not persisted)
- Deleted when room is deleted

### Client Tracking

Each client object tracks:
```javascript
client.joinedRooms = new Set(); // Set of room IDs
```

## Cleanup Behavior

### Empty Rooms
- Rooms are automatically deleted when the last member leaves
- Associated message history is also deleted
- No persistence of empty rooms

### Client Disconnect
When a client disconnects:
1. Removed from all joined rooms
2. `room-member-left` broadcast to remaining members
3. Empty rooms are cleaned up
4. Stream chat rooms deleted if stream ends

### Stream End
When a stream ends:
1. Stream room (`stream:{streamId}`) is deleted
2. All message history for that room is deleted
3. Clients are not explicitly removed (handled on next action)

## Message Storage

### Per-Room History
- Each room maintains separate message history
- Maximum 100 messages per room (FIFO)
- Messages include `room` field
- Format identical to global messages plus room field

### Global Chat History
- Global messages (no room field) use existing MessageStore
- Persisted to `data/messages.json`
- Room messages are NOT persisted

## Authentication & Authorization

### Authentication Required
All room operations require authentication:
- `join-room`
- `leave-room`
- `getRoomMessages` (no explicit check, returns empty for non-existent rooms)
- `message` with room field

### Room Membership
- Must join room before sending messages
- No permission system (any authenticated user can join any room)
- No moderation controls per-room (uses global kick system)

## Rate Limiting

Room messages use the same rate limiting as global chat:
- Per-user, per-action limits
- Applies to `message` regardless of room
- Separate from other actions (username change, etc.)

## Error Handling

### Common Errors

**Invalid Room ID:**
```json
{
  "type": "error",
  "message": "Invalid room ID"
}
```

**Not Authenticated:**
```json
{
  "type": "requireAuth",
  "message": "Authentication required to send messages"
}
```

**Not in Room:**
```json
{
  "type": "error",
  "message": "You must join the room before sending messages"
}
```

**Room Not Found (leave-room only):**
```json
{
  "type": "error",
  "message": "Room not found"
}
```

## Implementation Notes

### Backward Compatibility
- Messages without `room` field use global chat (existing behavior)
- Existing clients continue to work without room support
- Room-aware clients can use both global and room chat

### Performance Considerations
- Room membership stored as Sets for O(1) lookups
- Message broadcasting only to room members (not all clients)
- Automatic cleanup prevents memory leaks

### Future Enhancements
- Persistent room message storage
- Room permissions/access control
- Room moderation controls
- Room metadata (description, created date, etc.)
- Private/public room flags
- Maximum room size limits
- Room discovery/listing API
