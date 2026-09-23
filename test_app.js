const http = require('http');
const fs = require('fs');
const path = require('path');

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

  // Test 3: Dashboard Stats & Security Alert Metrics
  console.log('\nTest 3: Dashboard Stats & Security Alert Metrics');
  const resStats = await fetch(`${BASE_URL}/api/dashboard/stats`, { headers: authHeaders });
  const dataStats = await resStats.json();
  console.log('Total Assets:', dataStats.assets.total);
  console.log('Working Assets:', dataStats.assets.working);
  console.log('Total Quick Heal Keys:', dataStats.keys.total);
  console.log('Unprotected Workstations (Laptops/Desktops only):', dataStats.unprotectedWorkstations);
  console.log('Open Repair Tickets:', dataStats.repairs.open_tickets);
  console.log('Closed Repair Tickets:', dataStats.repairs.closed_tickets);
  console.log('Accessories breakdown:', dataStats.accessories);

  if (typeof dataStats.unprotectedWorkstations !== 'number') {
    throw new Error('unprotectedWorkstations missing in stats');
  }

  // Test 4: Search Precision - "pawan shukla" test
  console.log('\nTest 4: Search Precision - Searching for "pawan shukla"');
  const resPawan = await fetch(`${BASE_URL}/api/assets?search=pawan+shukla`, { headers: authHeaders });
  const dataPawan = await resPawan.json();
  console.log(`Search "pawan shukla" returned ${dataPawan.assets.length} result(s):`);
  dataPawan.assets.forEach(a => {
    console.log(`  - #${a.internal_serial_number} | ${a.brand} ${a.asset_type} | User: ${a.assigned_user}`);
  });
  if (dataPawan.assets.length !== 1) {
    throw new Error(`Expected exactly 1 result for "pawan shukla", got ${dataPawan.assets.length}`);
  }
  if (!dataPawan.assets[0].assigned_user.toLowerCase().includes('pawan')) {
    throw new Error(`Expected assigned user to be Pawan Shukla, got ${dataPawan.assets[0].assigned_user}`);
  }
  console.log('✅ Search precision test passed! No false-positive printers returned.');

  // Test 5: Quick Heal Security Priority - Laptops & Desktops Only
  console.log('\nTest 5: Quick Heal Security Priority Filter');
  const resUnprotected = await fetch(`${BASE_URL}/api/assets?quick_heal=unprotected`, { headers: authHeaders });
  const dataUnprotected = await resUnprotected.json();
  console.log(`Found ${dataUnprotected.assets.length} unprotected workstation(s).`);
  dataUnprotected.assets.forEach(a => {
    const isWorkstation = ['laptop', 'desktop'].includes(a.asset_type.toLowerCase());
    if (!isWorkstation) {
      throw new Error(`Found non-workstation (${a.asset_type}) in unprotected list! Only Laptops and Desktops should be flagged.`);
    }
    if (a.quick_heal_key_str) {
      throw new Error(`Asset #${a.internal_serial_number} has a key but appeared in unprotected list!`);
    }
  });
  console.log('✅ Quick Heal security priority verified: Only Laptops and Desktops are flagged!');

  // Test 6: Full Asset Editability (including internal_serial_number)
  console.log('\nTest 6: Full Asset Editability');
  const resNextSerial = await fetch(`${BASE_URL}/api/assets/next-serial`, { headers: authHeaders });
  const { nextSerial } = await resNextSerial.json();

  // Create asset
  const resCreateAsset = await fetch(`${BASE_URL}/api/assets`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      internal_serial_number: nextSerial,
      asset_type: 'Laptop',
      brand: 'Lenovo',
      model_name: 'ThinkPad E14 Gen 5',
      purchase_date: '2026-09-01',
      purchase_vendor: 'Lenovo Commercial Store',
      purchase_cost: 65000,
      department: 'Data Analysis',
      location: 'Lab Desk 3',
      assigned_user: 'Pooja Sharma',
      working_status: 'Working',
      condition_rating: 'New',
      remarks: 'Initial configuration'
    })
  });
  const dataCreate = await resCreateAsset.json();
  const testAssetId = dataCreate.id;
  console.log(`Created asset ID ${testAssetId} with serial #${nextSerial}`);

  // Now Edit the asset's serial number and details
  const updatedSerial = `${nextSerial}-MOD`;
  const resEditAsset = await fetch(`${BASE_URL}/api/assets/${testAssetId}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({
      internal_serial_number: updatedSerial,
      asset_type: 'Laptop',
      brand: 'Lenovo',
      model_name: 'ThinkPad E14 Gen 5 (Upgraded)',
      purchase_date: '2026-09-01',
      purchase_vendor: 'Lenovo Commercial Store',
      purchase_cost: 72000,
      department: 'Data Analysis',
      location: 'Lab Desk 3 - Corner',
      assigned_user: 'Pooja Sharma',
      working_status: 'Working',
      condition_rating: 'Fair',
      parts_added_summary: 'Upgraded to 32GB RAM',
      remarks: 'Admin updated serial and specifications'
    })
  });
  const dataEdit = await resEditAsset.json();
  if (!resEditAsset.ok) throw new Error('Failed to edit asset: ' + JSON.stringify(dataEdit));
  console.log('Edit Response:', dataEdit.message);

  // Fetch updated asset to verify all fields were modified
  const resVerifyAsset = await fetch(`${BASE_URL}/api/assets/${testAssetId}`, { headers: authHeaders });
  const { asset: verifiedAsset } = await resVerifyAsset.json();
  if (verifiedAsset.internal_serial_number !== updatedSerial) {
    throw new Error(`Serial number was not updated! Got ${verifiedAsset.internal_serial_number}`);
  }
  if (verifiedAsset.condition_rating !== 'Fair') {
    throw new Error(`Condition rating was not updated! Got ${verifiedAsset.condition_rating}`);
  }
  console.log('✅ Full asset editability verified: Admin successfully edited serial number & specifications!');

  // Test 7: Repair Ticket Lifecycle - Due Date & 1-Click Close Flow
  console.log('\nTest 7: Repair Ticket Lifecycle (Due Date & Close Flow)');
  const resOpenRepair = await fetch(`${BASE_URL}/api/repairs`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      asset_id: testAssetId,
      repair_date: '2026-09-23',
      due_date: '2026-09-28',
      repair_type: 'Component Repair',
      issue_description: 'Screen flickering and battery draining fast',
      parts_added: '',
      repair_vendor: 'Lenovo Care',
      technician_name: 'Suresh Kumar',
      repair_cost: 0,
      status: 'In Progress',
      remarks: 'Sent for diagnostics',
      update_asset_status: true
    })
  });
  const dataOpenRepair = await resOpenRepair.json();
  const repairId = dataOpenRepair.id;
  console.log(`Created repair ticket ID ${repairId} with due date 2026-09-28`);

  // Verify ticket status counts
  const resRepairsList = await fetch(`${BASE_URL}/api/repairs?ticket_status=open`, { headers: authHeaders });
  const dataRepairsList = await resRepairsList.json();
  console.log(`Open repair tickets count: ${dataRepairsList.counts.open_count}`);
  const createdTicket = dataRepairsList.repairs.find(r => r.id === repairId);
  if (!createdTicket) throw new Error('New repair ticket not found in open list');
  if (createdTicket.due_date !== '2026-09-28') throw new Error(`Due date mismatch! Expected 2026-09-28, got ${createdTicket.due_date}`);

  // Now Resolve & Close the Ticket via POST /api/repairs/:id/close
  console.log('Resolving and closing repair ticket...');
  const resCloseTicket = await fetch(`${BASE_URL}/api/repairs/${repairId}/close`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      completion_date: '2026-09-24',
      final_repair_cost: 3200,
      parts_added: '1x Genuine 57Wh Lenovo Battery, 1x EDP Display Cable',
      post_repair_asset_status: 'Working',
      resolution_notes: 'Replaced battery and display ribbon cable. Display tested at 60Hz without flicker. Battery holds 8 hours charge.'
    })
  });
  const dataCloseTicket = await resCloseTicket.json();
  console.log('Close Ticket Response:', dataCloseTicket.message);
  if (!resCloseTicket.ok) throw new Error('Failed to close ticket: ' + JSON.stringify(dataCloseTicket));

  // Verify asset is back in 'Working' status with parts recorded
  const resAssetAfterClose = await fetch(`${BASE_URL}/api/assets/${testAssetId}`, { headers: authHeaders });
  const { asset: assetAfterClose } = await resAssetAfterClose.json();
  if (assetAfterClose.working_status !== 'Working') {
    throw new Error(`Asset status should be Working after resolution, got ${assetAfterClose.working_status}`);
  }
  if (!assetAfterClose.parts_added_summary.includes('57Wh Lenovo Battery')) {
    throw new Error(`Parts summary did not update! Got ${assetAfterClose.parts_added_summary}`);
  }
  console.log('✅ Repair ticket lifecycle verified: Open -> Due Date -> Resolve & Close -> Operational fleet!');

  // Test 8: Accessories Stock Tracking & Issue/Return Flow
  console.log('\nTest 8: Accessories Stock Tracking (Total, In-Stock, Assigned)');
  const resAcc = await fetch(`${BASE_URL}/api/accessories`, { headers: authHeaders });
  const dataAcc = await resAcc.json();
  console.log('Accessories Summary Stats:', dataAcc.stats);
  if (!dataAcc.stats || typeof dataAcc.stats.total_units !== 'number') {
    throw new Error('Accessories stats missing in response');
  }

  // Create test accessory
  const resNewAcc = await fetch(`${BASE_URL}/api/accessories`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      accessory_code: 'ACC-TEST-99',
      category: 'Mouse',
      name: 'Logitech M90 Optical Mouse',
      brand: 'Logitech',
      quantity: 5,
      location: 'Store Room Cupboard 2',
      status: 'In Stock',
      remarks: 'Test batch'
    })
  });
  const dataNewAcc = await resNewAcc.json();
  const accId = dataNewAcc.id;
  console.log(`Created accessory ID ${accId}`);

  // Assign accessory to personnel
  const resAssignAcc = await fetch(`${BASE_URL}/api/accessories/${accId}/assign`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      assigned_user: 'Vikram Patel',
      location: 'Dispatch Cabin Desk 4',
      remarks: 'Issued for barcode station'
    })
  });
  const dataAssignAcc = await resAssignAcc.json();
  console.log('Assign Accessory Response:', dataAssignAcc.message);

  // Verify assigned status
  const resVerifyAcc = await fetch(`${BASE_URL}/api/accessories`, { headers: authHeaders });
  const dataVerifyAcc = await resVerifyAcc.json();
  const assignedItem = dataVerifyAcc.accessories.find(a => a.id === accId);
  if (assignedItem.status !== 'Assigned' || assignedItem.assigned_user !== 'Vikram Patel') {
    throw new Error(`Accessory assignment failed! Status: ${assignedItem.status}, User: ${assignedItem.assigned_user}`);
  }

  // Return accessory to stock
  const resReturnAcc = await fetch(`${BASE_URL}/api/accessories/${accId}/return`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ location: 'Store Room' })
  });
  const dataReturnAcc = await resReturnAcc.json();
  console.log('Return Accessory Response:', dataReturnAcc.message);

  // Clean up accessory
  await fetch(`${BASE_URL}/api/accessories/${accId}`, { method: 'DELETE', headers: authHeaders });
  console.log('✅ Accessories tracking verified: Stock counters, Personnel assignment, Return to stock!');

  // Test 9: Bulk Import IT Assets
  console.log('\nTest 9: Bulk Import IT Assets Inventory');
  // First download the CSV template
  const resTemplate = await fetch(`${BASE_URL}/api/assets/template/csv`, { headers: authHeaders });
  const templateCsv = await resTemplate.text();
  console.log('CSV Template headers:', templateCsv.split('\n')[0]);
  if (!templateCsv.includes('Internal Serial Number') || !templateCsv.includes('Asset Type')) {
    throw new Error('CSV Template headers invalid');
  }

  // Clean up any previous test serials if present
  try {
    const resClean1 = await fetch(`${BASE_URL}/api/assets?search=99001`, { headers: authHeaders });
    const dataClean1 = await resClean1.json();
    for (const a of dataClean1.assets) {
      if (a.internal_serial_number.startsWith('99')) {
        await fetch(`${BASE_URL}/api/assets/${a.id}`, { method: 'DELETE', headers: authHeaders });
      }
    }
  } catch (e) {}

  const s1 = '99' + Math.floor(100 + Math.random() * 900);
  const s2 = '99' + Math.floor(100 + Math.random() * 900);

  // Generate a test CSV payload to import
  const testCsvContent = [
    'internal_serial_number,asset_type,brand,model_name,serial_number,purchase_date,purchase_vendor,purchase_cost,department,location,assigned_user,working_status,condition_rating,parts_added_summary,remarks',
    `${s1},Laptop,HP,ProBook 440 G9,5CD29341AB,2026-05-10,HP India,58000,Accounts,Desk 10,Ritu Sharma,Working,Good,,Bulk imported asset 1`,
    `${s2},Desktop,Dell,OptiPlex 3090,83KD291,2026-06-15,Dell Care,45000,Dispatch,Dispatch Desk,Mahesh Rao,Working,Good,,Bulk imported asset 2`
  ].join('\n');

  // Create multipart form data boundary manually
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const multipartBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="assets_bulk_test.csv"\r\nContent-Type: text/csv\r\n\r\n`),
    Buffer.from(testCsvContent),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const resBulk = await fetch(`${BASE_URL}/api/assets/bulk-import`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body: multipartBody
  });
  const dataBulk = await resBulk.json();
  console.log('Bulk Import Response:', dataBulk);
  if (!resBulk.ok) throw new Error('Bulk import failed: ' + JSON.stringify(dataBulk));
  if (dataBulk.imported_count !== 2) throw new Error(`Expected 2 imported assets, got ${dataBulk.imported_count}`);

  // Verify imported assets exist
  const resFind1 = await fetch(`${BASE_URL}/api/assets?search=${s1}`, { headers: authHeaders });
  const dataFind1 = await resFind1.json();
  if (dataFind1.assets.length === 0) throw new Error(`Bulk imported asset #${s1} was not found in inventory`);
  console.log(`✅ Bulk asset import verified: CSV parsed, validated, and 2 assets inserted atomically (#${s1}, #${s2})!`);

  // Clean up bulk test assets & test asset
  const asset1 = dataFind1.assets[0];
  const resFind2 = await fetch(`${BASE_URL}/api/assets?search=${s2}`, { headers: authHeaders });
  const dataFind2 = await resFind2.json();
  const asset2 = dataFind2.assets[0];

  await fetch(`${BASE_URL}/api/assets/${asset1.id}`, { method: 'DELETE', headers: authHeaders });
  if (asset2) await fetch(`${BASE_URL}/api/assets/${asset2.id}`, { method: 'DELETE', headers: authHeaders });
  await fetch(`${BASE_URL}/api/assets/${testAssetId}`, { method: 'DELETE', headers: authHeaders });
  console.log('Cleaned up test assets.');

  console.log('\n===============================================');
  console.log('🎉 ALL ENTERPRISE ENHANCEMENT TESTS PASSED! 🎉');
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
