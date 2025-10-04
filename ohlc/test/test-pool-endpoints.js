import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3001';
const DEFAULT_POOL = '0x222705B830a38654B46340A99F5F3f1718A5C95d';
const TEST_POOL = '0x1234567890123456789012345678901234567890';

async function testEndpoint(name, path, poolAddress = null) {
  try {
    const url = poolAddress 
      ? `${BASE_URL}${path}${path.includes('?') ? '&' : '?'}pool=${poolAddress}`
      : `${BASE_URL}${path}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    console.log(`\n✓ ${name}:`);
    if (poolAddress) {
      console.log(`  Pool: ${data.pool || 'Not returned'}`);
    }
    console.log(`  Status: ${response.status}`);
    console.log(`  Response:`, JSON.stringify(data).substring(0, 100) + '...');
  } catch (error) {
    console.error(`\n✗ ${name}: ${error.message}`);
  }
}

async function runTests() {
  console.log('Testing Pool Parameter Support\n');
  console.log('================================');
  
  // Test without pool parameter (should use default)
  console.log('\n1. Testing with default pool (no parameter):');
  await testEndpoint('GET /api/price', '/api/price');
  await testEndpoint('GET /api/price/latest', '/api/price/latest');
  await testEndpoint('GET /api/volume', '/api/volume');
  
  // Test with explicit default pool
  console.log('\n2. Testing with explicit default pool:');
  await testEndpoint('GET /api/price', '/api/price', DEFAULT_POOL);
  await testEndpoint('GET /api/price/latest', '/api/price/latest', DEFAULT_POOL);
  await testEndpoint('GET /api/volume', '/api/volume', DEFAULT_POOL);
  
  // Test with different pool address
  console.log('\n3. Testing with different pool address:');
  await testEndpoint('GET /api/price', '/api/price', TEST_POOL);
  await testEndpoint('GET /api/price/latest', '/api/price/latest', TEST_POOL);
  await testEndpoint('GET /api/volume', '/api/volume', TEST_POOL);
  
  // Test endpoints with required parameters
  console.log('\n4. Testing endpoints with required parameters:');
  await testEndpoint('GET /api/price/query', '/api/price/query?interval=1h', TEST_POOL);
  await testEndpoint('GET /api/price/ohlc', '/api/price/ohlc?interval=1h', TEST_POOL);
  await testEndpoint('GET /api/stats', '/api/stats?interval=24h', TEST_POOL);
  
  // Test invalid pool address
  console.log('\n5. Testing with invalid pool address:');
  await testEndpoint('GET /api/price', '/api/price', 'invalid-address');
}

// Wait a bit for server to be ready if just started
setTimeout(runTests, 1000);