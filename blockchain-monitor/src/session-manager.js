import { v4 as uuidv4 } from 'uuid';

export class SessionManager {
  constructor(maxSessionAge = 30 * 60 * 1000) { // 30 minutes default
    this.sessions = new Map();
    this.maxSessionAge = maxSessionAge;
    this.addressToToken = new Map(); // Track latest token per address
    
    // Cleanup expired sessions every 5 minutes
    setInterval(() => {
      this.cleanupExpiredSessions();
    }, 5 * 60 * 1000);
  }

  getOrCreateSession(address, username) {
    const normalizedAddress = address.toLowerCase();
    
    // Check if there's an existing valid session
    const existingToken = this.addressToToken.get(normalizedAddress);
    if (existingToken) {
      const existingSession = this.getSession(existingToken);
      if (existingSession) {
        console.log(`Found existing session for ${address}: ${existingToken}`);
        // Update username if it changed
        if (existingSession.username !== username) {
          existingSession.username = username;
        }
        return existingSession;
      }
    }
    
    // No valid session exists, create new one
    return this.createSession(address, username);
  }

  createSession(address, username) {
    const sessionToken = uuidv4();
    const session = {
      token: sessionToken,
      address: address.toLowerCase(),
      username,
      createdAt: Date.now(),
      lastActivity: Date.now()
    };
    
    this.sessions.set(sessionToken, session);
    this.addressToToken.set(address.toLowerCase(), sessionToken);
    
    console.log(`Created new session for ${address}: ${sessionToken}`);
    return session;
  }

  getSession(sessionToken) {
    const session = this.sessions.get(sessionToken);
    if (!session) return null;
    
    // Check if session is expired
    if (Date.now() - session.createdAt > this.maxSessionAge) {
      this.sessions.delete(sessionToken);
      return null;
    }
    
    // Update last activity
    session.lastActivity = Date.now();
    return session;
  }

  validateSession(sessionToken) {
    const session = this.getSession(sessionToken);
    return session !== null;
  }

  findSessionByAddress(address) {
    const normalizedAddress = address.toLowerCase();
    for (const [token, session] of this.sessions) {
      if (session.address === normalizedAddress) {
        // Check if expired
        if (Date.now() - session.createdAt > this.maxSessionAge) {
          this.sessions.delete(token);
          continue;
        }
        return token;
      }
    }
    return null;
  }

  updateSessionUsername(sessionToken, newUsername) {
    const session = this.getSession(sessionToken);
    if (session) {
      session.username = newUsername;
      return true;
    }
    return false;
  }

  removeSession(sessionToken) {
    return this.sessions.delete(sessionToken);
  }

  cleanupExpiredSessions() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [token, session] of this.sessions) {
      if (now - session.createdAt > this.maxSessionAge) {
        this.sessions.delete(token);
        // Also clean up address mapping
        const currentToken = this.addressToToken.get(session.address);
        if (currentToken === token) {
          this.addressToToken.delete(session.address);
        }
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.log(`Cleaned up ${cleaned} expired sessions`);
    }
  }

  getStats() {
    const now = Date.now();
    let active = 0;
    let expired = 0;
    
    for (const session of this.sessions.values()) {
      if (now - session.createdAt > this.maxSessionAge) {
        expired++;
      } else {
        active++;
      }
    }
    
    return {
      total: this.sessions.size,
      active,
      expired
    };
  }
}