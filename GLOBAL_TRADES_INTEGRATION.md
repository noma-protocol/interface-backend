# Global Trades Integration Guide

## Overview

The blockchain monitor WebSocket provides real-time global trade data from multiple DEX pools and the ExchangeHelper contract. This guide explains how to integrate and display global trades on your frontend.

**Important**: Global trades are publicly accessible and do **NOT** require authentication. Any connected client can request and receive trade data.

## What are Global Trades?

Global trades aggregate swap events from:
- **Uniswap V3 Pools**: Direct token swaps on specific pools
- **ExchangeHelper Events**: Buy/sell operations through the ExchangeHelper contract
  - `BoughtTokensETH`: Buying tokens with ETH
  - `BoughtTokensWETH`: Buying tokens with WETH
  - `SoldTokensETH`: Selling tokens for ETH
  - `SoldTokensWETH`: Selling tokens for WETH

## WebSocket API

### Requesting Global Trades

```javascript
// Request latest global trades
const request = {
  type: 'getGlobalTrades',
  limit: 50  // Optional, default is 50
};

websocket.send(JSON.stringify(request));
```

### Response Format

```javascript
{
  "type": "globalTrades",
  "trades": [
    {
      // Common fields for all trades
      "timestamp": 1641234567890,
      "blockNumber": 12345678,
      "transactionHash": "0x123...",
      "poolAddress": "0x456...",  // null for ExchangeHelper events
      "eventName": "Swap",        // or "BoughtTokensETH", etc.
      
      // Trade information
      "tradeInfo": {
        "type": "buy" | "sell",
        "trader": "0x789...",       // Actual trader address
        "amountIn": "1000000000000000000",  // Raw amount
        "amountOut": "2000000000",          // Raw amount
        "token0Symbol": "ETH",
        "token1Symbol": "USDC",
        "price": 2000.50,           // Calculated price
        "priceImpact": 0.15,        // Percentage
        "volumeUSD": 2000.50        // USD value
      }
    }
  ],
  "count": 50
}
```

## Frontend Implementation

### 1. Trade Data Store

```javascript
// Using Zustand for state management
import { create } from 'zustand';

const useTradeStore = create((set) => ({
  trades: [],
  isLoading: false,
  error: null,
  
  addTrade: (trade) => set((state) => ({
    trades: [trade, ...state.trades].slice(0, 100) // Keep latest 100
  })),
  
  addTrades: (trades) => set((state) => ({
    trades: [...trades, ...state.trades].slice(0, 100)
  })),
  
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error })
}));
```

### 2. Trade Processing Utilities

```javascript
import { ethers } from 'ethers';

// Format raw trade data for display
export function formatTrade(trade) {
  const { tradeInfo } = trade;
  
  return {
    ...trade,
    formattedAmountIn: formatTokenAmount(tradeInfo.amountIn, tradeInfo.token0Decimals || 18),
    formattedAmountOut: formatTokenAmount(tradeInfo.amountOut, tradeInfo.token1Decimals || 18),
    formattedPrice: formatPrice(tradeInfo.price),
    formattedVolume: formatUSD(tradeInfo.volumeUSD),
    formattedTime: formatTimestamp(trade.timestamp),
    txLink: getExplorerLink(trade.transactionHash),
    traderShort: shortenAddress(tradeInfo.trader),
    priceChangeClass: getPriceChangeClass(tradeInfo.type)
  };
}

// Helper functions
function formatTokenAmount(amount, decimals) {
  const value = ethers.formatUnits(amount, decimals);
  return parseFloat(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6
  });
}

function formatPrice(price) {
  if (!price) return '0.00';
  
  if (price < 0.01) {
    return price.toExponential(4);
  } else if (price < 1) {
    return price.toFixed(6);
  } else if (price < 1000) {
    return price.toFixed(4);
  } else {
    return price.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }
}

function formatUSD(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value || 0);
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffSecs = Math.floor(diffMs / 1000);
  
  if (diffSecs < 60) return `${diffSecs}s ago`;
  if (diffSecs < 3600) return `${Math.floor(diffSecs / 60)}m ago`;
  if (diffSecs < 86400) return `${Math.floor(diffSecs / 3600)}h ago`;
  
  return date.toLocaleDateString();
}

function shortenAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getExplorerLink(txHash) {
  // Update with your chain's explorer
  return `https://explorer.monad.xyz/tx/${txHash}`;
}

