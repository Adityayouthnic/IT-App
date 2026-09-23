const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { db } = require('../database');
const { authenticateToken, requireRoles, logAudit } = require('../auth');

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
        COALESCE(SUM(repair_cost), 0) as total_cost
      FROM repairs
    `).get();

    // Accessories counts
    const accStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(quantity), 0) as total_units,
        SUM(CASE WHEN status = 'In Stock' THEN quantity ELSE 0 END) as in_stock_units
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

    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      query += ` AND (
        a.internal_serial_number LIKE ? OR
        a.asset_type LIKE ? OR
        a.brand LIKE ? OR
        a.model_name LIKE ? OR
        a.department LIKE ? OR
        a.location LIKE ? OR
        a.assigned_user LIKE ? OR
        a.remarks LIKE ? OR
        a.parts_added_summary LIKE ? OR
        k.product_key LIKE ?
      )`;
      params.push(term, term, term, term, term, term, term, term, term, term);
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
    }

    query += ` ORDER BY CAST(a.internal_serial_number AS INTEGER) ASC, a.id ASC`;

    const assets = db.prepare(query).all(...params);

    // Enrich with lifecycle info
    const enriched = assets.map(asset => {
      const lifecycle = computeAssetLifecycle(asset, asset.repair_count, asset.total_repair_cost);
      return { ...asset, ...lifecycle };
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

    // Fetch linked accessories
    const accessories = db.prepare(`
      SELECT * FROM accessories WHERE assigned_asset_id = ?
    `).all(asset.id);

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

    db.prepare(`
      UPDATE assets SET
        internal_serial_number = COALESCE(?, internal_serial_number),
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
      internal_serial_number,
      asset_type,
      brand,
      model_name,
      serial_number,
      purchase_date || null,
      purchase_vendor,
      purchase_cost !== undefined ? Number(purchase_cost) : existing.purchase_cost,
      department,
      location,
      assigned_user,
      newKeyId,
      working_status,
      condition_rating,
      is_repaired !== undefined ? (is_repaired ? 1 : 0) : existing.is_repaired,
      parts_added_summary,
      remarks,
      assetId
    );

    logAudit(req.user.id, req.user.username, 'UPDATE_ASSET', 'asset', assetId, `Updated asset ${internal_serial_number || existing.internal_serial_number}`);

    res.json({ message: 'Asset updated successfully' });
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

