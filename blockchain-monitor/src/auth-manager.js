import { ethers } from 'ethers';

export class AuthManager {
  constructor() {
    this.nonces = new Map();
  }

  generateNonce() {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  createAuthMessage(address, nonce) {
    const timestamp = Date.now();
    return `Sign this message to authenticate with the blockchain monitor service:\n\nAddress: ${address}\nNonce: ${nonce}\nTimestamp: ${timestamp}`;
  }

  async verifySignature(address, signature, message) {
    try {
      // Debug logging
      console.log('=== Authentication Debug ===');
      console.log('Address:', address);
      console.log('Message:', message);
      console.log('Signature:', signature);
      
      // Calculate message hash for debugging
      const messageHash = ethers.hashMessage(message);
      console.log('Message Hash:', messageHash);
      
      const recoveredAddress = ethers.verifyMessage(message, signature);
      console.log('Recovered Address:', recoveredAddress);
      console.log('Expected Address:', address);
      console.log('Addresses match:', recoveredAddress.toLowerCase() === address.toLowerCase());
      
      if (recoveredAddress.toLowerCase() !== address.toLowerCase()) {
        console.log('Authentication failed: Address mismatch');
        return false;
      }

      // Check if it's the simple format used by test clients
      if (message.startsWith('Sign this message to authenticate with the blockchain monitor at')) {
        // Extract timestamp from simple format
        const timestampMatch = message.match(/at (\d+)$/);
        if (timestampMatch) {
          const timestamp = parseInt(timestampMatch[1]);
          const maxAge = 5 * 60 * 1000; // 5 minutes
          
          if (Date.now() - timestamp > maxAge) {
            console.log('Authentication failed: Message expired');
            return false;
          }
          
          console.log('Authentication successful (simple format)');
          return true;
        }
      }
      
      // Check if it's the trollbox format
      if (message.includes('Sign this message to authenticate with the Noma Trollbox')) {
        // Extract timestamp from trollbox format
        const timestampMatch = message.match(/Timestamp: (\d+)/);
        if (timestampMatch) {
          const timestamp = parseInt(timestampMatch[1]);
          const maxAge = 5 * 60 * 1000; // 5 minutes
          
          if (Date.now() - timestamp > maxAge) {
            console.log('Authentication failed: Message expired');
            return false;
          }
          
          console.log('Authentication successful (trollbox format)');
          return true;
        }
      }
      
      // Original format with structured message
      const messageLines = message.split('\n');
      const addressLine = messageLines.find(line => line.startsWith('Address: '));
      const timestampLine = messageLines.find(line => line.startsWith('Timestamp: '));
      
      if (!addressLine || !timestampLine) {
        console.log('Authentication failed: Invalid message format');
        return false;
      }

      const messageAddress = addressLine.replace('Address: ', '');
      const timestamp = parseInt(timestampLine.replace('Timestamp: ', ''));

      if (messageAddress.toLowerCase() !== address.toLowerCase()) {
        console.log('Authentication failed: Address in message does not match');
        return false;
      }

      const maxAge = 5 * 60 * 1000;
      if (Date.now() - timestamp > maxAge) {
        console.log('Authentication failed: Message expired');
        return false;
      }

      console.log('Authentication successful (structured format)');
      return true;
    } catch (error) {
      console.error('Signature verification error:', error);
      return false;
    }
  }

  isValidAddress(address) {
    return ethers.isAddress(address);
  }
}