function getPriceChangeClass(type) {
  return type === 'buy' ? 'price-up' : 'price-down';
}
```

### 3. React Hook for Global Trades

```javascript
import { useEffect, useCallback } from 'react';
import { useTradeStore } from './tradeStore';
import { formatTrade } from './tradeUtils';

export function useGlobalTrades(websocket) {
  const { addTrade, addTrades, setLoading, setError } = useTradeStore();

  // Request initial trades when component mounts
  useEffect(() => {
    if (!websocket || !websocket.isConnected) return;

    setLoading(true);
    websocket.send({
      type: 'getGlobalTrades',
      limit: 50
    });
  }, [websocket?.isConnected]);

  // Handle incoming trade data
  useEffect(() => {
    if (!websocket) return;

    const handleGlobalTrades = (message) => {
      setLoading(false);
      if (message.trades) {
        const formattedTrades = message.trades.map(formatTrade);
        addTrades(formattedTrades);
      }
    };

    const handleNewTrade = (event) => {
      // Real-time trade from blockchain event
      if (event.tradeInfo) {
        const formattedTrade = formatTrade({
          ...event,
          timestamp: Date.now()
        });
        addTrade(formattedTrade);
      }
    };

    websocket.on('globalTrades', handleGlobalTrades);
    websocket.on('blockchainEvent', handleNewTrade);

    return () => {
      websocket.off('globalTrades', handleGlobalTrades);
      websocket.off('blockchainEvent', handleNewTrade);
    };
  }, [websocket, addTrade, addTrades, setLoading]);

  const refreshTrades = useCallback(() => {
    if (websocket?.isConnected) {
      websocket.send({
        type: 'getGlobalTrades',
        limit: 50
      });
    }
  }, [websocket]);

  return {
    trades: useTradeStore((state) => state.trades),
    isLoading: useTradeStore((state) => state.isLoading),
    error: useTradeStore((state) => state.error),
    refreshTrades
  };
}
```

### 4. Trade List Component

```javascript
import React from 'react';
import { useGlobalTrades } from './useGlobalTrades';

function GlobalTradesList({ websocket }) {
  const { trades, isLoading, error, refreshTrades } = useGlobalTrades(websocket);

  if (isLoading && trades.length === 0) {
    return <div className="loading">Loading trades...</div>;
  }

  if (error) {
    return <div className="error">{error}</div>;
  }

  return (
    <div className="trades-container">
      <div className="trades-header">
        <h2>Global Trades</h2>
        <button onClick={refreshTrades} className="refresh-btn">
          Refresh
        </button>
      </div>

      <div className="trades-table">
        <div className="table-header">
          <span>Time</span>
          <span>Type</span>
          <span>Token Pair</span>
          <span>Amount</span>
          <span>Price</span>
          <span>Volume</span>
          <span>Trader</span>
        </div>

        {trades.map((trade, index) => (
          <TradeRow key={`${trade.transactionHash}-${index}`} trade={trade} />
        ))}
      </div>
    </div>
  );
}

function TradeRow({ trade }) {
  const { tradeInfo } = trade;
  
  return (
    <div className={`trade-row ${tradeInfo.type}`}>
      <span className="time">{trade.formattedTime}</span>
      
      <span className={`type ${trade.priceChangeClass}`}>
        {tradeInfo.type.toUpperCase()}
      </span>
      
      <span className="pair">
        {tradeInfo.token0Symbol}/{tradeInfo.token1Symbol}
      </span>
      
      <span className="amount">
        <div>{trade.formattedAmountIn} {tradeInfo.token0Symbol}</div>
        <div className="secondary">{trade.formattedAmountOut} {tradeInfo.token1Symbol}</div>
      </span>
      
      <span className="price">
        {trade.formattedPrice}
        {tradeInfo.priceImpact > 0 && (
          <div className="price-impact">
            {tradeInfo.priceImpact.toFixed(2)}%
          </div>
        )}
      </span>
      
      <span className="volume">{trade.formattedVolume}</span>
      
      <span className="trader">
        <a 
          href={trade.txLink} 
          target="_blank" 
          rel="noopener noreferrer"
          title={tradeInfo.trader}
        >
          {trade.traderShort}
        </a>
      </span>
    </div>
  );
}
```

### 5. Advanced Trade Chart Component

```javascript
import React, { useMemo } from 'react';
import { Line } from 'react-chartjs-2';

