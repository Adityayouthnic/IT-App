const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// Database path (allows configurable location or defaults to data/it_inventory.db)
const dbDir = path.join(__dirname, 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = process.env.DATABASE_PATH || path.join(dbDir, 'it_inventory.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrency and performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize database schema
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'viewer', -- 'admin', 'technician', 'viewer'
      status TEXT NOT NULL DEFAULT 'active', -- 'active', 'inactive'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS quick_heal_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_key TEXT UNIQUE NOT NULL,
      edition TEXT DEFAULT 'Total Security',
      validity_date TEXT,
      status TEXT DEFAULT 'Available', -- 'Available', 'Assigned', 'Expired'
      assigned_asset_id INTEGER,
      assigned_user TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_serial_number TEXT UNIQUE NOT NULL,
      asset_type TEXT NOT NULL,
      brand TEXT,
      model_name TEXT,
      serial_number TEXT,
      purchase_date TEXT,
      purchase_vendor TEXT,
      purchase_cost REAL DEFAULT 0,
      department TEXT,
      location TEXT,
      assigned_user TEXT,
      quick_heal_key_id INTEGER REFERENCES quick_heal_keys(id) ON DELETE SET NULL,
      working_status TEXT DEFAULT 'Working', -- 'Working', 'In Repair', 'Not Working', 'Retired'
      condition_rating TEXT DEFAULT 'Good', -- 'New', 'Good', 'Fair', 'Poor', 'Critical'
      is_repaired INTEGER DEFAULT 0,
      parts_added_summary TEXT DEFAULT '',
      remarks TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS repairs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_number TEXT UNIQUE NOT NULL,
      asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      issue_description TEXT NOT NULL,
      repair_date TEXT NOT NULL,
      due_date TEXT,
      repair_vendor TEXT,
      technician_name TEXT,
      technician_contact TEXT,
      repair_type TEXT DEFAULT 'Component Repair', -- 'Component Repair', 'Part Replacement', 'Upgrade', 'Maintenance'
      parts_added TEXT,
      repair_cost REAL DEFAULT 0,
      status TEXT DEFAULT 'In Progress', -- 'In Progress', 'Completed', 'Awaiting Parts', 'Beyond Repair'
      completion_date TEXT,
      warranty_months INTEGER DEFAULT 0,
      remarks TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS accessories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      accessory_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL, -- 'Mouse', 'Keyboard', 'Scanner', 'Monitor', 'Cable/Adapter', 'UPS', 'Print Head', 'Other'
      brand TEXT,
      model TEXT,
      serial_number TEXT,
      quantity INTEGER DEFAULT 1,
      assigned_user TEXT,
      assigned_asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
      location TEXT,
      status TEXT DEFAULT 'In Stock', -- 'In Stock', 'Assigned', 'Damaged', 'Scrapped'
      purchase_date TEXT,
      cost REAL DEFAULT 0,
      remarks TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_assets_serial ON assets(internal_serial_number);
    CREATE INDEX IF NOT EXISTS idx_assets_dept ON assets(department);
    CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(assigned_user);
    CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(working_status);
    CREATE INDEX IF NOT EXISTS idx_repairs_asset ON repairs(asset_id);
    CREATE INDEX IF NOT EXISTS idx_repairs_status ON repairs(status);
    CREATE INDEX IF NOT EXISTS idx_keys_code ON quick_heal_keys(product_key);
    CREATE INDEX IF NOT EXISTS idx_acc_status ON accessories(status);
  `);

  // Migration: Ensure due_date column exists in repairs
  try {
    const tableInfo = db.prepare("PRAGMA table_info(repairs)").all();
    const hasDueDate = tableInfo.some(col => col.name === 'due_date');
    if (!hasDueDate) {
      db.exec("ALTER TABLE repairs ADD COLUMN due_date TEXT");
    }
  } catch (e) {
    console.warn('Migration due_date check error:', e.message);
  }
}

// Seed Initial Users
function seedUsers() {
  const count = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (count === 0) {
    const salt = bcrypt.genSaltSync(10);
    const adminPass = bcrypt.hashSync('admin123', salt);
    const techPass = bcrypt.hashSync('tech123', salt);
    const viewPass = bcrypt.hashSync('view123', salt);

    const insertUser = db.prepare(`
      INSERT INTO users (username, password_hash, full_name, email, role, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    insertUser.run('admin', adminPass, 'System Administrator', 'admin@vbexports.co.in', 'admin', 'active');
    insertUser.run('technician', techPass, 'IT Support Engineer', 'support@vbexports.co.in', 'technician', 'active');
    insertUser.run('viewer', viewPass, 'Operations Staff', 'staff@vbexports.co.in', 'viewer', 'active');

    console.log('Seeded initial users: admin, technician, viewer');
  }
}

// Seed data from IT Sheet.xlsx or extracted_data.json
function seedFromSheet() {
  const assetCount = db.prepare('SELECT COUNT(*) as count FROM assets').get().count;
  const keyCount = db.prepare('SELECT COUNT(*) as count FROM quick_heal_keys').get().count;

  if (assetCount > 0 && keyCount > 0) {
    return; // Already seeded
  }

  let sheetData = null;
  const jsonPath = path.join(__dirname, 'extracted_data.json');
  if (fs.existsSync(jsonPath)) {
    try {
      sheetData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (e) {
      console.warn('Failed reading extracted_data.json:', e.message);
    }
  }

  // Fallback to reading IT Sheet.xlsx directly if json doesn't exist
  if (!sheetData) {
    const xlsxPath = path.join(__dirname, 'IT Sheet.xlsx');
    if (fs.existsSync(xlsxPath)) {
      try {
        const xlsx = require('xlsx');
        const wb = xlsx.readFile(xlsxPath);
        sheetData = {};
        for (const sheetName of wb.SheetNames) {
          sheetData[sheetName] = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
        }
      } catch (err) {
        console.error('Error reading IT Sheet.xlsx:', err.message);
      }
    }
  }

  if (!sheetData) {
    console.warn('No sheet data found to seed.');
    return;
  }

  const transaction = db.transaction(() => {
    // 1. Seed Quick Heal Keys
    if (keyCount === 0 && sheetData['Quick Heal Keys']) {
      const insertKey = db.prepare(`
        INSERT OR IGNORE INTO quick_heal_keys (product_key, edition, validity_date, status, notes)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const item of sheetData['Quick Heal Keys']) {
        const key = (item['Quick Heal Keys'] || item['product_key'] || '').trim();
        let validity = (item['Vaildity'] || item['Validity'] || '').trim();
        if (validity) {
          // Normalize validity date format YYYY-MM-DD
          validity = validity.split(' ')[0];
        }
        if (key) {
          insertKey.run(key, 'Total Security', validity || '2029-08-22', 'Available', 'Imported from initial IT Sheet');
        }
      }
      console.log(`Seeded Quick Heal keys from sheet.`);
    }

    // 2. Seed IT Assets
    if (assetCount === 0 && sheetData['IT Assets']) {
      const insertAsset = db.prepare(`
        INSERT OR IGNORE INTO assets (
          internal_serial_number, asset_type, brand, purchase_date,
          purchase_vendor, purchase_cost, department, location,
          assigned_user, working_status, remarks, is_repaired, parts_added_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of sheetData['IT Assets']) {
        const serial = String(item['Internal Serial Number'] || '').trim();
        if (!serial) continue;

        const assetType = String(item['Type of System'] || 'Other').trim();
        const brand = String(item['Brand of the product'] || '').trim();
        let purchaseDate = String(item['Purchase Date'] || '').trim();
        if (purchaseDate === 'None' || !purchaseDate) {
          purchaseDate = '';
        }
        const dept = String(item['Department'] || '').trim();
        const user = String(item['User Name'] || '').trim();
        let status = String(item['Working Status'] || 'Working').trim();
        if (!['Working', 'Not Working', 'In Repair', 'Retired'].includes(status)) {
          status = 'Working';
        }
        const remarks = String(item['Remarks'] || '').trim();

        // Infer location based on department or remarks
        let location = 'Head Office';
        if (dept.toLowerCase().includes('order')) location = 'Orders Floor';
        else if (dept.toLowerCase().includes('dispatch')) location = 'Dispatch Bay';
        else if (dept.toLowerCase().includes('return')) location = 'Returns Section';
        else if (dept.toLowerCase().includes('listing')) location = 'Listings Dept';
        else if (dept.toLowerCase().includes('account')) location = 'Accounts Dept';
        else if (dept.toLowerCase().includes('analysis')) location = 'Data Analysis Lab';

        insertAsset.run(
          serial,
          assetType,
          brand,
          purchaseDate,
          'Standard IT Procurement',
          0,
          dept,
          location,
          user,
          status,
          remarks,
          status === 'Not Working' ? 1 : 0,
          status === 'Not Working' ? 'Needs diagnostics & repair' : ''
        );
      }
      console.log(`Seeded IT Assets from sheet.`);
    }

    // 3. Seed Sample Initial Accessories
    const accCount = db.prepare('SELECT COUNT(*) as count FROM accessories').get().count;
    if (accCount === 0) {
      const insertAcc = db.prepare(`
        INSERT INTO accessories (accessory_code, name, category, brand, model, quantity, location, status, remarks)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertAcc.run('ACC-001', 'USB Optical Mouse', 'Mouse', 'Logitech', 'M90', 15, 'IT Store Room', 'In Stock', 'Spare mice for workstations');
      insertAcc.run('ACC-002', 'USB Standard Keyboard', 'Keyboard', 'Dell', 'KB216', 10, 'IT Store Room', 'In Stock', 'Standard English keyboards');
      insertAcc.run('ACC-003', 'Handheld 2D Barcode Scanner', 'Scanner', 'Zebra', 'DS2208', 4, 'Dispatch Bay', 'In Stock', 'Ready for replacement in dispatch/orders');
      insertAcc.run('ACC-004', 'Thermal Printhead 203 DPI', 'Print Head', 'TSC', 'TE244/TTP-244', 3, 'IT Store Room', 'In Stock', 'Replacement printhead for label printers');
      insertAcc.run('ACC-005', 'HDMI to VGA Adapter Cable', 'Cable/Adapter', 'Quantum', 'Gold Plated', 8, 'IT Store Room', 'In Stock', 'Used for connecting legacy monitors');
      insertAcc.run('ACC-006', '600VA Line Interactive UPS', 'UPS', 'Microtek', 'Legend 650', 5, 'Orders Floor', 'Assigned', 'Backup power for tag printers');
      console.log('Seeded sample accessories.');
    }

    // 4. Seed Initial Repair Tickets for Known Problem Assets
    const repCount = db.prepare('SELECT COUNT(*) as count FROM repairs').get().count;
    if (repCount === 0) {
      const getAsset = db.prepare('SELECT id FROM assets WHERE internal_serial_number = ?');
      const asset50016 = getAsset.get('50016');
      const asset50046 = getAsset.get('50046');

      const insertRep = db.prepare(`
        INSERT INTO repairs (
          ticket_number, asset_id, issue_description, repair_date, repair_vendor,
          technician_name, repair_type, parts_added, repair_cost, status, remarks
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      if (asset50016) {
        insertRep.run(
          'REP-2026-001',
          asset50016.id,
          'System failing to power on in Returns department table. Suspected PSU or RAM fault.',
          '2026-09-15',
          'Lenovo Authorized Care',
          'Ramesh Verma',
          'Component Repair',
          'Awaiting 65W Power Adapter & Diagnostic',
          1200,
          'Awaiting Parts',
          'Marked Not Working in sheet, scheduled for repair inspection.'
        );
      }

      if (asset50046) {
        insertRep.run(
          'REP-2026-002',
          asset50046.id,
          'Canon printer key panel not responding; requires manual setup every reboot.',
          '2026-09-18',
          'Canon Service Center',
          'Suresh Kumar',
          'Part Replacement',
          'Control Key Panel Board',
          2400,
          'In Progress',
          'Ajay confirmed control panel failure.'
        );
      }
      console.log('Seeded initial repair tickets.');
    }
  });

  transaction();
}

// Migration: If any accessory has status = 'Assigned' and quantity > 1 (e.g. ACC-001 with 15 units assigned),
// split it into 1 assigned unit and (quantity - 1) in stock units.
function patchAssignedQuantities() {
  try {
    const anomalous = db.prepare("SELECT * FROM accessories WHERE status = 'Assigned' AND quantity > 1 AND assigned_user IS NOT NULL").all();
    for (const item of anomalous) {
      const assignedQty = 1;
      const stockQty = item.quantity - assignedQty;

      // Update original to stockQty with 'In Stock'
      db.prepare(`
        UPDATE accessories
        SET quantity = ?, status = 'In Stock', assigned_user = NULL, assigned_asset_id = NULL
        WHERE id = ?
      `).run(stockQty, item.id);

      // Create new assigned row with 1 unit
      const baseCode = item.accessory_code.replace(/-A\d+$/, '');
      let newCode = `${baseCode}-A1`;
      let counter = 1;
      while (db.prepare('SELECT id FROM accessories WHERE accessory_code = ?').get(newCode)) {
        counter++;
        newCode = `${baseCode}-A${counter}`;
      }

      db.prepare(`
        INSERT INTO accessories (
          accessory_code, name, category, brand, model, serial_number,
          quantity, assigned_user, assigned_asset_id, location, status,
          purchase_date, cost, remarks
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Assigned', ?, ?, ?)
      `).run(
        newCode,
        item.name,
        item.category,
        item.brand || '',
        item.model || '',
        item.serial_number || '',
        assignedQty,
        item.assigned_user,
        item.assigned_asset_id || null,
        item.location || 'Assigned to Staff',
        item.purchase_date || null,
        item.cost || 0,
        item.remarks || ''
      );
      console.log(`Auto-migrated accessory ${item.accessory_code}: split into ${stockQty} in stock and ${assignedQty} assigned to ${item.assigned_user}`);
    }
  } catch (err) {
    console.warn('patchAssignedQuantities error:', err.message);
  }
}

function ensureAdityaAdmin() {
  try {
    const salt = bcrypt.genSaltSync(10);
    const passHash = bcrypt.hashSync('Aditya@123', salt);

    // Update or insert 'admin'
    const adminUser = db.prepare("SELECT id FROM users WHERE username = 'admin' COLLATE NOCASE").get();
    if (adminUser) {
      db.prepare(`
        UPDATE users
        SET full_name = 'Aditya Shah',
            email = 'orders@vbexports.co.in',
            password_hash = ?,
            role = 'admin',
            status = 'active',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(passHash, adminUser.id);
      console.log('Synchronized admin user: Aditya Shah (orders@vbexports.co.in) with password Aditya@123');
    } else {
      db.prepare(`
        INSERT INTO users (username, password_hash, full_name, email, role, status)
        VALUES ('admin', ?, 'Aditya Shah', 'orders@vbexports.co.in', 'admin', 'active')
      `).run(passHash);
      console.log('Created admin user: Aditya Shah (orders@vbexports.co.in) with password Aditya@123');
    }

    // Also ensure 'aditya' username alias exists with the same credentials
    const adityaUser = db.prepare("SELECT id FROM users WHERE username = 'aditya' COLLATE NOCASE").get();
    if (!adityaUser) {
      db.prepare(`
        INSERT OR IGNORE INTO users (username, password_hash, full_name, email, role, status)
        VALUES ('aditya', ?, 'Aditya Shah', 'orders@vbexports.co.in', 'admin', 'active')
      `).run(passHash);
    } else {
      db.prepare(`
        UPDATE users
        SET password_hash = ?,
            role = 'admin',
            status = 'active',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(passHash, adityaUser.id);
    }
  } catch (err) {
    console.warn('ensureAdityaAdmin error:', err.message);
  }
}

// Initialize tables and run seeding
initSchema();
seedUsers();
seedFromSheet();
patchAssignedQuantities();
ensureAdityaAdmin();

module.exports = {
  db,
  initSchema
};

