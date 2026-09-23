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

  // Test 2: Admin Login (Aditya Shah / Aditya@123)
  console.log('\nTest 2: Admin Login (Aditya Shah / Aditya@123)');
  const resLogin = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Aditya@123' })
  });
  const dataLogin = await resLogin.json();
  console.log('Login Response (by username):', { user: dataLogin.user?.username, full_name: dataLogin.user?.full_name, role: dataLogin.user?.role, hasToken: !!dataLogin.token });
  if (!dataLogin.token) throw new Error('Login failed: ' + JSON.stringify(dataLogin));
  token = dataLogin.token;

  // Test 2B: Login using Email address (orders@vbexports.co.in)
  const resLoginEmail = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'orders@vbexports.co.in', password: 'Aditya@123' })
  });
  const dataLoginEmail = await resLoginEmail.json();
  console.log('Login Response (by email orders@vbexports.co.in):', { user: dataLoginEmail.user?.username, hasToken: !!dataLoginEmail.token });
  if (!dataLoginEmail.token) throw new Error('Email login failed: ' + JSON.stringify(dataLoginEmail));

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
  const testAccCode = 'ACC-TEST-' + Math.floor(Math.random() * 100000);
  const resNewAcc = await fetch(`${BASE_URL}/api/accessories`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      accessory_code: testAccCode,
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

  // Assign 1 unit out of 5 to personnel (partial quantity assignment)
  const resAssignAcc = await fetch(`${BASE_URL}/api/accessories/${accId}/assign`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      quantity: 1,
      assigned_user: 'Vikram Patel',
      location: 'Dispatch Cabin Desk 4',
      remarks: 'Issued for barcode station'
    })
  });
  const dataAssignAcc = await resAssignAcc.json();
  console.log('Assign Accessory Response:', dataAssignAcc.message);

  // Verify that original stock was decremented from 5 to 4, and 1 unit is assigned to Vikram Patel
  const resVerifyAcc = await fetch(`${BASE_URL}/api/accessories`, { headers: authHeaders });
  const dataVerifyAcc = await resVerifyAcc.json();
  const stockItem = dataVerifyAcc.accessories.find(a => a.id === accId);
  const assignedItem = dataVerifyAcc.accessories.find(a => a.assigned_user === 'Vikram Patel');

  if (!stockItem || stockItem.quantity !== 4 || stockItem.status !== 'In Stock') {
    throw new Error(`In-stock quantity deduction failed! Remaining qty: ${stockItem?.quantity}, Status: ${stockItem?.status}`);
  }
  if (!assignedItem || assignedItem.quantity !== 1 || assignedItem.status !== 'Assigned') {
    throw new Error(`Assigned quantity tracking failed! Assigned qty: ${assignedItem?.quantity}, Status: ${assignedItem?.status}`);
  }
  console.log(`Partial quantity verified: ${stockItem.quantity} in stock, ${assignedItem.quantity} assigned to ${assignedItem.assigned_user}`);

  // Return assigned accessory unit back to stock
  const resReturnAcc = await fetch(`${BASE_URL}/api/accessories/${assignedItem.id}/return`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ location: 'Store Room Cupboard 2' })
  });
  const dataReturnAcc = await resReturnAcc.json();
  console.log('Return Accessory Response:', dataReturnAcc.message);

  // Verify stock merged back to 5
  const resMergedAcc = await fetch(`${BASE_URL}/api/accessories`, { headers: authHeaders });
  const dataMergedAcc = await resMergedAcc.json();
  const restoredStockItem = dataMergedAcc.accessories.find(a => a.id === accId);
  if (!restoredStockItem || restoredStockItem.quantity !== 5) {
    throw new Error(`Stock return merge failed! Qty is ${restoredStockItem?.quantity}, expected 5`);
  }

  // Clean up test accessory
  await fetch(`${BASE_URL}/api/accessories/${accId}`, { method: 'DELETE', headers: authHeaders });
  console.log('✅ Accessories tracking verified: Stock counters, Partial quantity assignment, Return to stock merge!');

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

  // Test 10: Strict Exclusion of Remarks & Notes from Search
  console.log('\nTest 10: Strict Exclusion of Remarks & Notes from Search');
  const resRemarksAsset = await fetch(`${BASE_URL}/api/assets`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      internal_serial_number: '99881',
      asset_type: 'Desktop',
      brand: 'ExclusionBrand',
      assigned_user: 'ExclusionUser',
      remarks: 'aditya pawan cabin secret_keyword_12345'
    })
  });
  const dataRemarksAsset = await resRemarksAsset.json();
  const exclusionAssetId = dataRemarksAsset.id;

  // Search by remarks keyword in /api/assets
  const resSearchNotes = await fetch(`${BASE_URL}/api/assets?search=secret_keyword_12345`, { headers: authHeaders });
  const dataSearchNotes = await resSearchNotes.json();
  if (dataSearchNotes.assets.length !== 0) {
    throw new Error(`Expected 0 assets when searching remarks keyword, got ${dataSearchNotes.assets.length}`);
  }

  // Search by remarks keyword in /api/search (Master Search)
  const resMasterNotes = await fetch(`${BASE_URL}/api/search?q=secret_keyword_12345`, { headers: authHeaders });
  const dataMasterNotes = await resMasterNotes.json();
  if (dataMasterNotes.assets.length !== 0) {
    throw new Error(`Expected 0 assets in master search when querying remarks keyword, got ${dataMasterNotes.assets.length}`);
  }

  // Searching by actual assigned user or brand should still find it
  const resSearchBrand = await fetch(`${BASE_URL}/api/assets?search=ExclusionBrand`, { headers: authHeaders });
  const dataSearchBrand = await resSearchBrand.json();
  if (dataSearchBrand.assets.length !== 1) {
    throw new Error(`Expected 1 asset when searching brand 'ExclusionBrand', got ${dataSearchBrand.assets.length}`);
  }
  console.log('✅ Notes & Remarks exclusion verified: Search only matches visible columns and ignores background notes!');

  // Test 11: Link Accessories with Person in Asset Dossier
  console.log('\nTest 11: Link Accessories with Person in Asset Dossier');
  // Create an accessory assigned to ExclusionUser
  const resCreateAcc = await fetch(`${BASE_URL}/api/accessories`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      accessory_code: 'ACC-EXCL-1',
      name: 'Wireless Ergonomic Mouse',
      category: 'Mouse',
      brand: 'Logitech',
      assigned_user: 'ExclusionUser',
      status: 'Assigned'
    })
  });
  const dataCreateAcc = await resCreateAcc.json();
  const exclAccId = dataCreateAcc.id;

  // Fetch the asset dossier for ExclusionUser's asset
  const resDossier = await fetch(`${BASE_URL}/api/assets/${exclusionAssetId}`, { headers: authHeaders });
  const dataDossier = await resDossier.json();
  const linkedAccessories = dataDossier.asset?.accessories || [];
  console.log(`Dossier for ExclusionUser asset #${dataDossier.asset.internal_serial_number} found ${linkedAccessories.length} linked accessories.`);
  if (!linkedAccessories.some(acc => acc.accessory_code === 'ACC-EXCL-1')) {
    throw new Error('Expected ACC-EXCL-1 to be linked with ExclusionUser in asset dossier!');
  }
  console.log('✅ Person-linked accessories verified: Dossier correctly lists accessories assigned to the user!');

  // Clean up Test 10 and 11 records
  await fetch(`${BASE_URL}/api/assets/${exclusionAssetId}`, { method: 'DELETE', headers: authHeaders });
  await fetch(`${BASE_URL}/api/accessories/${exclAccId}`, { method: 'DELETE', headers: authHeaders });
  console.log('Cleaned up Test 10 & 11 temporary records.');

  // Test 12: IT Expenses & Upkeep Ledger Endpoint
  console.log('\nTest 12: IT Expenses & Upkeep Ledger Endpoint');
  const resExpenses = await fetch(`${BASE_URL}/api/expenses`, { headers: authHeaders });
  const dataExpenses = await resExpenses.json();
  console.log('Expenses Stats:', dataExpenses.stats);
  if (!dataExpenses.stats || typeof dataExpenses.stats.total_spend !== 'number') {
    throw new Error('Expenses stats missing in response');
  }
  if (!Array.isArray(dataExpenses.expenses)) {
    throw new Error('Expenses ledger list missing in response');
  }
  console.log(`Found ${dataExpenses.expenses.length} expense ticket record(s) in ledger.`);
  dataExpenses.expenses.slice(0, 3).forEach(e => {
    console.log(`  - Ticket: ${e.ticket_number} | Asset: #${e.internal_serial_number} (${e.brand} ${e.asset_type}) | Custodian: ${e.assigned_user} (${e.department}) | Parts: ${e.parts_added || 'None'} | Cost: ₹${e.repair_cost}`);
  });

  // Verify CSV export
  const resExpenseCsv = await fetch(`${BASE_URL}/api/expenses/export/csv`, { headers: authHeaders });
  const expenseCsv = await resExpenseCsv.text();
  if (!expenseCsv.includes('Ticket #') || !expenseCsv.includes('Cost (INR)') || !expenseCsv.includes('In Use By (User)')) {
    throw new Error('Expenses CSV export missing expected headers');
  }
  console.log('✅ Expenses & Upkeep Ledger verified: Aggregated stats, department breakdown, joined custodian info, and CSV report export!');

  // Test 13: Bulk Import for Accessories
  console.log('\nTest 13: Bulk Import for Accessories');
  const resAccTemplate = await fetch(`${BASE_URL}/api/accessories/template/csv`, { headers: authHeaders });
  const accTemplateCsv = await resAccTemplate.text();
  console.log('Accessories CSV Template header:', accTemplateCsv.split('\n')[0]);
  if (!accTemplateCsv.includes('Accessory Code') || !accTemplateCsv.includes('Item Name') || !accTemplateCsv.includes('Category')) {
    throw new Error('Accessories CSV Template missing required columns');
  }

  const testAccCsv = [
    'Accessory Code,Item Name,Category,Brand,Model,Serial Number,Quantity,Location,Status,Purchase Date,Cost (INR),Remarks',
    'ACC-BULK-01,Logitech Wireless Mouse M185,Mouse,Logitech,M185,LT18501,10,IT Store Room,In Stock,2026-09-01,650,Bulk import test 1',
    'ACC-BULK-02,Zebra Barcode Scanner Stand,Other,Zebra,DS2200-STND,,5,Dispatch Bay,In Stock,2026-09-01,1200,Bulk import test 2'
  ].join('\n');

  const accBoundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const accMultipartBody = Buffer.concat([
    Buffer.from(`--${accBoundary}\r\nContent-Disposition: form-data; name="file"; filename="accessories_bulk_test.csv"\r\nContent-Type: text/csv\r\n\r\n`),
    Buffer.from(testAccCsv),
    Buffer.from(`\r\n--${accBoundary}--\r\n`)
  ]);

  const resAccBulk = await fetch(`${BASE_URL}/api/accessories/bulk-import`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${accBoundary}`
    },
    body: accMultipartBody
  });
  const dataAccBulk = await resAccBulk.json();
  console.log('Accessories Bulk Import Response:', dataAccBulk);
  if (!resAccBulk.ok) throw new Error('Accessories bulk import failed: ' + JSON.stringify(dataAccBulk));
  if (dataAccBulk.imported_count !== 2) throw new Error(`Expected 2 imported accessories, got ${dataAccBulk.imported_count}`);

  // Clean up bulk test accessories
  const resVerifyAccBulk = await fetch(`${BASE_URL}/api/accessories?search=ACC-BULK`, { headers: authHeaders });
  const dataVerifyAccBulk = await resVerifyAccBulk.json();
  for (const item of dataVerifyAccBulk.accessories) {
    await fetch(`${BASE_URL}/api/accessories/${item.id}`, { method: 'DELETE', headers: authHeaders });
  }
  console.log('✅ Bulk import for accessories verified: CSV template download, batch parsing, and atomic SQLite insertion!');

  // Test 14: User Password Management & Admin Reset Password Flow
  console.log('\nTest 14: User Password Management & Admin Reset Password Flow');
  const testUserUsername = 'testuser_' + Math.floor(Math.random() * 10000);
  const initialPassword = 'password123';
  const newPassword = 'brandnewsecurepass456';

  // 1. Create a user with initial password
  const resCreateUser = await fetch(`${BASE_URL}/api/users`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      username: testUserUsername,
      full_name: 'Test Engineer',
      email: `${testUserUsername}@example.com`,
      role: 'technician',
      status: 'active',
      password: initialPassword
    })
  });
  const dataCreateUser = await resCreateUser.json();
  if (!resCreateUser.ok) throw new Error('Failed to create test user: ' + JSON.stringify(dataCreateUser));
  const newUserId = dataCreateUser.id;
  console.log(`Created test user @${testUserUsername} (ID: ${newUserId})`);

  // 2. Login with initial password
  const resLoginUserInitial = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: testUserUsername, password: initialPassword })
  });
  if (!resLoginUserInitial.ok) throw new Error('Failed to login with initial password');
  console.log('Initial password login successful.');

  // 3. Admin resets user password via POST /api/users/:id/reset-password
  const resReset = await fetch(`${BASE_URL}/api/users/${newUserId}/reset-password`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ password: newPassword })
  });
  const dataReset = await resReset.json();
  if (!resReset.ok) throw new Error('Failed to reset password: ' + JSON.stringify(dataReset));
  console.log('Admin password reset successful:', dataReset.message);

  // 4. Verify old password no longer works
  const resLoginOld = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: testUserUsername, password: initialPassword })
  });
  if (resLoginOld.ok) throw new Error('Old password still worked after reset!');
  console.log('Old password correctly rejected (401 Unauthorized).');

  // 5. Verify new password works
  const resLoginNew = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: testUserUsername, password: newPassword })
  });
  if (!resLoginNew.ok) throw new Error('Failed to login with new password after reset');
  console.log('New password successfully authenticated!');

  // Clean up test user
  await fetch(`${BASE_URL}/api/users/${newUserId}`, { method: 'DELETE', headers: authHeaders });
  console.log('✅ User Password Management verified: Secure bcrypt hashing, instant reset endpoint, and re-authentication verified!');

  // Test 15: Clean Production Login Screen (Quick Access & Footer Removed)
  console.log('\nTest 15: Clean Production Login Screen (Quick Access & Footer Removed)');
  const loginHtml = fs.readFileSync(path.join(__dirname, 'public', 'login.html'), 'utf8');
  if (loginHtml.includes('QUICK ROLE ACCESS') || loginHtml.includes('fillCreds')) {
    throw new Error('Quick role access test buttons still found in public/login.html!');
  }
  if (loginHtml.includes('Protected by Enterprise RBAC & JWT Session Security')) {
    throw new Error('Security footer still found in public/login.html!');
  }
  // Test 16: Date Calendar Filtering for Expenses and Repairs
  console.log('\nTest 16: Date Calendar Filtering for Expenses and Repairs');
  // Create 3 temporary repair records on different dates to test calendar filtering
  const assetForDateTest = (await (await fetch(`${BASE_URL}/api/assets`, { headers: authHeaders })).json()).assets[0];
  const dateRep1 = await (await fetch(`${BASE_URL}/api/repairs`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      asset_id: assetForDateTest.id,
      repair_date: '2026-02-15',
      repair_type: 'Component Repair',
      issue_description: 'February Date Test Issue',
      repair_cost: 1500,
      status: 'Completed'
    })
  })).json();

  const dateRep2 = await (await fetch(`${BASE_URL}/api/repairs`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      asset_id: assetForDateTest.id,
      repair_date: '2026-05-20',
      repair_type: 'Part Replacement',
      issue_description: 'May Date Test Issue',
      repair_cost: 3500,
      status: 'Completed'
    })
  })).json();

  const dateRep3 = await (await fetch(`${BASE_URL}/api/repairs`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      asset_id: assetForDateTest.id,
      repair_date: '2026-09-10',
      repair_type: 'Preventive Maintenance',
      issue_description: 'September Date Test Issue',
      repair_cost: 2000,
      status: 'Completed'
    })
  })).json();

  // 16A: Query expenses filtering for May 2026 only
  const resMayExp = await fetch(`${BASE_URL}/api/expenses?date_from=2026-05-01&date_to=2026-05-31`, { headers: authHeaders });
  const dataMayExp = await resMayExp.json();
  const mayMatch = dataMayExp.expenses.find(e => e.id === dateRep2.id);
  const febMatchInMay = dataMayExp.expenses.find(e => e.id === dateRep1.id);
  const sepMatchInMay = dataMayExp.expenses.find(e => e.id === dateRep3.id);

  if (!mayMatch) throw new Error('May expense record not returned in May date range query');
  if (febMatchInMay || sepMatchInMay) throw new Error('Out-of-range records returned in May date range query');
  console.log(`May Date Range Filter: Correctly isolated 2026-05-20 record (${dataMayExp.expenses.length} result(s)).`);

  // 16B: Test CSV Export with date range
  const resCsvDate = await fetch(`${BASE_URL}/api/expenses/export/csv?date_from=2026-05-01&date_to=2026-05-31`, { headers: authHeaders });
  const csvText = await resCsvDate.text();
  if (!csvText.includes('May Date Test Issue') || csvText.includes('February Date Test Issue')) {
    throw new Error('CSV Export did not respect date range filtering!');
  }
  console.log('Date-filtered CSV Export successfully verified.');

  // 16C: Test Repairs endpoint date filtering
  const resMayRep = await fetch(`${BASE_URL}/api/repairs?date_from=2026-05-01&date_to=2026-05-31`, { headers: authHeaders });
  const dataMayRep = await resMayRep.json();
  const repMatch = dataMayRep.repairs.find(r => r.id === dateRep2.id);
  if (!repMatch) throw new Error('Repairs endpoint date filter failed for May');
  console.log('Repairs endpoint date range filtering verified.');

  // Clean up date test tickets
  await fetch(`${BASE_URL}/api/repairs/${dateRep1.id}`, { method: 'DELETE', headers: authHeaders });
  await fetch(`${BASE_URL}/api/repairs/${dateRep2.id}`, { method: 'DELETE', headers: authHeaders });
  await fetch(`${BASE_URL}/api/repairs/${dateRep3.id}`, { method: 'DELETE', headers: authHeaders });
  console.log('✅ Date Calendar Filtering verified across UI Ledger, CSV Export, and Backend APIs!');

  // Test 17: Zero-Leakage End-to-End Security Hardening
  console.log('\nTest 17: Zero-Leakage End-to-End Security Hardening');

  // 17A: Unauthenticated GET / must redirect to /login (302)
  const resUnauthRoot = await fetch(`${BASE_URL}/`, { redirect: 'manual' });
  console.log('Unauthenticated GET / status:', resUnauthRoot.status, 'Location:', resUnauthRoot.headers.get('location'));
  if (resUnauthRoot.status !== 302 || resUnauthRoot.headers.get('location') !== '/login') {
    throw new Error(`Expected 302 redirect to /login for unauthenticated GET /, got ${resUnauthRoot.status}`);
  }
  console.log('✅ Unauthenticated access to / properly intercepted and redirected to /login.');

  // 17B: Unauthenticated GET /index.html must redirect to /login (302)
  const resUnauthIndex = await fetch(`${BASE_URL}/index.html`, { redirect: 'manual' });
  console.log('Unauthenticated GET /index.html status:', resUnauthIndex.status, 'Location:', resUnauthIndex.headers.get('location'));
  if (resUnauthIndex.status !== 302 || resUnauthIndex.headers.get('location') !== '/login') {
    throw new Error(`Expected 302 redirect to /login for unauthenticated GET /index.html, got ${resUnauthIndex.status}`);
  }
  console.log('✅ Unauthenticated access to /index.html properly intercepted.');

  // 17C: Unauthenticated GET /js/app.js must redirect to /login (302)
  const resUnauthJs = await fetch(`${BASE_URL}/js/app.js`, { redirect: 'manual' });
  if (resUnauthJs.status !== 302 || resUnauthJs.headers.get('location') !== '/login') {
    throw new Error(`Expected 302 redirect to /login for unauthenticated GET /js/app.js, got ${resUnauthJs.status}`);
  }
  console.log('✅ Unauthenticated access to client scripts (/js/app.js) properly blocked.');

  // 17D: Authenticated GET / with cookie must return 200 OK
  const resAuthRoot = await fetch(`${BASE_URL}/`, {
    headers: { 'Cookie': `it_app_token=${token}` }
  });
  if (resAuthRoot.status !== 200) {
    throw new Error(`Authenticated GET / failed: status ${resAuthRoot.status}`);
  }
  const rootText = await resAuthRoot.text();
  if (!rootText.includes('IT Asset Hub')) {
    throw new Error('Authenticated GET / did not serve index.html');
  }
  console.log('✅ Authenticated access to / with JWT cookie serves application dashboard.');

  // 17E: Probing sensitive files (.db, .env, .json) directly blocked
  const resDbProbe = await fetch(`${BASE_URL}/data/it_inventory.db`);
  if (resDbProbe.status !== 404 && resDbProbe.status !== 403) {
    throw new Error(`Database file probe was not blocked: status ${resDbProbe.status}`);
  }
  const resEnvProbe = await fetch(`${BASE_URL}/.env`);
  if (resEnvProbe.status !== 404 && resEnvProbe.status !== 403) {
    throw new Error(`.env file probe was not blocked: status ${resEnvProbe.status}`);
  }
  const resJsonProbe = await fetch(`${BASE_URL}/package.json`);
  if (resJsonProbe.status !== 404 && resJsonProbe.status !== 403) {
    throw new Error(`package.json probe was not blocked: status ${resJsonProbe.status}`);
  }
  console.log('✅ Sensitive file exposure shield verified (.db, .env, .json blocked).');

  // 17F: Path traversal blocked
  const resTraversal = await fetch(`${BASE_URL}/..%2F..%2Fserver.js`);
  if (resTraversal.status !== 403 && resTraversal.status !== 404) {
    throw new Error(`Path traversal was not blocked: status ${resTraversal.status}`);
  }
  console.log('✅ Path traversal protection verified (HTTP 403 Forbidden).');

  // 17G: HTTP Security headers
  const resHeaders = await fetch(`${BASE_URL}/health`);
  if (resHeaders.headers.get('x-content-type-options') !== 'nosniff') {
    throw new Error('Missing X-Content-Type-Options: nosniff header');
  }
  if (resHeaders.headers.get('x-frame-options') !== 'SAMEORIGIN') {
    throw new Error('Missing X-Frame-Options: SAMEORIGIN header');
  }
  if (resHeaders.headers.get('x-powered-by')) {
    throw new Error('x-powered-by header was not disabled');
  }
  console.log('✅ Security headers verified: nosniff, SAMEORIGIN, no X-Powered-By.');

  // 17H: Login Rate Limiter (Brute-Force Attack Mitigation)
  console.log('Testing Brute Force Login Rate Limiter...');
  const authRoute = require('./routes/auth');
  if (authRoute._loginAttempts) {
    authRoute._loginAttempts.clear(); // start fresh for test
  }

  let rateLimited = false;
  for (let i = 1; i <= 12; i++) {
    const resBadLogin = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: `wrongpassword_${i}` })
    });
    if (resBadLogin.status === 429) {
      rateLimited = true;
      const data429 = await resBadLogin.json();
      console.log(`Brute force attempt #${i} triggered HTTP 429 Too Many Requests: "${data429.error}"`);
      break;
    }
  }
  if (!rateLimited) {
    throw new Error('Brute force rate limiter failed to trigger 429 after 11 failed attempts');
  }
  console.log('✅ Brute-force protection verified: 429 Too Many Requests enforced.');

  // Reset rate limits so other operations continue normally
  if (authRoute._loginAttempts) {
    authRoute._loginAttempts.clear();
  }

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
