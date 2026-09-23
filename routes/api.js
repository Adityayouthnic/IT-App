const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const xlsx = require('xlsx');
const { db } = require('../database');
const { authenticateToken, requireRoles, logAudit } = require('../auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// All API routes require authentication
router.use(authenticateToken);

// ==========================================
// 1. DASHBOARD & KPIS
// ==========================================
router.get('/dashboard/stats', (req, res) => {
  try {
    // Asset counts
    const assetStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN working_status = 'Working' THEN 1 ELSE 0 END) as working,
        SUM(CASE WHEN working_status = 'In Repair' THEN 1 ELSE 0 END) as in_repair,
        SUM(CASE WHEN working_status = 'Not Working' THEN 1 ELSE 0 END) as not_working,
        SUM(CASE WHEN working_status = 'Retired' THEN 1 ELSE 0 END) as retired,
        SUM(CASE WHEN is_repaired = 1 THEN 1 ELSE 0 END) as repaired_count
      FROM assets
    `).get();

    // Priority Security: Unprotected Laptops and Desktops (require Quick Heal keys)
    const unprotectedWorkstations = db.prepare(`
      SELECT COUNT(*) as count
      FROM assets
      WHERE asset_type IN ('Laptop', 'Desktop') AND quick_heal_key_id IS NULL
    `).get().count;

    // Quick Heal Key counts
    const keyStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'Assigned' THEN 1 ELSE 0 END) as assigned,
        SUM(CASE WHEN status = 'Available' THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN validity_date IS NOT NULL AND date(validity_date) <= date('now', '+90 days') THEN 1 ELSE 0 END) as expiring_soon
      FROM quick_heal_keys
    `).get();

    // Repair ticket counts & financial cost
    const repairStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status IN ('In Progress', 'Awaiting Parts', 'Diagnosing') THEN 1 ELSE 0 END) as open_tickets,
        SUM(CASE WHEN status IN ('Completed', 'Beyond Repair', 'Closed') THEN 1 ELSE 0 END) as closed_tickets,
        COALESCE(SUM(repair_cost), 0) as total_cost
      FROM repairs
    `).get();

    // Accessories counts (Units and assignment tracking)
    const accStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(quantity), 0) as total_units,
        COALESCE(SUM(CASE WHEN status = 'In Stock' THEN quantity ELSE 0 END), 0) as in_stock_units,
        COALESCE(SUM(CASE WHEN status = 'Assigned' THEN quantity ELSE 0 END), 0) as assigned_units,
        COALESCE(SUM(CASE WHEN status IN ('Damaged', 'Scrapped') THEN quantity ELSE 0 END), 0) as damaged_units
      FROM accessories
    `).get();

    // Breakdown by Department
    const deptBreakdown = db.prepare(`
      SELECT department, COUNT(*) as count
      FROM assets
      WHERE department IS NOT NULL AND department != ''
      GROUP BY department
      ORDER BY count DESC
    `).all();

    // Breakdown by System Type
    const typeBreakdown = db.prepare(`
      SELECT asset_type, COUNT(*) as count
      FROM assets
      GROUP BY asset_type
      ORDER BY count DESC
    `).all();

    // Breakdown by Brand
    const brandBreakdown = db.prepare(`
      SELECT brand, COUNT(*) as count
      FROM assets
      WHERE brand IS NOT NULL AND brand != ''
      GROUP BY brand
      ORDER BY count DESC
      LIMIT 8
    `).all();

    // Recent Repair Tickets
    const recentRepairs = db.prepare(`
      SELECT r.*, a.internal_serial_number, a.brand, a.asset_type, a.assigned_user
      FROM repairs r
      JOIN assets a ON r.asset_id = a.id
      ORDER BY r.created_at DESC
      LIMIT 5
    `).all();

    // Assets Needing Attention / Lifecycle Warning (High repair count or not working)
    const eolWarnings = db.prepare(`
      SELECT a.*, COUNT(r.id) as repair_count, COALESCE(SUM(r.repair_cost), 0) as total_repair_spent
      FROM assets a
      LEFT JOIN repairs r ON a.id = r.asset_id
      WHERE a.working_status = 'Not Working' OR a.is_repaired = 1
      GROUP BY a.id
      ORDER BY repair_count DESC, a.working_status DESC
      LIMIT 5
    `).all();

    res.json({
      assets: assetStats,
      unprotectedWorkstations,
      keys: keyStats,
      repairs: repairStats,
      accessories: accStats,
      deptBreakdown,
      typeBreakdown,
      brandBreakdown,
      recentRepairs,
      eolWarnings
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 2. IT ASSETS ENDPOINTS
// ==========================================

// Helper: Calculate Asset Age and End-of-Life Status
function computeAssetLifecycle(asset, repairCount = 0, totalRepairCost = 0) {
  let ageString = 'Unknown';
  let ageYears = 0;

  if (asset.purchase_date) {
    const purchase = new Date(asset.purchase_date);
    if (!isNaN(purchase.getTime())) {
      const now = new Date();
      const diffMs = now - purchase;
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      ageYears = +(diffDays / 365.25).toFixed(1);
      const months = Math.floor((diffDays % 365) / 30);
      const years = Math.floor(diffDays / 365);
      ageString = `${years}y ${months}m`;
    }
  }

  // Health and End-of-Life (EOL) calculation
  let healthScore = 'Healthy';
  let healthClass = 'success';
  let eolReason = 'Operating normally with no critical issues.';

  if (asset.working_status === 'Retired') {
    healthScore = 'Retired / Scrapped';
    healthClass = 'neutral';
    eolReason = 'Asset has been retired from production service.';
  } else if (asset.working_status === 'Not Working') {
    healthScore = 'Critical / Non-Functional';
    healthClass = 'danger';
    eolReason = 'Device is currently defective and non-operational.';
  } else if (repairCount >= 4 || (totalRepairCost > 0 && asset.purchase_cost > 0 && totalRepairCost >= asset.purchase_cost * 0.6)) {
    healthScore = 'End-of-Life Warning';
    healthClass = 'danger';
    eolReason = `Exceeded maintenance threshold (${repairCount} repairs, spent ₹${totalRepairCost}). Recommend replacement.`;
  } else if (repairCount >= 2 || ageYears >= 4) {
    healthScore = 'High Maintenance / Aging';
    healthClass = 'warning';
    eolReason = `Frequent repairs (${repairCount}) or age (${ageYears} yrs). Monitor closely for wear.`;
  } else if (repairCount === 1 || asset.is_repaired === 1) {
    healthScore = 'Moderate Wear';
    healthClass = 'info';
    eolReason = 'Asset has had 1 repair/upgrade; functioning adequately.';
  }

  return { ageString, ageYears, healthScore, healthClass, eolReason };
}

// GET /api/assets - List all assets with search & filters
router.get('/assets', (req, res) => {
  try {
    const { search, type, department, brand, status, quick_heal, page = 1, limit = 100 } = req.query;

    let query = `
      SELECT a.*,
             k.product_key as quick_heal_key_str,
             k.validity_date as quick_heal_validity,
             (SELECT COUNT(*) FROM repairs WHERE asset_id = a.id) as repair_count,
             (SELECT COALESCE(SUM(repair_cost), 0) FROM repairs WHERE asset_id = a.id) as total_repair_cost
      FROM assets a
      LEFT JOIN quick_heal_keys k ON a.quick_heal_key_id = k.id
      WHERE 1=1
    `;
    const params = [];

    const searchTokens = (search && search.trim()) ? search.trim().toLowerCase().split(/\s+/).filter(Boolean) : [];

    if (searchTokens.length > 0) {
      // Require each token to match in at least one searchable column (AND condition across tokens)
      // Excludes internal notes/remarks per user requirement
      searchTokens.forEach(tok => {
        const term = `%${tok}%`;
        query += ` AND (
          LOWER(a.internal_serial_number) LIKE ? OR
          LOWER(a.asset_type) LIKE ? OR
          LOWER(a.brand) LIKE ? OR
          LOWER(COALESCE(a.model_name, '')) LIKE ? OR
          LOWER(COALESCE(a.serial_number, '')) LIKE ? OR
          LOWER(COALESCE(a.department, '')) LIKE ? OR
          LOWER(COALESCE(a.location, '')) LIKE ? OR
          LOWER(COALESCE(a.assigned_user, '')) LIKE ? OR
          LOWER(COALESCE(k.product_key, '')) LIKE ? OR
          LOWER(COALESCE(a.parts_added_summary, '')) LIKE ?
        )`;
        params.push(term, term, term, term, term, term, term, term, term, term);
      });
    }

    if (type) {
      query += ` AND a.asset_type = ?`;
      params.push(type);
    }
    if (department) {
      query += ` AND a.department = ?`;
      params.push(department);
    }
    if (brand) {
      query += ` AND a.brand = ?`;
      params.push(brand);
    }
    if (status) {
      query += ` AND a.working_status = ?`;
      params.push(status);
    }
    if (quick_heal === 'mapped') {
      query += ` AND a.quick_heal_key_id IS NOT NULL`;
    } else if (quick_heal === 'unmapped') {
      query += ` AND a.quick_heal_key_id IS NULL`;
    } else if (quick_heal === 'unprotected' || quick_heal === 'unprotected_workstations') {
      query += ` AND a.asset_type IN ('Laptop', 'Desktop') AND a.quick_heal_key_id IS NULL`;
    }

    // Relevance ordering: visible columns prioritized first
    if (searchTokens.length > 0) {
      const fullSearch = `%${search.trim().toLowerCase()}%`;
      query += ` ORDER BY
        CASE
          WHEN LOWER(a.assigned_user) LIKE ? THEN 0
          WHEN LOWER(a.internal_serial_number) LIKE ? THEN 1
          WHEN LOWER(a.brand) LIKE ? OR LOWER(COALESCE(a.model_name, '')) LIKE ? THEN 2
          WHEN LOWER(COALESCE(a.department, '')) LIKE ? THEN 3
          ELSE 4
        END ASC,
        CAST(a.internal_serial_number AS INTEGER) ASC, a.id ASC`;
      params.push(fullSearch, fullSearch, fullSearch, fullSearch, fullSearch);
    } else {
      query += ` ORDER BY CAST(a.internal_serial_number AS INTEGER) ASC, a.id ASC`;
    }

    const assets = db.prepare(query).all(...params);

    // Enrich with lifecycle info
    const enriched = assets.map(asset => {
      const lifecycle = computeAssetLifecycle(asset, asset.repair_count, asset.total_repair_cost);
      return {
        ...asset,
        ...lifecycle
      };
    });

    res.json({ assets: enriched, total: enriched.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assets/next-serial
router.get('/assets/next-serial', (req, res) => {
  try {
    const row = db.prepare(`
      SELECT internal_serial_number
      FROM assets
      WHERE internal_serial_number GLOB '[0-9]*'
      ORDER BY CAST(internal_serial_number AS INTEGER) DESC
      LIMIT 1
    `).get();

    let nextSerial = '50001';
    if (row && row.internal_serial_number) {
      const num = parseInt(row.internal_serial_number, 10);
      if (!isNaN(num)) {
        nextSerial = String(num + 1);
      }
    }
    res.json({ nextSerial });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assets/:id - Single asset details with full repair & key timeline
router.get('/assets/:id', (req, res) => {
  try {
    const asset = db.prepare(`
      SELECT a.*,
             k.product_key as quick_heal_key_str,
             k.validity_date as quick_heal_validity,
             k.status as quick_heal_status
      FROM assets a
      LEFT JOIN quick_heal_keys k ON a.quick_heal_key_id = k.id
      WHERE a.id = ? OR a.internal_serial_number = ?
    `).get(req.params.id, req.params.id);

    if (!asset) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    // Fetch all repairs for this asset
    const repairs = db.prepare(`
      SELECT * FROM repairs WHERE asset_id = ? ORDER BY repair_date DESC, created_at DESC
    `).all(asset.id);

    // Fetch linked accessories (assigned to this asset OR assigned to this user)
    const accessories = db.prepare(`
      SELECT * FROM accessories
      WHERE assigned_asset_id = ?
         OR (assigned_user IS NOT NULL AND TRIM(assigned_user) != '' AND LOWER(assigned_user) = LOWER(?))
      ORDER BY status ASC, id ASC
    `).all(asset.id, (asset.assigned_user || '').trim());

    const totalRepairCost = repairs.reduce((sum, r) => sum + (Number(r.repair_cost) || 0), 0);
    const lifecycle = computeAssetLifecycle(asset, repairs.length, totalRepairCost);

    res.json({
      asset: {
        ...asset,
        ...lifecycle,
        repair_count: repairs.length,
        total_repair_cost: totalRepairCost,
        repairs,
        accessories
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/assets - Create new IT asset
router.post('/assets', requireRoles('admin', 'technician'), (req, res) => {
  try {
    let {
      internal_serial_number,
      asset_type,
      brand,
      model_name,
      serial_number,
      purchase_date,
      purchase_vendor,
      purchase_cost,
      department,
      location,
      assigned_user,
      quick_heal_key_id,
      working_status,
      condition_rating,
      is_repaired,
      parts_added_summary,
      remarks
    } = req.body;

    if (!internal_serial_number || !asset_type) {
      return res.status(400).json({ error: 'Internal Serial Number and Asset Type are required.' });
    }

    internal_serial_number = String(internal_serial_number).trim();

    // Check duplicate
    const existing = db.prepare('SELECT id FROM assets WHERE internal_serial_number = ?').get(internal_serial_number);
    if (existing) {
      return res.status(400).json({ error: `Asset with Serial Number ${internal_serial_number} already exists.` });
    }

    const insert = db.prepare(`
      INSERT INTO assets (
        internal_serial_number, asset_type, brand, model_name, serial_number,
        purchase_date, purchase_vendor, purchase_cost, department, location,
        assigned_user, quick_heal_key_id, working_status, condition_rating,
        is_repaired, parts_added_summary, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      internal_serial_number,
      asset_type.trim(),
      brand ? brand.trim() : '',
      model_name ? model_name.trim() : '',
      serial_number ? serial_number.trim() : '',
      purchase_date || null,
      purchase_vendor ? purchase_vendor.trim() : '',
      Number(purchase_cost) || 0,
      department ? department.trim() : '',
      location ? location.trim() : '',
      assigned_user ? assigned_user.trim() : '',
      quick_heal_key_id || null,
      working_status || 'Working',
      condition_rating || 'Good',
      is_repaired ? 1 : 0,
      parts_added_summary ? parts_added_summary.trim() : '',
      remarks ? remarks.trim() : ''
    );

    const newAssetId = result.lastInsertRowid;

    // If Quick Heal Key was mapped, update key status and assigned asset
    if (quick_heal_key_id) {
      db.prepare(`
        UPDATE quick_heal_keys
        SET status = 'Assigned', assigned_asset_id = ?, assigned_user = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(newAssetId, assigned_user || '', quick_heal_key_id);
    }

    logAudit(req.user.id, req.user.username, 'CREATE_ASSET', 'asset', newAssetId, `Created asset ${internal_serial_number}`);

    res.status(201).json({ message: 'Asset created successfully', id: newAssetId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/assets/:id - Update asset
router.put('/assets/:id', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const assetId = req.params.id;
    const existing = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    if (!existing) {
      return res.status(404).json({ error: 'Asset not found.' });
    }

    const {
      internal_serial_number,
      asset_type,
      brand,
      model_name,
      serial_number,
      purchase_date,
      purchase_vendor,
      purchase_cost,
      department,
      location,
      assigned_user,
      quick_heal_key_id,
      working_status,
      condition_rating,
      is_repaired,
      parts_added_summary,
      remarks
    } = req.body;

    // Check serial conflict if changed
    if (internal_serial_number && internal_serial_number !== existing.internal_serial_number) {
      const conflict = db.prepare('SELECT id FROM assets WHERE internal_serial_number = ? AND id != ?').get(internal_serial_number, assetId);
      if (conflict) {
        return res.status(400).json({ error: `Serial Number ${internal_serial_number} is already in use.` });
      }
    }

    // Handle Quick Heal key changes
    const oldKeyId = existing.quick_heal_key_id;
    const newKeyId = quick_heal_key_id ? Number(quick_heal_key_id) : null;

    if (oldKeyId && oldKeyId !== newKeyId) {
      // Unlink old key
      db.prepare(`
        UPDATE quick_heal_keys
        SET status = 'Available', assigned_asset_id = NULL, assigned_user = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(oldKeyId);
    }

    if (newKeyId && newKeyId !== oldKeyId) {
      // Link new key
      db.prepare(`
        UPDATE quick_heal_keys
        SET status = 'Assigned', assigned_asset_id = ?, assigned_user = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(assetId, assigned_user || existing.assigned_user || '', newKeyId);
    }

    const finalSerial = internal_serial_number ? String(internal_serial_number).trim() : existing.internal_serial_number;

    db.prepare(`
      UPDATE assets SET
        internal_serial_number = ?,
        asset_type = COALESCE(?, asset_type),
        brand = COALESCE(?, brand),
        model_name = COALESCE(?, model_name),
        serial_number = COALESCE(?, serial_number),
        purchase_date = ?,
        purchase_vendor = COALESCE(?, purchase_vendor),
        purchase_cost = COALESCE(?, purchase_cost),
        department = COALESCE(?, department),
        location = COALESCE(?, location),
        assigned_user = COALESCE(?, assigned_user),
        quick_heal_key_id = ?,
        working_status = COALESCE(?, working_status),
        condition_rating = COALESCE(?, condition_rating),
        is_repaired = COALESCE(?, is_repaired),
        parts_added_summary = COALESCE(?, parts_added_summary),
        remarks = COALESCE(?, remarks),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      finalSerial,
      asset_type ? asset_type.trim() : existing.asset_type,
      brand !== undefined ? brand.trim() : existing.brand,
      model_name !== undefined ? model_name.trim() : existing.model_name,
      serial_number !== undefined ? serial_number.trim() : existing.serial_number,
      purchase_date || null,
      purchase_vendor !== undefined ? purchase_vendor.trim() : existing.purchase_vendor,
      purchase_cost !== undefined ? Number(purchase_cost) : existing.purchase_cost,
      department !== undefined ? department.trim() : existing.department,
      location !== undefined ? location.trim() : existing.location,
      assigned_user !== undefined ? assigned_user.trim() : existing.assigned_user,
      newKeyId,
      working_status || existing.working_status,
      condition_rating || existing.condition_rating,
      is_repaired !== undefined ? (is_repaired ? 1 : 0) : existing.is_repaired,
      parts_added_summary !== undefined ? parts_added_summary.trim() : existing.parts_added_summary,
      remarks !== undefined ? remarks.trim() : existing.remarks,
      assetId
    );

    logAudit(req.user.id, req.user.username, 'UPDATE_ASSET', 'asset', assetId, `Updated asset ${finalSerial}`);

    res.json({ message: 'Asset updated successfully', asset: { ...existing, internal_serial_number: finalSerial } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/assets/:id - Delete asset (Admin only)
router.delete('/assets/:id', requireRoles('admin'), (req, res) => {
  try {
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found.' });
    }

    // Release linked Quick Heal key
    if (asset.quick_heal_key_id) {
      db.prepare(`
        UPDATE quick_heal_keys
        SET status = 'Available', assigned_asset_id = NULL, assigned_user = NULL
        WHERE id = ?
      `).run(asset.quick_heal_key_id);
    }

    db.prepare('DELETE FROM assets WHERE id = ?').run(req.params.id);
    logAudit(req.user.id, req.user.username, 'DELETE_ASSET', 'asset', req.params.id, `Deleted asset ${asset.internal_serial_number}`);

    res.json({ message: 'Asset deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assets/template/csv - Download Sample CSV Template for Bulk Import
router.get('/assets/template/csv', (req, res) => {
  const templateContent = [
    'Internal Serial Number,Asset Type,Brand,Model Name,Manufacturer Serial,Purchase Date,Purchase Vendor,Purchase Cost,Department,Location,Assigned User,Working Status,Condition Rating,Parts Added,Remarks',
    '50060,Laptop,Lenovo,ThinkPad T14,PF-99901,2026-01-15,Lenovo Store,65000,Accounts,Head Office Floor 2,Rohan Gupta,Working,Good,,Standard office laptop',
    '50061,Desktop,Dell,OptiPlex 3080,DL-44821,2025-11-20,Dell Direct,48000,Orders,Orders Floor Desk 4,Priya Patel,Working,Good,Upgraded 16GB RAM,For order processing',
    '50062,Tag Printer,TSC,TE244,TSC-8812,2025-08-10,TSC Vendor,14500,Dispatch,Dispatch Bay,FREE,Working,Good,,Picklist label printing'
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="it_assets_bulk_import_template.csv"');
  res.send(templateContent);
});

// POST /api/assets/bulk-import - Bulk import assets via CSV/Excel or JSON
router.post('/assets/bulk-import', requireRoles('admin', 'technician'), upload.single('file'), (req, res) => {
  try {
    let rows = [];

    if (req.file) {
      // Parse CSV or Excel from uploaded buffer
      const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
      const sheetName = wb.SheetNames[0];
      rows = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
    } else if (req.body.assets && Array.isArray(req.body.assets)) {
      rows = req.body.assets;
    } else {
      return res.status(400).json({ error: 'Please upload a CSV or Excel file, or provide asset rows in the request.' });
    }

    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: 'No data found in uploaded file.' });
    }

    const results = {
      total: rows.length,
      imported: 0,
      skipped: 0,
      errors: []
    };

    const insertAsset = db.prepare(`
      INSERT INTO assets (
        internal_serial_number, asset_type, brand, model_name, serial_number,
        purchase_date, purchase_vendor, purchase_cost, department, location,
        assigned_user, working_status, condition_rating, parts_added_summary, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const checkSerial = db.prepare('SELECT id FROM assets WHERE internal_serial_number = ?');
    const existingInBatch = new Set();

    const transaction = db.transaction(() => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rawSerial = row['Internal Serial Number'] || row['internal_serial_number'] || row['Serial Number'] || row['serial'];
        const serial = rawSerial ? String(rawSerial).trim() : '';

        if (!serial) {
          results.skipped++;
          results.errors.push(`Row ${i + 1}: Missing Internal Serial Number.`);
          continue;
        }

        if (existingInBatch.has(serial) || checkSerial.get(serial)) {
          results.skipped++;
          results.errors.push(`Row ${i + 1}: Serial Number '${serial}' already exists.`);
          continue;
        }

        existingInBatch.add(serial);

        const assetType = String(row['Asset Type'] || row['asset_type'] || row['Type of System'] || 'Other').trim();
        const brand = String(row['Brand'] || row['brand'] || row['Brand of the product'] || '').trim();
        const model = String(row['Model Name'] || row['model_name'] || row['Model'] || '').trim();
        const hwSerial = String(row['Manufacturer Serial'] || row['serial_number'] || '').trim();
        let purchaseDate = String(row['Purchase Date'] || row['purchase_date'] || '').trim();
        if (purchaseDate === 'None' || !purchaseDate) purchaseDate = null;
        const vendor = String(row['Purchase Vendor'] || row['purchase_vendor'] || row['Vendor'] || '').trim();
        const cost = Number(row['Purchase Cost'] || row['purchase_cost'] || row['Cost'] || 0) || 0;
        const dept = String(row['Department'] || row['department'] || 'General').trim();
        const location = String(row['Location'] || row['location'] || '').trim();
        const user = String(row['Assigned User'] || row['assigned_user'] || row['User Name'] || 'Unassigned').trim();
        const status = String(row['Working Status'] || row['working_status'] || 'Working').trim();
        const condition = String(row['Condition Rating'] || row['condition_rating'] || 'Good').trim();
        const parts = String(row['Parts Added'] || row['parts_added_summary'] || '').trim();
        const remarks = String(row['Remarks'] || row['remarks'] || '').trim();

        insertAsset.run(
          serial,
          assetType || 'Other',
          brand,
          model,
          hwSerial,
          purchaseDate,
          vendor,
          cost,
          dept,
          location,
          user,
          status,
          condition,
          parts,
          remarks
        );

        results.imported++;
      }
    });

    transaction();

    logAudit(req.user.id, req.user.username, 'BULK_IMPORT_ASSETS', 'asset', 'batch', `Bulk imported ${results.imported} assets, skipped ${results.skipped}`);

    res.json({
      message: `Bulk import completed: ${results.imported} assets imported, ${results.skipped} skipped.`,
      imported_count: results.imported,
      skipped_count: results.skipped,
      results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assets/export/csv
router.get('/export/csv', (req, res) => {
  try {
    const assets = db.prepare(`
      SELECT a.internal_serial_number, a.asset_type, a.brand, a.model_name, a.serial_number,
             a.purchase_date, a.purchase_vendor, a.purchase_cost, a.department, a.location,
             a.assigned_user, k.product_key as quick_heal_key, a.working_status, a.is_repaired,
             a.parts_added_summary, a.remarks
      FROM assets a
      LEFT JOIN quick_heal_keys k ON a.quick_heal_key_id = k.id
      ORDER BY CAST(a.internal_serial_number AS INTEGER) ASC
    `).all();

    const headers = [
      'Internal Serial Number', 'Type of System', 'Brand', 'Model', 'Hardware Serial',
      'Purchase Date', 'Vendor', 'Purchase Cost', 'Department', 'Location',
      'Assigned User', 'Quick Heal Key', 'Working Status', 'Repaired?',
      'Parts Added Summary', 'Remarks'
    ];

    let csv = headers.join(',') + '\n';
    assets.forEach(row => {
      const vals = [
        `"${row.internal_serial_number || ''}"`,
        `"${row.asset_type || ''}"`,
        `"${row.brand || ''}"`,
        `"${row.model_name || ''}"`,
        `"${row.serial_number || ''}"`,
        `"${row.purchase_date || ''}"`,
        `"${row.purchase_vendor || ''}"`,
        `"${row.purchase_cost || 0}"`,
        `"${row.department || ''}"`,
        `"${row.location || ''}"`,
        `"${row.assigned_user || ''}"`,
        `"${row.quick_heal_key || ''}"`,
        `"${row.working_status || ''}"`,
        `"${row.is_repaired ? 'Yes' : 'No'}"`,
        `"${(row.parts_added_summary || '').replace(/"/g, '""')}"`,
        `"${(row.remarks || '').replace(/"/g, '""')}"`
      ];
      csv += vals.join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="IT_Assets_Inventory.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. REPAIRS & LIFECYCLE ENDPOINTS
// ==========================================

// GET /api/repairs - List repair tickets with due date and open/closed filters
router.get('/repairs', (req, res) => {
  try {
    const { status, ticket_status, asset_id, search } = req.query;
    let query = `
      SELECT r.*, a.internal_serial_number, a.brand, a.asset_type, a.assigned_user, a.department
      FROM repairs r
      JOIN assets a ON r.asset_id = a.id
      WHERE 1=1
    `;
    const params = [];

    if (ticket_status === 'open') {
      query += ` AND r.status IN ('In Progress', 'Awaiting Parts', 'Diagnosing')`;
    } else if (ticket_status === 'closed') {
      query += ` AND r.status IN ('Completed', 'Beyond Repair', 'Closed')`;
    } else if (status) {
      query += ` AND r.status = ?`;
      params.push(status);
    }

    if (asset_id) {
      query += ` AND r.asset_id = ?`;
      params.push(asset_id);
    }
    if (req.query.date_from && req.query.date_from.trim()) {
      query += ` AND r.repair_date >= ?`;
      params.push(req.query.date_from.trim());
    }
    if (req.query.date_to && req.query.date_to.trim()) {
      query += ` AND r.repair_date <= ?`;
      params.push(req.query.date_to.trim());
    }
    if (search && search.trim()) {
      const term = `%${search.trim().toLowerCase()}%`;
      query += ` AND (
        LOWER(r.ticket_number) LIKE ? OR
        LOWER(r.issue_description) LIKE ? OR
        LOWER(COALESCE(r.repair_vendor, '')) LIKE ? OR
        LOWER(COALESCE(r.technician_name, '')) LIKE ? OR
        LOWER(COALESCE(r.parts_added, '')) LIKE ? OR
        LOWER(a.internal_serial_number) LIKE ? OR
        LOWER(COALESCE(a.assigned_user, '')) LIKE ?
      )`;
      params.push(term, term, term, term, term, term, term);
    }

    query += ` ORDER BY r.created_at DESC`;
    const repairs = db.prepare(query).all(...params);

    const counts = db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status IN ('In Progress', 'Awaiting Parts', 'Diagnosing') THEN 1 ELSE 0 END), 0) as open_count,
        COALESCE(SUM(CASE WHEN status IN ('Completed', 'Beyond Repair', 'Closed') THEN 1 ELSE 0 END), 0) as closed_count
      FROM repairs
    `).get();

    res.json({ repairs, counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/repairs - Create repair ticket
router.post('/repairs', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const {
      asset_id,
      issue_description,
      repair_date,
      due_date,
      repair_vendor,
      technician_name,
      technician_contact,
      repair_type,
      parts_added,
      repair_cost,
      status,
      remarks,
      warranty_months
    } = req.body;

    if (!asset_id || !issue_description || !repair_date) {
      return res.status(400).json({ error: 'Asset, issue description, and repair date are required.' });
    }

    // Verify asset
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(asset_id);
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found.' });
    }

    // Generate ticket number: REP-YYYY-XXX
    const year = new Date().getFullYear();
    const latestTicket = db.prepare(`SELECT ticket_number FROM repairs WHERE ticket_number LIKE ? ORDER BY id DESC LIMIT 1`).get(`REP-${year}-%`);
    let nextNum = 1;
    if (latestTicket && latestTicket.ticket_number) {
      const parts = latestTicket.ticket_number.split('-');
      if (parts.length === 3) {
        nextNum = (parseInt(parts[2], 10) || 0) + 1;
      }
    }
    const ticket_number = `REP-${year}-${String(nextNum).padStart(3, '0')}`;

    const insert = db.prepare(`
      INSERT INTO repairs (
        ticket_number, asset_id, issue_description, repair_date, due_date, repair_vendor,
        technician_name, technician_contact, repair_type, parts_added,
        repair_cost, status, remarks, warranty_months
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      ticket_number,
      asset_id,
      issue_description.trim(),
      repair_date,
      due_date || null,
      repair_vendor ? repair_vendor.trim() : '',
      technician_name ? technician_name.trim() : '',
      technician_contact ? technician_contact.trim() : '',
      repair_type || 'Component Repair',
      parts_added ? parts_added.trim() : '',
      Number(repair_cost) || 0,
      status || 'In Progress',
      remarks ? remarks.trim() : '',
      Number(warranty_months) || 0
    );

    // Update asset status to In Repair if ticket is currently open
    if (status !== 'Completed' && status !== 'Beyond Repair') {
      db.prepare(`UPDATE assets SET working_status = 'In Repair', is_repaired = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(asset_id);
    } else if (status === 'Completed') {
      let updatedParts = asset.parts_added_summary || '';
      if (parts_added && parts_added.trim()) {
        updatedParts = updatedParts ? `${updatedParts}; ${parts_added.trim()}` : parts_added.trim();
      }
      db.prepare(`
        UPDATE assets
        SET working_status = 'Working', is_repaired = 1, parts_added_summary = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(updatedParts, asset_id);
    }

    logAudit(req.user.id, req.user.username, 'CREATE_REPAIR', 'repair', result.lastInsertRowid, `Logged repair ticket ${ticket_number} for asset ${asset.internal_serial_number}`);

    res.status(201).json({ message: 'Repair ticket created successfully', ticket_number, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/repairs/:id - Update repair ticket
router.put('/repairs/:id', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const repairId = req.params.id;
    const existing = db.prepare('SELECT * FROM repairs WHERE id = ?').get(repairId);
    if (!existing) {
      return res.status(404).json({ error: 'Repair ticket not found.' });
    }

    const {
      issue_description,
      repair_date,
      due_date,
      repair_vendor,
      technician_name,
      technician_contact,
      repair_type,
      parts_added,
      repair_cost,
      status,
      completion_date,
      warranty_months,
      remarks,
      update_asset_status
    } = req.body;

    const newStatus = status || existing.status;
    const newCompletionDate = (newStatus === 'Completed' && !completion_date) ? new Date().toISOString().split('T')[0] : (completion_date !== undefined ? completion_date : existing.completion_date);

    db.prepare(`
      UPDATE repairs SET
        issue_description = COALESCE(?, issue_description),
        repair_date = COALESCE(?, repair_date),
        due_date = ?,
        repair_vendor = COALESCE(?, repair_vendor),
        technician_name = COALESCE(?, technician_name),
        technician_contact = COALESCE(?, technician_contact),
        repair_type = COALESCE(?, repair_type),
        parts_added = COALESCE(?, parts_added),
        repair_cost = COALESCE(?, repair_cost),
        status = ?,
        completion_date = ?,
        warranty_months = COALESCE(?, warranty_months),
        remarks = COALESCE(?, remarks),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      issue_description,
      repair_date,
      due_date !== undefined ? due_date : existing.due_date,
      repair_vendor,
      technician_name,
      technician_contact,
      repair_type,
      parts_added,
      repair_cost !== undefined ? Number(repair_cost) : existing.repair_cost,
      newStatus,
      newCompletionDate,
      warranty_months,
      remarks,
      repairId
    );

    // Sync asset status if requested or status changed to Completed/Beyond Repair
    if (update_asset_status || (newStatus === 'Completed' && existing.status !== 'Completed')) {
      const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(existing.asset_id);
      if (asset) {
        let finalStatus = 'Working';
        if (newStatus === 'Beyond Repair') finalStatus = 'Not Working';
        else if (newStatus === 'In Progress' || newStatus === 'Awaiting Parts') finalStatus = 'In Repair';

        let updatedParts = asset.parts_added_summary || '';
        if (parts_added && parts_added.trim() && !updatedParts.includes(parts_added.trim())) {
          updatedParts = updatedParts ? `${updatedParts}; ${parts_added.trim()}` : parts_added.trim();
        }

        db.prepare(`
          UPDATE assets
          SET working_status = ?, is_repaired = 1, parts_added_summary = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(finalStatus, updatedParts, existing.asset_id);
      }
    }

    logAudit(req.user.id, req.user.username, 'UPDATE_REPAIR', 'repair', repairId, `Updated repair ticket ${existing.ticket_number}`);

    res.json({ message: 'Repair ticket updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/repairs/:id/close - Close and resolve a repair ticket
router.post('/repairs/:id/close', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const repairId = req.params.id;
    const existing = db.prepare('SELECT * FROM repairs WHERE id = ?').get(repairId);
    if (!existing) {
      return res.status(404).json({ error: 'Repair ticket not found.' });
    }

    const {
      completion_date,
      repair_cost,
      parts_added,
      remarks,
      asset_working_status = 'Working'
    } = req.body;

    const finalDate = completion_date || new Date().toISOString().split('T')[0];
    const finalCost = repair_cost !== undefined ? Number(repair_cost) : existing.repair_cost;
    const finalParts = parts_added !== undefined ? parts_added.trim() : (existing.parts_added || '');
    const finalRemarks = remarks !== undefined ? remarks.trim() : (existing.remarks || '');

    const transaction = db.transaction(() => {
      // 1. Update repair ticket to Completed
      db.prepare(`
        UPDATE repairs SET
          status = 'Completed',
          completion_date = ?,
          repair_cost = ?,
          parts_added = ?,
          remarks = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(finalDate, finalCost, finalParts, finalRemarks, repairId);

      // 2. Restore asset status and append parts summary
      const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(existing.asset_id);
      if (asset) {
        let updatedParts = asset.parts_added_summary || '';
        if (finalParts && !updatedParts.includes(finalParts)) {
          updatedParts = updatedParts ? `${updatedParts}; ${finalParts}` : finalParts;
        }

        db.prepare(`
          UPDATE assets SET
            working_status = ?,
            is_repaired = 1,
            parts_added_summary = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(asset_working_status, updatedParts, existing.asset_id);
      }
    });

    transaction();

    logAudit(req.user.id, req.user.username, 'CLOSE_REPAIR', 'repair', repairId, `Resolved and closed ticket ${existing.ticket_number}`);

    res.json({ message: `Ticket ${existing.ticket_number} successfully resolved and closed. Asset restored to ${asset_working_status}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/repairs/:id - Delete repair ticket (Admin only)
router.delete('/repairs/:id', requireRoles('admin'), (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM repairs WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Repair ticket not found.' });
    }

    db.prepare('DELETE FROM repairs WHERE id = ?').run(req.params.id);
    logAudit(req.user.id, req.user.username, 'DELETE_REPAIR', 'repair', req.params.id, `Deleted repair ticket ${existing.ticket_number}`);

    res.json({ message: 'Repair ticket deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3B. IT EXPENSES & UPKEEP LEDGER
// ==========================================

// GET /api/expenses - Aggregated expenses and upkeep ledger
router.get('/expenses', (req, res) => {
  try {
    const { search, department, repair_type, status, date_from, date_to } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (department && department.trim()) {
      whereClause += ' AND LOWER(a.department) = LOWER(?)';
      params.push(department.trim());
    }

    if (repair_type && repair_type.trim()) {
      whereClause += ' AND r.repair_type = ?';
      params.push(repair_type.trim());
    }

    if (status && status.trim()) {
      whereClause += ' AND r.status = ?';
      params.push(status.trim());
    }

    if (date_from && date_from.trim()) {
      whereClause += ' AND r.repair_date >= ?';
      params.push(date_from.trim());
    }

    if (date_to && date_to.trim()) {
      whereClause += ' AND r.repair_date <= ?';
      params.push(date_to.trim());
    }

    if (search && search.trim()) {
      const term = `%${search.trim().toLowerCase()}%`;
      whereClause += ` AND (
        LOWER(r.ticket_number) LIKE ? OR
        LOWER(a.internal_serial_number) LIKE ? OR
        LOWER(COALESCE(a.assigned_user, '')) LIKE ? OR
        LOWER(COALESCE(a.department, '')) LIKE ? OR
        LOWER(COALESCE(a.brand, '')) LIKE ? OR
        LOWER(COALESCE(a.model_name, '')) LIKE ? OR
        LOWER(r.issue_description) LIKE ? OR
        LOWER(COALESCE(r.parts_added, '')) LIKE ? OR
        LOWER(COALESCE(r.repair_vendor, '')) LIKE ? OR
        LOWER(COALESCE(r.technician_name, '')) LIKE ?
      )`;
      params.push(term, term, term, term, term, term, term, term, term, term);
    }

    // 1. Overall Upkeep Financial Summary
    const summary = db.prepare(`
      SELECT
        COUNT(*) as total_tickets,
        COALESCE(SUM(r.repair_cost), 0) as total_spend,
        COALESCE(SUM(CASE WHEN r.status = 'Completed' THEN r.repair_cost ELSE 0 END), 0) as closed_spend,
        COALESCE(SUM(CASE WHEN r.status IN ('In Progress', 'Awaiting Parts') THEN r.repair_cost ELSE 0 END), 0) as open_liability,
        COALESCE(AVG(r.repair_cost), 0) as average_ticket_cost
      FROM repairs r
      JOIN assets a ON r.asset_id = a.id
      ${whereClause}
    `).get(...params);

    // Top Expense Department
    const topDeptRow = db.prepare(`
      SELECT a.department, SUM(r.repair_cost) as total
      FROM repairs r
      JOIN assets a ON r.asset_id = a.id
      ${whereClause}
      GROUP BY a.department
      ORDER BY total DESC
      LIMIT 1
    `).get(...params);
    summary.top_department = topDeptRow ? {
      department: topDeptRow.department,
      total: topDeptRow.total || 0,
      formatted: `${topDeptRow.department} (₹${(topDeptRow.total || 0).toLocaleString('en-IN')})`
    } : null;

    // Highest Spend Asset
    const topAssetRow = db.prepare(`
      SELECT a.internal_serial_number, a.brand, a.asset_type, a.assigned_user, SUM(r.repair_cost) as total
      FROM repairs r
      JOIN assets a ON r.asset_id = a.id
      ${whereClause}
      GROUP BY a.id
      ORDER BY total DESC
      LIMIT 1
    `).get(...params);
    summary.highest_spend_asset = topAssetRow ? {
      serial: topAssetRow.internal_serial_number,
      brand: topAssetRow.brand || '',
      asset_type: topAssetRow.asset_type,
      assigned_user: topAssetRow.assigned_user || 'Unassigned',
      total: topAssetRow.total || 0,
      formatted: `#${topAssetRow.internal_serial_number} ${topAssetRow.brand || ''} ${topAssetRow.asset_type} (${topAssetRow.assigned_user || 'Unassigned'}) — ₹${(topAssetRow.total || 0).toLocaleString('en-IN')}`
    } : null;

    // 2. Department Breakdown
    const departmentBreakdown = db.prepare(`
      SELECT
        COALESCE(a.department, 'General') as department,
        COUNT(r.id) as ticket_count,
        COALESCE(SUM(r.repair_cost), 0) as total_cost,
        COALESCE(SUM(r.repair_cost), 0) as total_spend
      FROM repairs r
      JOIN assets a ON r.asset_id = a.id
      ${whereClause}
      GROUP BY a.department
      ORDER BY total_cost DESC
    `).all(...params);

    // 3. Asset Type Breakdown
    const assetTypeBreakdown = db.prepare(`
      SELECT
        a.asset_type,
        COUNT(r.id) as ticket_count,
        COALESCE(SUM(r.repair_cost), 0) as total_cost,
        COALESCE(SUM(r.repair_cost), 0) as total_spend
      FROM repairs r
      JOIN assets a ON r.asset_id = a.id
      ${whereClause}
      GROUP BY a.asset_type
      ORDER BY total_cost DESC
    `).all(...params);

    // 4. Detailed Expense Ledger Rows
    const ledger = db.prepare(`
      SELECT
        r.id,
        r.ticket_number,
        r.repair_date,
        r.due_date,
        r.completion_date,
        r.repair_type,
        r.issue_description,
        r.parts_added,
        r.repair_cost,
        r.repair_vendor,
        r.technician_name,
        r.technician_contact,
        r.status,
        r.remarks,
        r.asset_id,
        a.internal_serial_number,
        a.asset_type,
        a.brand,
        a.brand as asset_brand,
        a.model_name,
        a.model_name as asset_model,
        a.assigned_user,
        a.department,
        a.location,
        a.location as asset_location,
        a.working_status as asset_status
      FROM repairs r
      JOIN assets a ON r.asset_id = a.id
      ${whereClause}
      ORDER BY r.repair_date DESC, r.id DESC
    `).all(...params);

    res.json({
      summary,
      stats: summary,
      departmentBreakdown,
      department_breakdown: departmentBreakdown,
      assetTypeBreakdown,
      asset_type_breakdown: assetTypeBreakdown,
      expenses: ledger
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/expenses/export/csv - Download Expense Ledger CSV Report
router.get('/expenses/export/csv', (req, res) => {
  try {
    const { department, repair_type, status, date_from, date_to } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (department && department.trim()) {
      whereClause += ' AND LOWER(a.department) = LOWER(?)';
      params.push(department.trim());
    }
    if (repair_type && repair_type.trim()) {
      whereClause += ' AND r.repair_type = ?';
      params.push(repair_type.trim());
    }
    if (status && status.trim()) {
      whereClause += ' AND r.status = ?';
      params.push(status.trim());
    }
    if (date_from && date_from.trim()) {
      whereClause += ' AND r.repair_date >= ?';
      params.push(date_from.trim());
    }
    if (date_to && date_to.trim()) {
      whereClause += ' AND r.repair_date <= ?';
      params.push(date_to.trim());
    }

    const rows = db.prepare(`
      SELECT
        r.ticket_number,
        r.repair_date,
        COALESCE(r.completion_date, r.due_date, '') as resolution_date,
        a.internal_serial_number,
        a.asset_type,
        COALESCE(a.brand, '') as brand,
        COALESCE(a.model_name, '') as model,
        COALESCE(a.assigned_user, 'Unassigned') as assigned_user,
        COALESCE(a.department, '') as department,
        COALESCE(a.location, '') as location,
        r.repair_type,
        r.issue_description,
        COALESCE(r.parts_added, '') as parts_added,
        COALESCE(r.repair_vendor, '') as vendor,
        COALESCE(r.technician_name, '') as technician,
        r.repair_cost,
        r.status,
        COALESCE(r.remarks, '') as remarks
      FROM repairs r
      JOIN assets a ON r.asset_id = a.id
      ${whereClause}
      ORDER BY r.repair_date DESC, r.id DESC
    `).all(...params);

    const headers = [
      'Ticket #',
      'Service Date',
      'Resolution / Due Date',
      'Internal Serial #',
      'Asset Type',
      'Brand',
      'Model',
      'In Use By (User)',
      'Department',
      'Location',
      'Repair / Expense Type',
      'Issue Description',
      'Parts Replaced / Added',
      'Vendor / Service Center',
      'Technician',
      'Cost (INR)',
      'Status',
      'Remarks'
    ];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    let csvContent = headers.join(',') + '\n';
    rows.forEach(r => {
      const line = [
        escapeCsv(r.ticket_number),
        escapeCsv(r.repair_date),
        escapeCsv(r.resolution_date),
        escapeCsv(r.internal_serial_number),
        escapeCsv(r.asset_type),
        escapeCsv(r.brand),
        escapeCsv(r.model),
        escapeCsv(r.assigned_user),
        escapeCsv(r.department),
        escapeCsv(r.location),
        escapeCsv(r.repair_type),
        escapeCsv(r.issue_description),
        escapeCsv(r.parts_added),
        escapeCsv(r.vendor),
        escapeCsv(r.technician),
        r.repair_cost || 0,
        escapeCsv(r.status),
        escapeCsv(r.remarks)
      ].join(',');
      csvContent += line + '\n';
    });

    const filename = `IT_Expenses_Upkeep_Report_${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csvContent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. QUICK HEAL KEYS ENDPOINTS
// ==========================================

// GET /api/keys - List all keys
router.get('/keys', (req, res) => {
  try {
    const { status, search } = req.query;
    let query = `
      SELECT k.*, a.internal_serial_number, a.brand, a.asset_type, a.assigned_user as asset_assigned_user
      FROM quick_heal_keys k
      LEFT JOIN assets a ON k.assigned_asset_id = a.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ` AND k.status = ?`;
      params.push(status);
    }
    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      query += ` AND (
        k.product_key LIKE ? OR
        k.assigned_user LIKE ? OR
        a.internal_serial_number LIKE ? OR
        a.assigned_user LIKE ?
      )`;
      params.push(term, term, term, term);
    }

    query += ` ORDER BY k.status ASC, k.validity_date ASC, k.id ASC`;

    const keys = db.prepare(query).all(...params);

    // Compute remaining days
    const enriched = keys.map(k => {
      let daysRemaining = null;
      let isExpired = false;
      let isExpiringSoon = false;

      if (k.validity_date) {
        const valDate = new Date(k.validity_date);
        if (!isNaN(valDate.getTime())) {
          const now = new Date();
          const diffDays = Math.ceil((valDate - now) / (1000 * 60 * 60 * 24));
          daysRemaining = diffDays;
          if (diffDays < 0) {
            isExpired = true;
          } else if (diffDays <= 90) {
            isExpiringSoon = true;
          }
        }
      }

      return {
        ...k,
        days_remaining: daysRemaining,
        is_expired: isExpired,
        is_expiring_soon: isExpiringSoon
      };
    });

    res.json({ keys: enriched, total: enriched.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/keys - Add new single Quick Heal key
router.post('/keys', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const { product_key, edition, validity_date, notes } = req.body;
    if (!product_key || !product_key.trim()) {
      return res.status(400).json({ error: 'Product key is required.' });
    }

    const cleanKey = product_key.trim();
    const existing = db.prepare('SELECT id FROM quick_heal_keys WHERE product_key = ?').get(cleanKey);
    if (existing) {
      return res.status(400).json({ error: 'This Quick Heal key already exists in the system.' });
    }

    const insert = db.prepare(`
      INSERT INTO quick_heal_keys (product_key, edition, validity_date, status, notes)
      VALUES (?, ?, ?, 'Available', ?)
    `);

    const result = insert.run(
      cleanKey,
      edition || 'Total Security',
      validity_date || '2029-08-22',
      notes ? notes.trim() : ''
    );

    logAudit(req.user.id, req.user.username, 'CREATE_KEY', 'key', result.lastInsertRowid, `Added Quick Heal key ${cleanKey}`);

    res.status(201).json({ message: 'Quick Heal key added successfully', id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/keys/bulk-add - Bulk import keys
router.post('/keys/bulk-add', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const { raw_keys, default_validity, default_edition } = req.body;
    if (!raw_keys || !raw_keys.trim()) {
      return res.status(400).json({ error: 'Keys input text is required.' });
    }

    const lines = raw_keys.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
    const validity = default_validity || '2029-08-22';
    const edition = default_edition || 'Total Security';

    let addedCount = 0;
    let skippedCount = 0;

    const checkKey = db.prepare('SELECT id FROM quick_heal_keys WHERE product_key = ?');
    const insertKey = db.prepare(`
      INSERT INTO quick_heal_keys (product_key, edition, validity_date, status, notes)
      VALUES (?, ?, ?, 'Available', 'Bulk imported')
    `);

    const transaction = db.transaction(() => {
      for (const line of lines) {
        if (!line) continue;
        const exists = checkKey.get(line);
        if (!exists) {
          insertKey.run(line, edition, validity);
          addedCount++;
        } else {
          skippedCount++;
        }
      }
    });

    transaction();

    logAudit(req.user.id, req.user.username, 'BULK_ADD_KEYS', 'key', null, `Bulk imported ${addedCount} keys (${skippedCount} duplicates skipped)`);

    res.json({ message: `Successfully imported ${addedCount} keys (${skippedCount} skipped as duplicates).`, addedCount, skippedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/keys/:id/map - Map key to asset
router.post('/keys/:id/map', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const keyId = req.params.id;
    const { asset_id } = req.body;

    if (!asset_id) {
      return res.status(400).json({ error: 'Asset ID is required for mapping.' });
    }

    const key = db.prepare('SELECT * FROM quick_heal_keys WHERE id = ?').get(keyId);
    if (!key) {
      return res.status(404).json({ error: 'Key not found.' });
    }

    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(asset_id);
    if (!asset) {
      return res.status(404).json({ error: 'Asset not found.' });
    }

    const transaction = db.transaction(() => {
      // If asset already had an old key, unmap that old key
      if (asset.quick_heal_key_id && asset.quick_heal_key_id !== Number(keyId)) {
        db.prepare(`
          UPDATE quick_heal_keys
          SET status = 'Available', assigned_asset_id = NULL, assigned_user = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(asset.quick_heal_key_id);
      }

      // If this key was previously mapped to another asset, clear that asset
      if (key.assigned_asset_id && key.assigned_asset_id !== Number(asset_id)) {
        db.prepare(`
          UPDATE assets SET quick_heal_key_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(key.assigned_asset_id);
      }

      // Map key to asset
      db.prepare(`
        UPDATE quick_heal_keys
        SET status = 'Assigned', assigned_asset_id = ?, assigned_user = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(asset.id, asset.assigned_user || '', keyId);

      // Link key in asset
      db.prepare(`
        UPDATE assets SET quick_heal_key_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(keyId, asset.id);
    });

    transaction();

    logAudit(req.user.id, req.user.username, 'MAP_KEY', 'key', keyId, `Mapped key ${key.product_key} to asset ${asset.internal_serial_number}`);

    res.json({ message: `Key successfully mapped to asset ${asset.internal_serial_number} (${asset.assigned_user || 'Unassigned'})` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/keys/:id/unmap - Unmap key
router.post('/keys/:id/unmap', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const keyId = req.params.id;
    const key = db.prepare('SELECT * FROM quick_heal_keys WHERE id = ?').get(keyId);
    if (!key) {
      return res.status(404).json({ error: 'Key not found.' });
    }

    const transaction = db.transaction(() => {
      if (key.assigned_asset_id) {
        db.prepare('UPDATE assets SET quick_heal_key_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(key.assigned_asset_id);
      }

      db.prepare(`
        UPDATE quick_heal_keys
        SET status = 'Available', assigned_asset_id = NULL, assigned_user = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(keyId);
    });

    transaction();

    logAudit(req.user.id, req.user.username, 'UNMAP_KEY', 'key', keyId, `Unmapped key ${key.product_key}`);

    res.json({ message: 'Key unmapped successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/keys/:id - Delete key (Admin only)
router.delete('/keys/:id', requireRoles('admin'), (req, res) => {
  try {
    const key = db.prepare('SELECT * FROM quick_heal_keys WHERE id = ?').get(req.params.id);
    if (!key) {
      return res.status(404).json({ error: 'Key not found.' });
    }

    if (key.assigned_asset_id) {
      db.prepare('UPDATE assets SET quick_heal_key_id = NULL WHERE id = ?').run(key.assigned_asset_id);
    }

    db.prepare('DELETE FROM quick_heal_keys WHERE id = ?').run(req.params.id);
    logAudit(req.user.id, req.user.username, 'DELETE_KEY', 'key', req.params.id, `Deleted key ${key.product_key}`);

    res.json({ message: 'Key deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 5. ACCESSORIES ENDPOINTS
// ==========================================

// GET /api/accessories
router.get('/accessories', (req, res) => {
  try {
    const { category, status, search } = req.query;
    let query = `
      SELECT acc.*, a.internal_serial_number as asset_serial, a.assigned_user as asset_user
      FROM accessories acc
      LEFT JOIN assets a ON acc.assigned_asset_id = a.id
      WHERE 1=1
    `;
    const params = [];

    if (category) {
      query += ` AND acc.category = ?`;
      params.push(category);
    }
    if (status) {
      query += ` AND acc.status = ?`;
      params.push(status);
    }
    if (search && search.trim()) {
      const term = `%${search.trim().toLowerCase()}%`;
      query += ` AND (
        LOWER(acc.accessory_code) LIKE ? OR
        LOWER(acc.name) LIKE ? OR
        LOWER(acc.brand) LIKE ? OR
        LOWER(acc.model) LIKE ? OR
        LOWER(COALESCE(acc.assigned_user, '')) LIKE ? OR
        LOWER(COALESCE(acc.location, '')) LIKE ?
      )`;
      params.push(term, term, term, term, term, term);
    }

    query += ` ORDER BY acc.id ASC`;
    const accessories = db.prepare(query).all(...params);

    // Compute live inventory summary statistics
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_records,
        COALESCE(SUM(quantity), 0) as total_units,
        COALESCE(SUM(CASE WHEN status = 'In Stock' THEN quantity ELSE 0 END), 0) as in_stock_units,
        COALESCE(SUM(CASE WHEN status = 'Assigned' THEN quantity ELSE 0 END), 0) as assigned_units,
        COALESCE(SUM(CASE WHEN status IN ('Damaged', 'Scrapped') THEN quantity ELSE 0 END), 0) as damaged_units
      FROM accessories
    `).get();

    res.json({ accessories, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accessories - Add new accessory
router.post('/accessories', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const { accessory_code, name, category, brand, model, serial_number, quantity, assigned_user, assigned_asset_id, location, status, purchase_date, cost, remarks } = req.body;

    if (!name || !category) {
      return res.status(400).json({ error: 'Accessory name and category are required.' });
    }

    // Auto-generate code if missing
    let code = accessory_code ? accessory_code.trim() : '';
    if (!code) {
      const count = db.prepare('SELECT COUNT(*) as c FROM accessories').get().c;
      code = `ACC-${String(count + 1).padStart(3, '0')}`;
    }

    const insert = db.prepare(`
      INSERT INTO accessories (
        accessory_code, name, category, brand, model, serial_number,
        quantity, assigned_user, assigned_asset_id, location, status,
        purchase_date, cost, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      code,
      name.trim(),
      category.trim(),
      brand ? brand.trim() : '',
      model ? model.trim() : '',
      serial_number ? serial_number.trim() : '',
      Number(quantity) || 1,
      assigned_user ? assigned_user.trim() : '',
      assigned_asset_id || null,
      location ? location.trim() : 'IT Store Room',
      status || 'In Stock',
      purchase_date || null,
      Number(cost) || 0,
      remarks ? remarks.trim() : ''
    );

    logAudit(req.user.id, req.user.username, 'CREATE_ACCESSORY', 'accessory', result.lastInsertRowid, `Created accessory ${code} - ${name}`);

    res.status(201).json({ message: 'Accessory added successfully', id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/accessories/:id
router.put('/accessories/:id', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const accId = req.params.id;
    const existing = db.prepare('SELECT * FROM accessories WHERE id = ?').get(accId);
    if (!existing) {
      return res.status(404).json({ error: 'Accessory not found.' });
    }

    const { accessory_code, name, category, brand, model, serial_number, quantity, assigned_user, assigned_asset_id, location, status, purchase_date, cost, remarks } = req.body;

    db.prepare(`
      UPDATE accessories SET
        accessory_code = COALESCE(?, accessory_code),
        name = COALESCE(?, name),
        category = COALESCE(?, category),
        brand = COALESCE(?, brand),
        model = COALESCE(?, model),
        serial_number = COALESCE(?, serial_number),
        quantity = COALESCE(?, quantity),
        assigned_user = COALESCE(?, assigned_user),
        assigned_asset_id = ?,
        location = COALESCE(?, location),
        status = COALESCE(?, status),
        purchase_date = ?,
        cost = COALESCE(?, cost),
        remarks = COALESCE(?, remarks),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      accessory_code,
      name,
      category,
      brand,
      model,
      serial_number,
      quantity !== undefined ? Number(quantity) : existing.quantity,
      assigned_user,
      assigned_asset_id || null,
      location,
      status,
      purchase_date || null,
      cost !== undefined ? Number(cost) : existing.cost,
      remarks,
      accId
    );

    logAudit(req.user.id, req.user.username, 'UPDATE_ACCESSORY', 'accessory', accId, `Updated accessory ${existing.accessory_code}`);

    res.json({ message: 'Accessory updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accessories/:id/assign - Assign accessory to a person or asset with quantity support
router.post('/accessories/:id/assign', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const accId = req.params.id;
    const existing = db.prepare('SELECT * FROM accessories WHERE id = ?').get(accId);
    if (!existing) {
      return res.status(404).json({ error: 'Accessory not found.' });
    }

    const { assigned_user, assigned_asset_id, location, remarks, quantity } = req.body;
    if (!assigned_user || !assigned_user.trim()) {
      return res.status(400).json({ error: 'Person/User name is required for assignment.' });
    }

    const assignQty = Math.max(1, parseInt(quantity, 10) || 1);
    if (assignQty > existing.quantity) {
      return res.status(400).json({
        error: `Requested quantity (${assignQty}) exceeds available stock (${existing.quantity}).`
      });
    }

    const transaction = db.transaction(() => {
      if (assignQty === existing.quantity) {
        // Entire batch is assigned to this user
        db.prepare(`
          UPDATE accessories SET
            status = 'Assigned',
            assigned_user = ?,
            assigned_asset_id = ?,
            location = COALESCE(?, location),
            remarks = COALESCE(?, remarks),
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          assigned_user.trim(),
          assigned_asset_id || null,
          location ? location.trim() : null,
          remarks ? remarks.trim() : null,
          accId
        );
      } else {
        // Partial assignment: deduct assignQty from available in-stock batch
        db.prepare(`
          UPDATE accessories SET
            quantity = quantity - ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(assignQty, accId);

        // Find a unique accessory code for the newly assigned batch
        const baseCode = existing.accessory_code.replace(/-A\d+$/, '');
        let newCode = `${baseCode}-A1`;
        let counter = 1;
        while (db.prepare('SELECT id FROM accessories WHERE accessory_code = ?').get(newCode)) {
          counter++;
          newCode = `${baseCode}-A${counter}`;
        }

        // Insert new assigned record
        db.prepare(`
          INSERT INTO accessories (
            accessory_code, name, category, brand, model, serial_number,
            quantity, assigned_user, assigned_asset_id, location, status,
            purchase_date, cost, remarks
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Assigned', ?, ?, ?)
        `).run(
          newCode,
          existing.name,
          existing.category,
          existing.brand || '',
          existing.model || '',
          existing.serial_number || '',
          assignQty,
          assigned_user.trim(),
          assigned_asset_id || null,
          location ? location.trim() : (existing.location || 'Assigned to Staff'),
          existing.purchase_date || null,
          existing.cost || 0,
          remarks ? remarks.trim() : existing.remarks
        );
      }
    });

    transaction();

    logAudit(req.user.id, req.user.username, 'ASSIGN_ACCESSORY', 'accessory', accId, `Assigned ${assignQty} unit(s) of ${existing.name} (${existing.accessory_code}) to ${assigned_user}`);

    res.json({ message: `Successfully assigned ${assignQty} unit(s) of ${existing.name} to ${assigned_user.trim()}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accessories/:id/return - Return accessory back to stock
router.post('/accessories/:id/return', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const accId = req.params.id;
    const existing = db.prepare('SELECT * FROM accessories WHERE id = ?').get(accId);
    if (!existing) {
      return res.status(404).json({ error: 'Accessory not found.' });
    }

    const { location = 'IT Store Room', remarks, quantity } = req.body;
    const returnQty = Math.min(existing.quantity, Math.max(1, parseInt(quantity, 10) || existing.quantity));

    const transaction = db.transaction(() => {
      // Look for a parent or matching in-stock batch
      const baseCode = existing.accessory_code.replace(/-A\d+$/, '');
      const inStockBatch = db.prepare(`
        SELECT * FROM accessories
        WHERE (accessory_code = ? OR (name = ? AND category = ? AND status = 'In Stock'))
          AND status = 'In Stock'
        ORDER BY id ASC LIMIT 1
      `).get(baseCode, existing.name, existing.category);

      if (inStockBatch && inStockBatch.id !== existing.id) {
        // Merge returned units into the in-stock batch
        db.prepare(`
          UPDATE accessories SET
            quantity = quantity + ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(returnQty, inStockBatch.id);

        if (returnQty >= existing.quantity) {
          // Remove the assigned record
          db.prepare('DELETE FROM accessories WHERE id = ?').run(accId);
        } else {
          // Decrement remaining assigned units
          db.prepare(`
            UPDATE accessories SET
              quantity = quantity - ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(returnQty, accId);
        }
      } else {
        // Restore this item itself back to In Stock
        db.prepare(`
          UPDATE accessories SET
            status = 'In Stock',
            assigned_user = '',
            assigned_asset_id = NULL,
            location = ?,
            remarks = COALESCE(?, remarks),
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(location.trim(), remarks ? remarks.trim() : null, accId);
      }
    });

    transaction();

    logAudit(req.user.id, req.user.username, 'RETURN_ACCESSORY', 'accessory', accId, `Returned ${returnQty} unit(s) of accessory ${existing.accessory_code} to stock`);

    res.json({ message: `Accessory returned to stock (${location}).` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/accessories/:id (Admin only)
router.delete('/accessories/:id', requireRoles('admin'), (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM accessories WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Accessory not found.' });
    }

    db.prepare('DELETE FROM accessories WHERE id = ?').run(req.params.id);
    logAudit(req.user.id, req.user.username, 'DELETE_ACCESSORY', 'accessory', req.params.id, `Deleted accessory ${existing.accessory_code}`);

    res.json({ message: 'Accessory deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accessories/template/csv - Download Accessories CSV Template
router.get('/accessories/template/csv', (req, res) => {
  const headers = [
    'Accessory Code',
    'Category',
    'Item Name',
    'Brand',
    'Model',
    'Serial Number',
    'Quantity',
    'Location',
    'Status',
    'Remarks'
  ];

  const sampleRows = [
    ['ACC-010', 'Mouse', 'Logitech B100 USB Optical Mouse', 'Logitech', 'B100', '', '10', 'IT Store Room', 'In Stock', 'Spare optical mice for workstations'],
    ['ACC-011', 'Keyboard', 'Dell KB216 Wired Standard Keyboard', 'Dell', 'KB216', '', '5', 'IT Store Room', 'In Stock', 'Spare English layout keyboards'],
    ['ACC-012', 'Scanner', 'Zebra DS2208 Handheld Barcode Scanner', 'Zebra', 'DS2208', '', '2', 'Dispatch Bay', 'In Stock', 'Handheld 2D scanners ready for dispatch stations'],
    ['ACC-013', 'Print Head', 'TSC Thermal Printhead 203 DPI', 'TSC', 'TE244', '', '3', 'IT Store Room', 'In Stock', 'Replacement thermal heads for barcode printers']
  ];

  const escapeCsv = (val) => `"${String(val || '').replace(/"/g, '""')}"`;
  let csv = headers.join(',') + '\n';
  sampleRows.forEach(row => {
    csv += row.map(escapeCsv).join(',') + '\n';
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="accessories_import_template.csv"');
  res.status(200).send(csv);
});

// POST /api/accessories/bulk-import - Bulk import accessories from CSV or Excel
router.post('/accessories/bulk-import', requireRoles('admin', 'technician'), upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a CSV or Excel (.xlsx) file.' });
    }

    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      return res.status(400).json({ error: 'Spreadsheet has no sheets.' });
    }

    const rawRows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    if (!rawRows || rawRows.length === 0) {
      return res.status(400).json({ error: 'Spreadsheet contains no data rows.' });
    }

    const validCategories = ['Mouse', 'Keyboard', 'Scanner', 'Print Head', 'Cable/Adapter', 'UPS', 'Other'];
    let importedCount = 0;
    let skippedCount = 0;
    const errors = [];

    // Get initial max code counter
    const existingCodes = db.prepare('SELECT accessory_code FROM accessories').all().map(r => r.accessory_code);
    let nextNum = 1;
    existingCodes.forEach(c => {
      const match = c.match(/ACC-(\d+)/i);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num >= nextNum) nextNum = num + 1;
      }
    });

    const insertStmt = db.prepare(`
      INSERT INTO accessories (
        accessory_code, name, category, brand, model, serial_number,
        quantity, assigned_user, location, status, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const updateStockStmt = db.prepare(`
      UPDATE accessories
      SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    const transaction = db.transaction(() => {
      rawRows.forEach((row, idx) => {
        const rowNum = idx + 2;
        // Normalize keys
        const cleanRow = {};
        for (const k of Object.keys(row)) {
          cleanRow[k.trim().toLowerCase()] = String(row[k]).trim();
        }

        const name = cleanRow['name'] || cleanRow['item name'] || cleanRow['accessory name'] || '';
        if (!name) {
          skippedCount++;
          errors.push(`Row ${rowNum}: Name is required.`);
          return;
        }

        let category = cleanRow['category'] || 'Other';
        const matchedCat = validCategories.find(c => c.toLowerCase() === category.toLowerCase());
        category = matchedCat || 'Other';

        const brand = cleanRow['brand'] || '';
        const model = cleanRow['model'] || '';
        const serial = cleanRow['serial number'] || cleanRow['serial_number'] || cleanRow['serial'] || '';
        const qty = Math.max(1, parseInt(cleanRow['quantity'] || cleanRow['qty'], 10) || 1);
        const location = cleanRow['location'] || 'IT Store Room';
        let status = cleanRow['status'] || 'In Stock';
        if (!['In Stock', 'Assigned', 'Damaged'].includes(status)) status = 'In Stock';
        const user = cleanRow['assigned to'] || cleanRow['assigned_user'] || cleanRow['user'] || null;
        const remarks = cleanRow['remarks'] || cleanRow['notes'] || '';

        let code = cleanRow['accessory code'] || cleanRow['accessory_code'] || cleanRow['code'] || '';
        if (!code) {
          code = `ACC-${String(nextNum).padStart(3, '0')}`;
          nextNum++;
        }

        // Check if code already exists
        const existing = db.prepare('SELECT id, status FROM accessories WHERE accessory_code = ?').get(code);
        if (existing) {
          if (existing.status === 'In Stock' && status === 'In Stock') {
            // Merge quantity into existing in-stock batch
            updateStockStmt.run(qty, existing.id);
            importedCount++;
            return;
          } else {
            // Generate a fresh unique code
            code = `ACC-${String(nextNum).padStart(3, '0')}`;
            nextNum++;
          }
        }

        insertStmt.run(code, name, category, brand, model, serial, qty, user, location, status, remarks);
        importedCount++;
      });
    });

    transaction();

    logAudit(req.user.id, req.user.username, 'BULK_IMPORT_ACCESSORIES', 'accessory', 'BULK', `Bulk imported ${importedCount} accessories (${skippedCount} skipped)`);

    res.json({
      message: `Bulk import completed: ${importedCount} accessories imported, ${skippedCount} skipped.`,
      imported_count: importedCount,
      skipped_count: skippedCount,
      errors: errors.slice(0, 10)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 6. MASTER SEARCH ENDPOINT
// ==========================================
router.get('/search', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) {
      return res.json({
        query: '',
        totalResults: 0,
        assets: [],
        repairs: [],
        keys: [],
        accessories: [],
        users: []
      });
    }

    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);

    // 1. Assets Tokenized Search
    let assetQuery = `
      SELECT a.*, k.product_key as quick_heal_key_str
      FROM assets a
      LEFT JOIN quick_heal_keys k ON a.quick_heal_key_id = k.id
      WHERE 1=1
    `;
    const assetParams = [];
    tokens.forEach(tok => {
      const term = `%${tok}%`;
      assetQuery += ` AND (
        LOWER(a.internal_serial_number) LIKE ? OR
        LOWER(a.asset_type) LIKE ? OR
        LOWER(a.brand) LIKE ? OR
        LOWER(COALESCE(a.model_name, '')) LIKE ? OR
        LOWER(COALESCE(a.serial_number, '')) LIKE ? OR
        LOWER(COALESCE(a.department, '')) LIKE ? OR
        LOWER(COALESCE(a.location, '')) LIKE ? OR
        LOWER(COALESCE(a.assigned_user, '')) LIKE ? OR
        LOWER(COALESCE(k.product_key, '')) LIKE ? OR
        LOWER(COALESCE(a.parts_added_summary, '')) LIKE ?
      )`;
      assetParams.push(term, term, term, term, term, term, term, term, term, term);
    });

    assetQuery += ` ORDER BY
      CASE
        WHEN LOWER(a.assigned_user) LIKE ? THEN 0
        WHEN LOWER(a.internal_serial_number) LIKE ? THEN 1
        WHEN LOWER(a.brand) LIKE ? THEN 2
        WHEN LOWER(COALESCE(a.department, '')) LIKE ? THEN 3
        ELSE 4
      END ASC,
      CAST(a.internal_serial_number AS INTEGER) ASC LIMIT 25`;
    const fullPattern = `%${q.toLowerCase()}%`;
    assetParams.push(fullPattern, fullPattern, fullPattern, fullPattern);
    const assets = db.prepare(assetQuery).all(...assetParams);

    // 2. Repairs Tokenized Search
    let repairQuery = `
      SELECT r.*, a.internal_serial_number, a.brand, a.asset_type, a.assigned_user
      FROM repairs r
      JOIN assets a ON r.asset_id = a.id
      WHERE 1=1
    `;
    const repairParams = [];
    tokens.forEach(tok => {
      const term = `%${tok}%`;
      repairQuery += ` AND (
        LOWER(r.ticket_number) LIKE ? OR
        LOWER(r.issue_description) LIKE ? OR
        LOWER(COALESCE(r.repair_vendor, '')) LIKE ? OR
        LOWER(COALESCE(r.technician_name, '')) LIKE ? OR
        LOWER(COALESCE(r.parts_added, '')) LIKE ? OR
        LOWER(a.internal_serial_number) LIKE ? OR
        LOWER(COALESCE(a.assigned_user, '')) LIKE ?
      )`;
      repairParams.push(term, term, term, term, term, term, term);
    });
    repairQuery += ` ORDER BY r.created_at DESC LIMIT 20`;
    const repairs = db.prepare(repairQuery).all(...repairParams);

    // 3. Keys Tokenized Search
    let keyQuery = `
      SELECT k.*, a.internal_serial_number, a.assigned_user as asset_assigned_user
      FROM quick_heal_keys k
      LEFT JOIN assets a ON k.assigned_asset_id = a.id
      WHERE 1=1
    `;
    const keyParams = [];
    tokens.forEach(tok => {
      const term = `%${tok}%`;
      keyQuery += ` AND (
        LOWER(k.product_key) LIKE ? OR
        LOWER(COALESCE(k.assigned_user, '')) LIKE ? OR
        LOWER(COALESCE(a.internal_serial_number, '')) LIKE ?
      )`;
      keyParams.push(term, term, term);
    });
    keyQuery += ` ORDER BY k.status ASC, k.validity_date ASC LIMIT 20`;
    const keys = db.prepare(keyQuery).all(...keyParams);

    // 4. Accessories Tokenized Search
    let accQuery = `
      SELECT acc.*, a.internal_serial_number as asset_serial
      FROM accessories acc
      LEFT JOIN assets a ON acc.assigned_asset_id = a.id
      WHERE 1=1
    `;
    const accParams = [];
    tokens.forEach(tok => {
      const term = `%${tok}%`;
      accQuery += ` AND (
        LOWER(acc.accessory_code) LIKE ? OR
        LOWER(acc.name) LIKE ? OR
        LOWER(acc.category) LIKE ? OR
        LOWER(COALESCE(acc.brand, '')) LIKE ? OR
        LOWER(COALESCE(acc.model, '')) LIKE ? OR
        LOWER(COALESCE(acc.assigned_user, '')) LIKE ? OR
        LOWER(COALESCE(acc.location, '')) LIKE ?
      )`;
      accParams.push(term, term, term, term, term, term, term);
    });
    accQuery += ` ORDER BY acc.id ASC LIMIT 20`;
    const accessories = db.prepare(accQuery).all(...accParams);

    // 5. Users Search (Admin and Technicians only)
    let users = [];
    if (['admin', 'technician'].includes(req.user.role)) {
      let userQuery = `SELECT id, username, full_name, email, role, status FROM users WHERE 1=1`;
      const userParams = [];
      tokens.forEach(tok => {
        const term = `%${tok}%`;
        userQuery += ` AND (
          LOWER(username) LIKE ? OR
          LOWER(full_name) LIKE ? OR
          LOWER(COALESCE(email, '')) LIKE ? OR
          LOWER(role) LIKE ?
        )`;
        userParams.push(term, term, term, term);
      });
      userQuery += ` LIMIT 10`;
      users = db.prepare(userQuery).all(...userParams);
    }

    const totalResults = assets.length + repairs.length + keys.length + accessories.length + users.length;

    res.json({
      query: q,
      totalResults,
      assets,
      repairs,
      keys,
      accessories,
      users
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 7. USER MANAGEMENT & SETTINGS (ADMIN ONLY)
// ==========================================

// GET /api/users - List users
router.get('/users', requireRoles('admin'), (req, res) => {
  try {
    const users = db.prepare(`
      SELECT id, username, full_name, email, role, status, created_at, updated_at
      FROM users
      ORDER BY id ASC
    `).all();
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users - Add user
router.post('/users', requireRoles('admin'), (req, res) => {
  try {
    const { username, password, full_name, email, role, status } = req.body;
    if (!username || !password || !full_name) {
      return res.status(400).json({ error: 'Username, password, and full name are required.' });
    }

    const cleanUser = username.trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(cleanUser);
    if (existing) {
      return res.status(400).json({ error: 'Username is already taken.' });
    }

    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(password, salt);

    const insert = db.prepare(`
      INSERT INTO users (username, password_hash, full_name, email, role, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      cleanUser,
      hash,
      full_name.trim(),
      email ? email.trim() : '',
      ['admin', 'technician', 'viewer'].includes(role) ? role : 'viewer',
      status || 'active'
    );

    logAudit(req.user.id, req.user.username, 'CREATE_USER', 'user', result.lastInsertRowid, `Created user ${cleanUser} with role ${role}`);

    res.status(201).json({ message: 'User created successfully', id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/:id - Update user / change role
router.put('/users/:id', requireRoles('admin'), (req, res) => {
  try {
    const targetUserId = req.params.id;
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId);
    if (!existing) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const { full_name, email, role, status, new_password } = req.body;

    let hash = existing.password_hash;
    if (new_password && new_password.trim().length >= 6) {
      const salt = bcrypt.genSaltSync(10);
      hash = bcrypt.hashSync(new_password.trim(), salt);
    }

    db.prepare(`
      UPDATE users SET
        full_name = COALESCE(?, full_name),
        email = COALESCE(?, email),
        role = COALESCE(?, role),
        status = COALESCE(?, status),
        password_hash = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      full_name ? full_name.trim() : null,
      email !== undefined ? email.trim() : null,
      ['admin', 'technician', 'viewer'].includes(role) ? role : existing.role,
      ['active', 'inactive'].includes(status) ? status : existing.status,
      hash,
      targetUserId
    );

    logAudit(req.user.id, req.user.username, 'UPDATE_USER', 'user', targetUserId, `Updated user ${existing.username} details/role`);

    res.json({ message: 'User updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/users/:id - Delete user
router.delete('/users/:id', requireRoles('admin'), (req, res) => {
  try {
    const targetUserId = Number(req.params.id);
    if (targetUserId === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }

    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId);
    if (!existing) {
      return res.status(404).json({ error: 'User not found.' });
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(targetUserId);
    logAudit(req.user.id, req.user.username, 'DELETE_USER', 'user', targetUserId, `Deleted user ${existing.username}`);

    res.json({ message: 'User deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users/:id/reset-password - Quick password reset by Admin
router.post('/users/:id/reset-password', requireRoles('admin'), (req, res) => {
  try {
    const new_password = req.body.new_password || req.body.password;
    if (!new_password || new_password.trim().length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long.' });
    }

    const existing = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(new_password.trim(), salt);

    db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, req.params.id);
    logAudit(req.user.id, req.user.username, 'RESET_PASSWORD', 'user', req.params.id, `Reset password for user @${existing.username}`);

    res.json({ message: `Password for @${existing.username} successfully updated.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/audit-logs - View audit trail
router.get('/audit-logs', requireRoles('admin'), (req, res) => {
  try {
    const logs = db.prepare(`
      SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100
    `).all();
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
