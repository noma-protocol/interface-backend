import { ethers } from 'ethers';

export class ResilientProvider extends ethers.JsonRpcProvider {
  constructor(url, network) {
    // Determine if it's a WebSocket URL
    const isWebSocket = url.startsWith('ws://') || url.startsWith('wss://');
    
    if (isWebSocket) {
      // Create WebSocket provider with automatic reconnection
      const wsProvider = new ethers.WebSocketProvider(url, network);
      
      // Set up reconnection logic
      wsProvider._websocket.on('close', () => {
        console.log('WebSocket connection closed, attempting to reconnect...');
        setTimeout(() => {
          wsProvider._start();
        }, 5000);
      });
      
      wsProvider._websocket.on('error', (error) => {
        console.error('WebSocket error:', error.message);
      });
      
      console.log('Using WebSocket RPC provider');
      return wsProvider;
    } else {
      // Standard HTTP provider
      console.log('Using HTTP RPC provider');
      super(url, network);
    }
  }
}

export function createProvider(url, network) {
  const isWebSocket = url.startsWith('ws://') || url.startsWith('wss://');
  
  if (isWebSocket) {
    console.log('Creating WebSocket provider for:', url);
    const provider = new ethers.WebSocketProvider(url, network);
    
    // Set up event listeners
    provider.on('error', (error) => {
      console.error('WebSocket provider error:', error);
    });
    
    // Handle reconnection
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;
    const reconnectDelay = 5000; // 5 seconds
    
    // WebSocketProvider automatically handles reconnection in ethers v6
    // We just need to listen for debug events to track the status
    provider.on('debug', (info) => {
      if (info.action === 'webSocketOpen') {
        console.log('WebSocket connection established');
        reconnectAttempts = 0;
      } else if (info.action === 'webSocketClose') {
        console.log('WebSocket connection closed');
      }
    });
    
    return provider;
  } else {
    console.log('Creating HTTP provider for:', url);
    return new ethers.JsonRpcProvider(url, network);
  }
}

// Helper to check if provider is connected
export async function checkProviderConnection(provider) {
  try {
    const network = await provider.getNetwork();
    console.log('Provider connected to network:', network.name, 'chainId:', network.chainId);
    return true;
  } catch (error) {
    console.error('Provider connection check failed:', error.message);
    return false;
  }
}