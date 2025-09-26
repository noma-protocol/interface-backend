import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class UsernameStore {
  constructor(filePath) {
    this.filePath = filePath || path.join(__dirname, '..', '..', 'data', 'usernames.json');
    this.usernames = new Map();
    this.cooldowns = new Map();
  }

  async initialize() {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(data);
      this.usernames = new Map(Object.entries(parsed.usernames || {}));
      console.log(`Loaded ${this.usernames.size} usernames from storage`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.usernames = new Map();
        await this.save();
        console.log('Created new usernames file');
      } else {
        throw error;
      }
    }
  }

  async save() {
    try {
      const data = {
        usernames: Object.fromEntries(this.usernames),
        lastUpdated: Date.now()
      };
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Failed to save usernames:', error);
    }
  }

  getUsername(address) {
    const lowercaseAddress = address.toLowerCase();
    const entry = this.usernames.get(lowercaseAddress);
    return entry ? entry.username : this.generateDefaultUsername(address);
  }

  generateDefaultUsername(address) {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  canChangeUsername(address) {
    const cooldownEnd = this.cooldowns.get(address.toLowerCase());
    if (!cooldownEnd) return true;
    return Date.now() >= cooldownEnd;
  }

  getChangeCount(address) {
    const entry = this.usernames.get(address.toLowerCase());
    return entry ? entry.changeCount : 0;
  }

  getCooldownDuration(changeCount) {
    // Exponential cooldown: 1m, 10m, 1h, 1d, 1w
    const durations = [
      60 * 1000,           // 1 minute
      10 * 60 * 1000,      // 10 minutes
      60 * 60 * 1000,      // 1 hour
      24 * 60 * 60 * 1000, // 1 day
      7 * 24 * 60 * 60 * 1000 // 1 week
    ];
    
    return durations[Math.min(changeCount, durations.length - 1)];
  }

  async setUsername(address, username) {
    const lowercaseAddress = address.toLowerCase();
    const currentEntry = this.usernames.get(lowercaseAddress) || { changeCount: 0 };
    
    if (!this.canChangeUsername(address)) {
      const cooldownEnd = this.cooldowns.get(lowercaseAddress);
      const remainingTime = cooldownEnd - Date.now();
      return {
        success: false,
        error: 'cooldown',
        remainingTime
      };
    }

    // Update username
    const newEntry = {
      username,
      changeCount: currentEntry.changeCount + 1,
      lastChanged: Date.now()
    };
    
    this.usernames.set(lowercaseAddress, newEntry);
    
    // Set cooldown
    const cooldownDuration = this.getCooldownDuration(newEntry.changeCount);
    this.cooldowns.set(lowercaseAddress, Date.now() + cooldownDuration);
    
    await this.save();
    
    return {
      success: true,
      username,
      cooldownDuration
    };
  }
}