// GET /api/repairs - List repair tickets
router.get('/repairs', (req, res) => {
  try {
    const { status, asset_id, search } = req.query;
    let query = `
      SELECT r.*, a.internal_serial_number, a.brand, a.asset_type, a.assigned_user, a.department
      FROM repairs r
      JOIN assets a ON r.asset_id = a.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ` AND r.status = ?`;
      params.push(status);
    }
    if (asset_id) {
      query += ` AND r.asset_id = ?`;
      params.push(asset_id);
    }
    if (search && search.trim()) {
      const term = `%${search.trim()}%`;
      query += ` AND (
        r.ticket_number LIKE ? OR
        r.issue_description LIKE ? OR
        r.repair_vendor LIKE ? OR
        r.technician_name LIKE ? OR
        r.parts_added LIKE ? OR
        r.remarks LIKE ? OR
        a.internal_serial_number LIKE ? OR
        a.assigned_user LIKE ?
      )`;
      params.push(term, term, term, term, term, term, term, term);
    }

    query += ` ORDER BY r.created_at DESC`;
    const repairs = db.prepare(query).all(...params);
    res.json({ repairs });
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
        ticket_number, asset_id, issue_description, repair_date, repair_vendor,
        technician_name, technician_contact, repair_type, parts_added,
        repair_cost, status, remarks, warranty_months
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      ticket_number,
      asset_id,
      issue_description.trim(),
      repair_date,
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
      // Append parts to parts_added_summary
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
    const newCompletionDate = (newStatus === 'Completed' && !completion_date) ? new Date().toISOString().split('T')[0] : completion_date;

    db.prepare(`
      UPDATE repairs SET
        issue_description = COALESCE(?, issue_description),
        repair_date = COALESCE(?, repair_date),
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
        k.notes LIKE ? OR
        k.assigned_user LIKE ? OR
        a.internal_serial_number LIKE ? OR
        a.assigned_user LIKE ?
      )`;
      params.push(term, term, term, term, term);
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
      const term = `%${search.trim()}%`;
      query += ` AND (
        acc.accessory_code LIKE ? OR
        acc.name LIKE ? OR
        acc.brand LIKE ? OR
        acc.model LIKE ? OR
        acc.assigned_user LIKE ? OR
        acc.location LIKE ? OR
        acc.remarks LIKE ?
      )`;
      params.push(term, term, term, term, term, term, term);
    }

    query += ` ORDER BY acc.id ASC`;
    const accessories = db.prepare(query).all(...params);
    res.json({ accessories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accessories
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

// ==========================================
// 6. MASTER SEARCH ENDPOINT
// ==========================================
router.get('/search', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) {
      return res.json({
        totalResults: 0,
        assets: [],
        repairs: [],
        keys: [],
        accessories: [],
        users: []
      });
    }

    const term = `%${q}%`;

    // 1. Search Assets
    const assets = db.prepare(`
      SELECT a.*, k.product_key as quick_heal_key_str
      FROM assets a
      LEFT JOIN quick_heal_keys k ON a.quick_heal_key_id = k.id
      WHERE a.internal_serial_number LIKE ?
         OR a.asset_type LIKE ?
         OR a.brand LIKE ?
         OR a.model_name LIKE ?
         OR a.department LIKE ?
         OR a.location LIKE ?
         OR a.assigned_user LIKE ?
         OR a.remarks LIKE ?
         OR a.parts_added_summary LIKE ?
         OR a.working_status LIKE ?
         OR k.product_key LIKE ?
      LIMIT 20
    `).all(term, term, term, term, term, term, term, term, term, term, term);

    // 2. Search Repairs
    const repairs = db.prepare(`
      SELECT r.*, a.internal_serial_number, a.brand, a.asset_type, a.assigned_user
      FROM repairs r
      JOIN assets a ON r.asset_id = a.id
      WHERE r.ticket_number LIKE ?
         OR r.issue_description LIKE ?
         OR r.repair_vendor LIKE ?
         OR r.technician_name LIKE ?
         OR r.parts_added LIKE ?
         OR r.remarks LIKE ?
         OR a.internal_serial_number LIKE ?
         OR a.assigned_user LIKE ?
      LIMIT 20
    `).all(term, term, term, term, term, term, term, term);

    // 3. Search Quick Heal Keys
    const keys = db.prepare(`
      SELECT k.*, a.internal_serial_number, a.assigned_user as asset_assigned_user
      FROM quick_heal_keys k
      LEFT JOIN assets a ON k.assigned_asset_id = a.id
      WHERE k.product_key LIKE ?
         OR k.assigned_user LIKE ?
         OR k.notes LIKE ?
         OR a.internal_serial_number LIKE ?
      LIMIT 20
    `).all(term, term, term, term);

    // 4. Search Accessories
    const accessories = db.prepare(`
      SELECT acc.*, a.internal_serial_number as asset_serial
      FROM accessories acc
      LEFT JOIN assets a ON acc.assigned_asset_id = a.id
      WHERE acc.accessory_code LIKE ?
         OR acc.name LIKE ?
         OR acc.category LIKE ?
         OR acc.brand LIKE ?
         OR acc.model LIKE ?
         OR acc.assigned_user LIKE ?
         OR acc.location LIKE ?
         OR acc.remarks LIKE ?
      LIMIT 20
    `).all(term, term, term, term, term, term, term, term);

    // 5. Search Users (Admin and Technicians only)
    let users = [];
    if (['admin', 'technician'].includes(req.user.role)) {
      users = db.prepare(`
        SELECT id, username, full_name, email, role, status
        FROM users
        WHERE username LIKE ? OR full_name LIKE ? OR email LIKE ? OR role LIKE ?
        LIMIT 10
      `).all(term, term, term, term);
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
