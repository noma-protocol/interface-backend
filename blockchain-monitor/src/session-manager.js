import { v4 as uuidv4 } from 'uuid';

export class SessionManager {
  constructor(maxSessionAge = 30 * 60 * 1000) { // 30 minutes default
    this.sessions = new Map();
    this.maxSessionAge = maxSessionAge;
    
    // Cleanup expired sessions every 5 minutes
    setInterval(() => {
      this.cleanupExpiredSessions();
    }, 5 * 60 * 1000);
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
    
    // Also store by address for easy lookup
    const existingToken = this.findSessionByAddress(address);
    if (existingToken) {
      this.sessions.delete(existingToken);
    }
    
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