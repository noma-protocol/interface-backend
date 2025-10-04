import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load the data file
const dataFilePath = path.join(__dirname, '..', process.env.DATA_FILE || 'priceData_local.json');

async function testOHLCContinuity() {
  console.log('Testing OHLC continuity...\n');
  
  try {
    const data = await fs.readJson(dataFilePath);
    
    if (!data.pools) {
      console.error('No pools data found');
      return;
    }
    
    let totalIssues = 0;
    const poolCount = Object.keys(data.pools).length;
    
    console.log(`Checking ${poolCount} pools...\n`);
    
    // Check each pool
    for (const [poolAddress, poolData] of Object.entries(data.pools)) {
      let poolIssues = 0;
      
      console.log(`\nPool: ${poolAddress}`);
      console.log('='.repeat(60));
      
      // Check each interval
      for (const [interval, candles] of Object.entries(poolData.ohlc)) {
        if (!candles || candles.length < 2) {
          console.log(`  ${interval}: ${candles ? candles.length : 0} candles (skipping)`);
          continue;
        }
        
        let intervalIssues = 0;
        
        // Check continuity between consecutive candles
        for (let i = 1; i < candles.length; i++) {
          const prevCandle = candles[i - 1];
          const currCandle = candles[i];
          
          if (prevCandle.close !== currCandle.open) {
            intervalIssues++;
            console.log(`  ${interval} [${i}]: Discontinuity detected`);
            console.log(`    Previous close: ${prevCandle.close}`);
            console.log(`    Current open:   ${currCandle.open}`);
            console.log(`    Difference:     ${Math.abs(prevCandle.close - currCandle.open)}`);
          }
        }
        
        if (intervalIssues === 0) {
          console.log(`  ${interval}: ✓ ${candles.length} candles (continuous)`);
        } else {
          console.log(`  ${interval}: ✗ ${intervalIssues} discontinuities in ${candles.length} candles`);
          poolIssues += intervalIssues;
        }
      }
      
      if (poolIssues === 0) {
        console.log(`\nPool Result: ✓ All intervals continuous`);
      } else {
        console.log(`\nPool Result: ✗ ${poolIssues} total discontinuities found`);
      }
      
      totalIssues += poolIssues;
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('\nOVERALL RESULTS:');
    console.log('='.repeat(60));
    
    if (totalIssues === 0) {
      console.log('✓ ALL POOLS HAVE CONTINUOUS OHLC DATA');
    } else {
      console.log(`✗ FOUND ${totalIssues} TOTAL DISCONTINUITIES ACROSS ALL POOLS`);
      console.log('\nTo fix these issues, restart the price feed service.');
      console.log('The validation function will automatically correct discontinuities on startup.');
    }
    
  } catch (error) {
    console.error('Error reading data file:', error);
  }
}

// Run the test
testOHLCContinuity();