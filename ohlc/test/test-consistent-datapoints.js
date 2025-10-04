import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:3001';
const TEST_POOL = '0xBb7EfF3E685c6564F2F09DD90b6C05754E3BDAC0';
const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '6h', '12h', '24h', '1w', '1M'];

async function testEndpoint(name, path) {
  try {
    const response = await fetch(`${BASE_URL}${path}`);
    const data = await response.json();
    return { name, status: response.status, data };
  } catch (error) {
    return { name, error: error.message };
  }
}

async function testDatapointConsistency() {
  console.log('Testing Datapoint Consistency Across Endpoints\n');
  console.log('==============================================\n');
  
  for (const interval of INTERVALS) {
    console.log(`\nTesting interval: ${interval}`);
    console.log('-------------------');
    
    const endpoints = [
      { name: '/api/price/:interval', path: `/api/price/${interval}?pool=${TEST_POOL}` },
      { name: '/api/price/query', path: `/api/price/query?interval=${interval}&pool=${TEST_POOL}` },
      { name: '/api/price/ohlc', path: `/api/price/ohlc?interval=${interval}&pool=${TEST_POOL}` },
      { name: '/api/price/ohlc/:interval', path: `/api/price/ohlc/${interval}?pool=${TEST_POOL}` }
    ];
    
    const results = await Promise.all(
      endpoints.map(({ name, path }) => testEndpoint(name, path))
    );
    
    // Check datapoint counts
    const counts = results.map(r => {
      if (r.error) return { endpoint: r.name, count: 'ERROR', error: r.error };
      
      // Extract count based on response structure
      let count = 0;
      if (r.data.ohlc) {
        count = r.data.ohlc.length;
      } else if (r.data.dataPoints) {
        count = r.data.dataPoints.length;
      } else if (r.data.count !== undefined) {
        count = r.data.count;
      }
      
      return { endpoint: r.name, count };
    });
    
    // Display results
    counts.forEach(({ endpoint, count, error }) => {
      if (error) {
        console.log(`  ${endpoint}: ERROR - ${error}`);
      } else {
        console.log(`  ${endpoint}: ${count} datapoints`);
      }
    });
    
    // Check consistency
    const validCounts = counts.filter(c => typeof c.count === 'number').map(c => c.count);
    const uniqueCounts = [...new Set(validCounts)];
    
    if (uniqueCounts.length === 1) {
      console.log(`  ✅ Consistent: All endpoints return ${uniqueCounts[0]} datapoints`);
    } else {
      console.log(`  ❌ Inconsistent: Different datapoint counts: ${uniqueCounts.join(', ')}`);
    }
  }
  
  // Test /api/price/all endpoint
  console.log('\n\nTesting /api/price/all endpoint');
  console.log('--------------------------------');
  
  const allResult = await testEndpoint('/api/price/all', `/api/price/all?pool=${TEST_POOL}`);
  if (allResult.data && allResult.data.intervals) {
    Object.entries(allResult.data.intervals).forEach(([interval, data]) => {
      const count = Array.isArray(data) ? data.length : 0;
      console.log(`  ${interval}: ${count} datapoints`);
    });
  }
}

// Wait a bit for server to be ready
setTimeout(testDatapointConsistency, 1000);