function TradeVolumeChart({ trades }) {
  const chartData = useMemo(() => {
    // Group trades by hour
    const hourlyVolumes = trades.reduce((acc, trade) => {
      const hour = new Date(trade.timestamp);
      hour.setMinutes(0, 0, 0);
      const key = hour.toISOString();
      
      if (!acc[key]) {
        acc[key] = { buy: 0, sell: 0, total: 0 };
      }
      
      const volume = trade.tradeInfo.volumeUSD || 0;
      acc[key].total += volume;
      acc[key][trade.tradeInfo.type] += volume;
      
      return acc;
    }, {});

    const labels = Object.keys(hourlyVolumes).sort();
    const buyData = labels.map(key => hourlyVolumes[key].buy);
    const sellData = labels.map(key => hourlyVolumes[key].sell);

    return {
      labels: labels.map(date => 
        new Date(date).toLocaleTimeString([], { hour: '2-digit' })
      ),
      datasets: [
        {
          label: 'Buy Volume',
          data: buyData,
          borderColor: 'rgb(75, 192, 75)',
          backgroundColor: 'rgba(75, 192, 75, 0.1)',
        },
        {
          label: 'Sell Volume',
          data: sellData,
          borderColor: 'rgb(255, 99, 99)',
          backgroundColor: 'rgba(255, 99, 99, 0.1)',
        }
      ]
    };
  }, [trades]);

  const options = {
    responsive: true,
    plugins: {
      legend: {
        position: 'top',
      },
      title: {
        display: true,
        text: 'Hourly Trading Volume'
      }
    },
    scales: {
      y: {
        beginAtZero: true,
        ticks: {
          callback: (value) => `$${value.toLocaleString()}`
        }
      }
    }
  };

  return <Line data={chartData} options={options} />;
}
```

### 6. Trade Filtering and Search

```javascript
function TradeFilters({ onFilterChange }) {
  const [filters, setFilters] = useState({
    type: 'all', // all, buy, sell
    minVolume: 0,
    tokenSearch: '',
    poolAddress: ''
  });

  const handleFilterChange = (key, value) => {
    const newFilters = { ...filters, [key]: value };
    setFilters(newFilters);
    onFilterChange(newFilters);
  };

  return (
    <div className="trade-filters">
      <select 
        value={filters.type} 
        onChange={(e) => handleFilterChange('type', e.target.value)}
      >
        <option value="all">All Trades</option>
        <option value="buy">Buys Only</option>
        <option value="sell">Sells Only</option>
      </select>

      <input
        type="number"
        placeholder="Min Volume ($)"
        value={filters.minVolume}
        onChange={(e) => handleFilterChange('minVolume', parseFloat(e.target.value) || 0)}
      />

      <input
        type="text"
        placeholder="Search token..."
        value={filters.tokenSearch}
        onChange={(e) => handleFilterChange('tokenSearch', e.target.value)}
      />
    </div>
  );
}

// Filter trades based on criteria
function filterTrades(trades, filters) {
  return trades.filter(trade => {
    const { tradeInfo } = trade;
    
    if (filters.type !== 'all' && tradeInfo.type !== filters.type) {
      return false;
    }
    
    if (filters.minVolume > 0 && tradeInfo.volumeUSD < filters.minVolume) {
      return false;
    }
    
    if (filters.tokenSearch) {
      const search = filters.tokenSearch.toLowerCase();
      if (!tradeInfo.token0Symbol?.toLowerCase().includes(search) &&
          !tradeInfo.token1Symbol?.toLowerCase().includes(search)) {
        return false;
      }
    }
    
    return true;
  });
}
```

## Styling Examples

```css
/* Trade list styles */
.trades-container {
  background: #1a1a1a;
  border-radius: 8px;
  padding: 16px;
}

