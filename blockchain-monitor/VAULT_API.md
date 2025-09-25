# Vault API Documentation

The blockchain monitor includes a vault querying system that provides information about Noma protocol vaults.

## Overview

The vault system allows you to:
- Query all vaults deployed through the Noma Factory contract
- Get vaults owned by a specific address
- Retrieve detailed information about each vault including TVL, token balances, and metadata

## Prerequisites

The vault service requires the RPC URL to be provided when starting the blockchain monitor. The service will not be available if no RPC URL is configured.

## REST API Endpoints

Base URL: `http://localhost:3004`

### Get Vault Information

Retrieve vault information from the Noma protocol.

**GET** `/vault`

#### Query Parameters

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| address | string | Filter vaults by vault address, token0, or token1 address | No |

#### Response Format

```json
[
  {
    // Vault identification
    "address": "0x...",                    // Vault contract address
    "deployer": "0x...",                   // Address that deployed the vault
    
    // Token information
    "tokenName": "Vault LP Token",         // LP token name
    "tokenSymbol": "VLT-LP",               // LP token symbol
    "tokenDecimals": "18",                 // LP token decimals (as string)
    
    // Token addresses
    "token0": "0x...",                     // Token 0 address
    "token1": "0x...",                     // Token 1 address
    
    // Associated contracts
    "presaleContract": "0x...",            // Presale contract address
    "stakingContract": "0x...",            // Staking contract address
    
    // Vault metrics (all values as strings due to BigInt conversion)
    "liquidityRatio": "1000000",           // Liquidity ratio
    "circulatingSupply": "3000000000000000000", // Circulating LP token supply
    "spotPriceX96": "79228162514264337593543950336", // Spot price in X96 format
    "anchorCapacity": "1000000000000000000", // Anchor capacity
    "floorCapacity": "500000000000000000",   // Floor capacity
    "newFloor": "100000000000000000",         // New floor value
    "totalInterest": "50000000000000000"      // Total interest earned (may be "0" for vaults without this field)
  }
]
```

#### Examples

**Get all vaults:**
```bash
curl http://localhost:3004/vault
```

**Get vaults for a specific address:**
```bash
curl http://localhost:3004/vault?address=0x1234567890123456789012345678901234567890
```

#### Response Codes

| Code | Description |
|------|-------------|
| 200 | Success - Returns array of vault information |
| 500 | Internal server error - Error fetching vault data |
| 503 | Service unavailable - Vault service not initialized (no RPC URL provided) |

## Error Responses

### Service Not Initialized
```json
{
  "error": "Vault service not initialized"
}
```
This error occurs when the blockchain monitor was started without an RPC URL.

### Internal Server Error
```json
{
  "error": "Internal server error",
  "details": "Error message details"
}
```
This error occurs when there's an issue fetching data from the blockchain.

## Implementation Details

### VaultService Class

The vault service uses the following approach:

1. **Get Deployers**: Queries the Noma Factory contract for all deployer addresses
2. **Get Vaults**: For each deployer, fetches their deployed vaults
3. **Get Vault Info**: For each vault, retrieves:
   - Vault description from the Factory contract (name, symbol, deployer, associated contracts)
   - Vault metrics from the Vault contract (liquidity ratio, capacities, interest)
   - Token pair information (addresses)
   - LP token metadata (name, symbol, decimals)
   - Circulating supply and price information

### Contract Addresses

The service uses deployment addresses from `assets/deployment.json`:
- **Chain ID**: 10143 (Monad testnet)
- **Factory Address**: Loaded from deployment configuration

### Performance Considerations

- Fetching all vaults makes multiple RPC calls and may take time with many vaults
- Consider implementing pagination for large numbers of vaults
- Results are not cached - each request queries the blockchain directly

## Environment Variables

To enable the vault service, ensure the RPC URL is provided:

```bash
RPC_URL=https://your-rpc-endpoint
```

## Integration Example

```javascript
// Fetch all vaults
const response = await fetch('http://localhost:3004/vault');
const vaults = await response.json();

// Fetch vaults for specific user
const userVaults = await fetch('http://localhost:3004/vault?address=0x...');
const vaults = await userVaults.json();

// Process vault data
console.log(`Found ${vaults.length} vaults`);
vaults.forEach(vault => {
  console.log(`Vault ${vault.tokenSymbol}: ${vault.address}`);
});
```

## Future Enhancements

Potential improvements for the vault API:

1. **Pagination**: Add limit/offset parameters for large vault lists
2. **Sorting**: Sort by TVL, name, or creation date
3. **Filtering**: Filter by minimum TVL, token pairs, etc.
4. **Caching**: Implement caching to reduce RPC calls
5. **Historical Data**: Track vault TVL over time
6. **WebSocket Updates**: Real-time vault updates via WebSocket