export class RateLimiter {
  constructor() {
    this.limits = new Map();
    this.windowMs = 60000; // 1 minute window
    this.maxRequests = {
      message: 10,    // 10 messages per minute
      auth: 5,        // 5 auth attempts per minute
      default: 30     // 30 requests per minute for other actions
    };
  }

  isRateLimited(identifier, action = 'default') {
    const key = `${identifier}:${action}`;
    const now = Date.now();
    
    if (!this.limits.has(key)) {
      this.limits.set(key, []);
    }
    
    const timestamps = this.limits.get(key);
    const windowStart = now - this.windowMs;
    
    // Clean old timestamps
    const validTimestamps = timestamps.filter(ts => ts > windowStart);
    this.limits.set(key, validTimestamps);
    
    // Check if rate limited
    const maxRequests = this.maxRequests[action] || this.maxRequests.default;
    if (validTimestamps.length >= maxRequests) {
      return true;
    }
    
    // Add current timestamp
    validTimestamps.push(now);
    return false;
  }

  getRemainingTime(identifier, action = 'default') {
    const key = `${identifier}:${action}`;
    const timestamps = this.limits.get(key) || [];
    
    if (timestamps.length === 0) return 0;
    
    const oldestTimestamp = Math.min(...timestamps);
    const timeUntilReset = (oldestTimestamp + this.windowMs) - Date.now();
    
    return Math.max(0, timeUntilReset);
  }

  reset(identifier, action = null) {
    if (action) {
      this.limits.delete(`${identifier}:${action}`);
    } else {
      // Reset all actions for this identifier
      for (const key of this.limits.keys()) {
        if (key.startsWith(`${identifier}:`)) {
          this.limits.delete(key);
        }
      }
    }
  }

  // Clean up old entries periodically
  cleanup() {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    
    for (const [key, timestamps] of this.limits.entries()) {
      const validTimestamps = timestamps.filter(ts => ts > windowStart);
      if (validTimestamps.length === 0) {
        this.limits.delete(key);
      } else {
        this.limits.set(key, validTimestamps);
      }
    }
  }
}