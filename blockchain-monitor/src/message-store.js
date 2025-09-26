import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class MessageStore {
  constructor(filePath) {
    this.filePath = filePath || path.join(__dirname, '..', '..', 'data', 'messages.json');
    this.messages = [];
    this.maxMessages = 1000;
  }

  async initialize() {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      this.messages = JSON.parse(data).messages || [];
      console.log(`Loaded ${this.messages.length} messages from storage`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.messages = [];
        await this.save();
        console.log('Created new messages file');
      } else {
        throw error;
      }
    }
  }

  async save() {
    try {
      await fs.writeFile(this.filePath, JSON.stringify({ messages: this.messages }, null, 2));
    } catch (error) {
      console.error('Failed to save messages:', error);
    }
  }

  async addMessage(username, address, content, replyTo = null) {
    const message = {
      id: uuidv4(),
      username,
      address,
      content,
      timestamp: Date.now(),
      verified: true,
      replyTo
    };

    this.messages.push(message);
    
    // Keep only the latest messages
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }

    await this.save();
    return message;
  }

  getRecentMessages(limit = 50) {
    return this.messages.slice(-limit);
  }

  getAllMessages() {
    return [...this.messages];
  }

  getMessageById(id) {
    return this.messages.find(msg => msg.id === id);
  }
}