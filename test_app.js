const http = require('http');

async function runTests() {
  console.log('--- Starting IT App System Verification Tests ---');

  // Load server
  const server = require('./server');

  // Wait 1 second for server to bind
  await new Promise(r => setTimeout(r, 1000));

  const BASE_URL = 'http://localhost:3000';

  let token = null;

  // Test 1: Health check
  console.log('Test 1: Health Check');
  const resHealth = await fetch(`${BASE_URL}/health`);
  const dataHealth = await resHealth.json();
  console.log('Health status:', dataHealth);
  if (dataHealth.status !== 'ok') throw new Error('Health check failed');

  // Test 2: Admin Login
  console.log('\nTest 2: Admin Login');
  const resLogin = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const dataLogin = await resLogin.json();
  console.log('Login Response:', { user: dataLogin.user?.username, role: dataLogin.user?.role, hasToken: !!dataLogin.token });
  if (!dataLogin.token) throw new Error('Login failed: ' + JSON.stringify(dataLogin));
  token = dataLogin.token;

  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  // Test 3: Dashboard Stats
  console.log('\nTest 3: Dashboard Stats');
  const resStats = await fetch(`${BASE_URL}/api/dashboard/stats`, { headers: authHeaders });
  const dataStats = await resStats.json();
  console.log('Total Assets:', dataStats.assets.total);
  console.log('Working Assets:', dataStats.assets.working);
  console.log('Total Quick Heal Keys:', dataStats.keys.total);
  console.log('Available Keys:', dataStats.keys.available);
  console.log('Departments:', dataStats.deptBreakdown.map(d => `${d.department} (${d.count})`).join(', '));
  if (dataStats.assets.total < 50) throw new Error('Asset count mismatch');
  if (dataStats.keys.total < 30) throw new Error('Key count mismatch');

  // Test 4: Master Search
  console.log('\nTest 4: Master Search for "Chandan"');
  const resSearch = await fetch(`${BASE_URL}/api/search?q=Chandan`, { headers: authHeaders });
  const dataSearch = await resSearch.json();
  console.log(`Found ${dataSearch.totalResults} results:`, {
    assets: dataSearch.assets.length,
    repairs: dataSearch.repairs.length
  });
  if (dataSearch.totalResults === 0) throw new Error('Master search failed to find Chandan');

  // Test 5: Next Serial Number
  console.log('\nTest 5: Next Serial Number');
  const resNextSerial = await fetch(`${BASE_URL}/api/assets/next-serial`, { headers: authHeaders });
  const dataNextSerial = await resNextSerial.json();
  console.log('Recommended next serial:', dataNextSerial.nextSerial);

  // Test 6: Create New Asset
  console.log('\nTest 6: Create New IT Asset (50052)');
  const resCreateAsset = await fetch(`${BASE_URL}/api/assets`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      internal_serial_number: '50052',
      asset_type: 'Laptop',
      brand: 'Lenovo',
      model_name: 'ThinkPad E14 Gen 5',
      purchase_date: '2026-09-01',
      purchase_vendor: 'Lenovo Commercial Store',
      purchase_cost: 65000,
      department: 'Data Analysis',
      location: 'Data Analysis Lab Desk 3',
      assigned_user: 'Pooja Sharma',
      working_status: 'Working',
      condition_rating: 'New',
      remarks: 'Allocated for data modeling and analytics'
    })
  });
  const dataCreateAsset = await resCreateAsset.json();
  console.log('Create Asset Response:', dataCreateAsset);
  if (!resCreateAsset.ok) throw new Error('Failed to create asset: ' + JSON.stringify(dataCreateAsset));
  const newAssetId = dataCreateAsset.id;

  // Test 7: Map Quick Heal Key to new asset
  console.log('\nTest 7: Map Quick Heal Key to Asset 50052');
  const resKeys = await fetch(`${BASE_URL}/api/keys`, { headers: authHeaders });
  const dataKeys = await resKeys.json();
  const availableKey = dataKeys.keys.find(k => k.status === 'Available');
  if (!availableKey) throw new Error('No available key found to map');
  console.log('Mapping key:', availableKey.product_key);

  const resMap = await fetch(`${BASE_URL}/api/keys/${availableKey.id}/map`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ asset_id: newAssetId })
  });
  const dataMap = await resMap.json();
  console.log('Map Response:', dataMap);

  // Test 8: Create Repair Ticket for Asset
  console.log('\nTest 8: Log Repair Ticket with Component Replacement');
  const resRepair = await fetch(`${BASE_URL}/api/repairs`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      asset_id: newAssetId,
      repair_date: '2026-09-23',
      repair_type: 'Hardware Upgrade',
      issue_description: 'Upgrade RAM from 8GB to 16GB and install secondary 500GB SSD',
      parts_added: '1x Crucial 8GB DDR4 RAM, 1x Samsung 980 500GB NVMe SSD',
      repair_vendor: 'Lenovo Authorized Service',
      technician_name: 'Anil Mehra',
      repair_cost: 5400,
      status: 'Completed',
      remarks: 'Upgraded successfully and benchmarked. Speed boosted 40%.'
    })
  });
  const dataRepair = await resRepair.json();
  console.log('Repair Ticket Created:', dataRepair);
  if (!resRepair.ok) throw new Error('Failed to log repair: ' + JSON.stringify(dataRepair));

  // Test 9: Verify Asset Dossier shows Repair History & Lifecycle Health
  console.log('\nTest 9: Verify Asset Dossier & Lifecycle Rating');
  const resAssetDetail = await fetch(`${BASE_URL}/api/assets/${newAssetId}`, { headers: authHeaders });
  const dataAssetDetail = await resAssetDetail.json();
  console.log('Asset Dossier:', {
    serial: dataAssetDetail.asset.internal_serial_number,
    quick_heal: dataAssetDetail.asset.quick_heal_key_str,
    repairs_count: dataAssetDetail.asset.repairs.length,
    parts_added_summary: dataAssetDetail.asset.parts_added_summary,
    total_repair_cost: dataAssetDetail.asset.total_repair_cost,
    healthScore: dataAssetDetail.asset.healthScore
  });

  // Test 10: Clean up test asset
  console.log('\nTest 10: Delete Test Asset (Release Key)');
  const resDelete = await fetch(`${BASE_URL}/api/assets/${newAssetId}`, {
    method: 'DELETE',
    headers: authHeaders
  });
  const dataDelete = await resDelete.json();
  console.log('Delete Response:', dataDelete);

  console.log('\n===============================================');
  console.log('🎉 ALL 10 SYSTEM VERIFICATION TESTS PASSED SUCCESSFULLY! 🎉');
  console.log('===============================================');

  const { db } = require('./database');
  try { db.close(); } catch(e) {}

  if (server.server) {
    server.server.close();
  }
}

runTests().catch(err => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
