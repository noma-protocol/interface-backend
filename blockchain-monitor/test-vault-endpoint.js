import axios from 'axios';

async function testVaultEndpoint() {
  const baseUrl = 'http://localhost:3004';
  
  console.log('Testing vault endpoints...\n');
  
  try {
    // Test 1: Get all vaults
    console.log('1. Testing GET /vault (all vaults)');
    const allVaultsResponse = await axios.get(`${baseUrl}/vault`);
    console.log(`   Status: ${allVaultsResponse.status}`);
    console.log(`   Found ${allVaultsResponse.data.length} vaults`);
    if (allVaultsResponse.data.length > 0) {
      console.log('   Sample vault:', JSON.stringify(allVaultsResponse.data[0], null, 2));
    }
    console.log();
    
    // Test 2: Get vaults by specific address
    const testAddress = '0x1234567890123456789012345678901234567890';
    console.log(`2. Testing GET /vault?address=${testAddress}`);
    const addressVaultsResponse = await axios.get(`${baseUrl}/vault`, {
      params: { address: testAddress }
    });
    console.log(`   Status: ${addressVaultsResponse.status}`);
    console.log(`   Found ${addressVaultsResponse.data.length} vaults for address ${testAddress}`);
    console.log();
    
    // Test 3: Test health endpoint
    console.log('3. Testing GET /api/health');
    const healthResponse = await axios.get(`${baseUrl}/api/health`);
    console.log(`   Status: ${healthResponse.status}`);
    console.log(`   Response:`, healthResponse.data);
    
  } catch (error) {
    console.error('Error testing endpoints:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
  }
}

// Run the test
console.log('Make sure the blockchain-monitor service is running on port 3004\n');
testVaultEndpoint();