.trades-table {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.table-header,
.trade-row {
  display: grid;
  grid-template-columns: 80px 60px 120px 1fr 120px 100px 100px;
  padding: 8px 12px;
  align-items: center;
}

.table-header {
  font-weight: 600;
  color: #888;
  font-size: 12px;
  text-transform: uppercase;
}

.trade-row {
  background: #2a2a2a;
  border-radius: 4px;
  transition: background 0.2s;
}

.trade-row:hover {
  background: #333;
}

.trade-row.buy .type {
  color: #4caf50;
}

.trade-row.sell .type {
  color: #f44336;
}

.price-impact {
  font-size: 11px;
  color: #888;
}

.secondary {
  font-size: 12px;
  color: #888;
}

/* Animations */
@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.trade-row {
  animation: slideIn 0.3s ease-out;
}

/* Price change indicators */
.price-up::before {
  content: '▲';
  color: #4caf50;
  margin-right: 4px;
}

.price-down::before {
  content: '▼';
  color: #f44336;
  margin-right: 4px;
}
```

## Real-time Updates

To handle real-time trade updates efficiently:

```javascript
// Debounce trade updates to prevent excessive re-renders
import { debounce } from 'lodash';

const TradeUpdater = ({ websocket }) => {
  const [pendingTrades, setPendingTrades] = useState([]);
  const { addTrades } = useTradeStore();

  // Batch updates every 1 second
  const processPendingTrades = useCallback(
    debounce(() => {
      if (pendingTrades.length > 0) {
        addTrades(pendingTrades);
        setPendingTrades([]);
      }
    }, 1000),
    [pendingTrades]
  );

  useEffect(() => {
    processPendingTrades();
  }, [pendingTrades, processPendingTrades]);

  useEffect(() => {
    const handleTrade = (event) => {
      setPendingTrades(prev => [...prev, formatTrade(event)]);
    };

    websocket.on('blockchainEvent', handleTrade);
    return () => websocket.off('blockchainEvent', handleTrade);
  }, [websocket]);

  return null;
};
```

## Performance Considerations

1. **Virtual Scrolling**: For large trade lists, use react-window or react-virtualized
2. **Memoization**: Use React.memo and useMemo for expensive computations
3. **Batch Updates**: Group multiple trade updates together
4. **Limit History**: Keep only recent trades in memory (e.g., last 100-500)
5. **Web Workers**: Process large datasets in background threads

## Error Handling

```javascript
// Comprehensive error handling
const handleWebSocketError = (error) => {
  console.error('WebSocket error:', error);
  
  // Show user-friendly message
  if (error.code === 'ECONNREFUSED') {
    showNotification('Unable to connect to trade feed', 'error');
  } else if (error.code === 'ETIMEDOUT') {
    showNotification('Connection timeout. Retrying...', 'warning');
  } else {
    showNotification('Trade feed error. Please refresh.', 'error');
  }
};
```

## Testing Global Trades

```javascript
// Mock trade data for testing
export const mockTrades = [
  {
    timestamp: Date.now() - 30000,
    blockNumber: 12345678,
    transactionHash: '0x123...',
    poolAddress: '0x456...',
    eventName: 'Swap',
    tradeInfo: {
      type: 'buy',
      trader: '0x789...',
      amountIn: '1000000000000000000',
      amountOut: '2000000000',
      token0Symbol: 'ETH',
      token1Symbol: 'USDC',
      token0Decimals: 18,
      token1Decimals: 6,
      price: 2000.50,
      priceImpact: 0.15,
      volumeUSD: 2000.50
    }
  }
];

// Test component
function TestGlobalTrades() {
  const [trades, setTrades] = useState(mockTrades);
  
  // Simulate new trades
  useEffect(() => {
    const interval = setInterval(() => {
      const newTrade = {
        ...mockTrades[0],
        timestamp: Date.now(),
        transactionHash: `0x${Date.now()}`,
        tradeInfo: {
          ...mockTrades[0].tradeInfo,
          type: Math.random() > 0.5 ? 'buy' : 'sell',
          volumeUSD: Math.random() * 10000
        }
      };
      setTrades(prev => [newTrade, ...prev].slice(0, 50));
    }, 3000);
    
    return () => clearInterval(interval);
  }, []);
  
  return <GlobalTradesList trades={trades} />;
}
```