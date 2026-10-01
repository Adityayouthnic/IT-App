const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const xlsx = require('xlsx');
const ExcelJS = require('exceljs');
const { db, purgeOperationalData } = require('../database');
const { authenticateToken, requireRoles, logAudit } = require('../auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// All API routes require authentication
router.use(authenticateToken);

// ==========================================
// FREE & OCCUPIED ASSET HELPERS
// ==========================================
const FREE_USER_CONDITIONS = ['unassigned', 'free', 'none', 'n/a', 'na', 'null', 'nil', '-', '—', 'spare', 'stock', 'available', 'not assigned'];

function isFreeAsset(assignedUser) {
  if (!assignedUser) return true;
  const cleaned = String(assignedUser).trim().toLowerCase();
  return cleaned === '' || FREE_USER_CONDITIONS.includes(cleaned);
}

const FREE_ASSET_SQL = `(a.assigned_user IS NULL OR TRIM(a.assigned_user) = '' OR LOWER(TRIM(a.assigned_user)) IN ('unassigned', 'free', 'none', 'n/a', 'na', 'null', 'nil', '-', '—', 'spare', 'stock', 'available', 'not assigned'))`;
const OCCUPIED_ASSET_SQL = `(a.assigned_user IS NOT NULL AND TRIM(a.assigned_user) != '' AND LOWER(TRIM(a.assigned_user)) NOT IN ('unassigned', 'free', 'none', 'n/a', 'na', 'null', 'nil', '-', '—', 'spare', 'stock', 'available', 'not assigned'))`;

// ==========================================
// 1. DASHBOARD & KPIS
// ==========================================
router.get('/dashboard/stats', (req, res) => {
  try {
    // Asset counts (including Free / In Stock vs Occupied)
    const assetStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN working_status = 'Working' THEN 1 ELSE 0 END) as working,
        SUM(CASE WHEN working_status = 'In Repair' THEN 1 ELSE 0 END) as in_repair,
        SUM(CASE WHEN working_status = 'Not Working' THEN 1 ELSE 0 END) as not_working,
        SUM(CASE WHEN working_status = 'Retired' THEN 1 ELSE 0 END) as retired,
        SUM(CASE WHEN is_repaired = 1 THEN 1 ELSE 0 END) as repaired_count,
        SUM(CASE WHEN assigned_user IS NULL OR TRIM(assigned_user) = '' OR LOWER(TRIM(assigned_user)) IN ('unassigned', 'free', 'none', 'n/a', 'na', 'null', 'nil', '-', '—', 'spare', 'stock', 'available', 'not assigned') THEN 1 ELSE 0 END) as free_assets,
        SUM(CASE WHEN assigned_user IS NOT NULL AND TRIM(assigned_user) != '' AND LOWER(TRIM(assigned_user)) NOT IN ('unassigned', 'free', 'none', 'n/a', 'na', 'null', 'nil', '-', '—', 'spare', 'stock', 'available', 'not assigned') THEN 1 ELSE 0 END) as occupied_assets
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
        SUM(CASE WHEN validity_date IS NOT NULL AND date(validity_date) <= date('now', '+30 days') THEN 1 ELSE 0 END) as expiring_soon
      FROM quick_heal_keys
    `).get();

    // Repair ticket counts & financial cost
    const repairStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'Pending Approval' THEN 1 ELSE 0 END) as pending_approval,
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

    // User Master / Employees Count
    const employeeStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END), 0) as active
      FROM employees
    `).get();

    // Department Master Count
    const departmentStats = db.prepare(`
      SELECT COUNT(*) as total FROM departments
    `).get();

    // Breakdown of Free / Unoccupied Assets by Asset Type
    const freeTypeBreakdown = db.prepare(`
      SELECT asset_type, COUNT(*) as count
      FROM assets
      WHERE assigned_user IS NULL OR TRIM(assigned_user) = '' OR LOWER(TRIM(assigned_user)) IN ('unassigned', 'free', 'none', 'n/a', 'na', 'null', 'nil', '-', '—', 'spare', 'stock', 'available', 'not assigned')
      GROUP BY asset_type
      ORDER BY count DESC
    `).all();

    res.json({
      assets: assetStats,
      unprotectedWorkstations,
      keys: keyStats,
      repairs: repairStats,
      accessories: accStats,
      employees: employeeStats,
      departments: departmentStats,
      deptBreakdown,
      typeBreakdown,
      brandBreakdown,
      freeTypeBreakdown,
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

// Helper to automatically sync Department Master on asset creation / import / assignment
function ensureDepartmentExists(deptName, location = '') {
  if (!deptName) return null;
  const cleanName = String(deptName).trim();
  const ignored = ['unassigned', 'free', 'none', 'n/a', 'na', 'null', 'nil', '', 'all', 'other'];
  if (ignored.includes(cleanName.toLowerCase())) return null;

  try {
    const existing = db.prepare('SELECT id, location FROM departments WHERE name = ? COLLATE NOCASE').get(cleanName);
    if (!existing) {
      const code = cleanName.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 5);
      const res = db.prepare(`
        INSERT INTO departments (name, code, description, location)
        VALUES (?, ?, ?, ?)
      `).run(cleanName, code, `${cleanName} Department`, location ? location.trim() : '');
      return res.lastInsertRowid;
    } else if (!existing.location && location) {
      db.prepare(`UPDATE departments SET location = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(location.trim(), existing.id);
      return existing.id;
    }
    return existing.id;
  } catch (err) {
    console.warn('ensureDepartmentExists warning:', err.message);
    return null;
  }
}

// Helper to automatically sync User Master (employees) on asset creation / import / assignment
function ensureEmployeeExists(userName, department = '', location = '') {
  if (!userName) return null;
  const cleanName = String(userName).trim();
  const lower = cleanName.toLowerCase();
  const ignored = ['unassigned', 'free', 'none', 'n/a', 'na', 'null', 'nil', '', 'available', 'not assigned'];
  if (ignored.includes(lower)) return null;

  try {
    if (department) {
      ensureDepartmentExists(department, location);
    }
    const existing = db.prepare('SELECT id, department, location FROM employees WHERE name = ? COLLATE NOCASE').get(cleanName);
    if (!existing) {
      const res = db.prepare(`
        INSERT INTO employees (name, department, location, status)
        VALUES (?, ?, ?, 'Active')
      `).run(cleanName, department ? department.trim() : '', location ? location.trim() : '');
      return res.lastInsertRowid;
    } else {
      if ((!existing.department && department) || (!existing.location && location)) {
        db.prepare(`
          UPDATE employees 
          SET department = COALESCE(NULLIF(department, ''), ?),
              location = COALESCE(NULLIF(location, ''), ?),
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(department ? department.trim() : '', location ? location.trim() : '', existing.id);
      }
      return existing.id;
    }
  } catch (err) {
    console.warn('ensureEmployeeExists warning:', err.message);
    return null;
  }
}

// GET /api/assets - List all assets with search & filters
router.get('/assets', (req, res) => {
  try {
    const { search, type, department, brand, status, quick_heal, has_printer, occupancy, page = 1, limit = 100 } = req.query;

    let query = `
      SELECT a.*,
             k.product_key as quick_heal_key_str,
             k.validity_date as quick_heal_validity,
             (SELECT COUNT(*) FROM repairs WHERE asset_id = a.id) as repair_count,
             (SELECT COALESCE(SUM(repair_cost), 0) FROM repairs WHERE asset_id = a.id) as total_repair_cost,
             (
               CASE
                 WHEN LOWER(a.asset_type) IN ('desktop', 'laptop')
                   AND a.assigned_user IS NOT NULL
                   AND TRIM(a.assigned_user) != ''
                   AND LOWER(TRIM(a.assigned_user)) NOT IN ('unassigned', 'free', 'none', 'n/a', 'na', 'null', 'nil', '-', '—', 'spare', 'stock')
                 THEN (
                   SELECT COUNT(*)
                   FROM assets p
                   WHERE (p.asset_type IN ('Normal Printer', 'Tag Printer', 'Label Printer', 'Scanner') OR LOWER(p.asset_type) LIKE '%printer%' OR LOWER(p.asset_type) LIKE '%scanner%')
                     AND LOWER(TRIM(p.assigned_user)) = LOWER(TRIM(a.assigned_user))
                     AND p.id != a.id
                     AND p.assigned_user IS NOT NULL
                     AND TRIM(p.assigned_user) != ''
                     AND LOWER(TRIM(p.assigned_user)) NOT IN ('unassigned', 'free', 'none', 'n/a', 'na', 'null', 'nil', '-', '—', 'spare', 'stock')
                 )
                 ELSE 0
               END
             ) as printer_count,
             (
               CASE
                 WHEN LOWER(a.asset_type) IN ('desktop', 'laptop')
                   AND a.assigned_user IS NOT NULL
                   AND TRIM(a.assigned_user) != ''
                   AND LOWER(TRIM(a.assigned_user)) NOT IN ('unassigned', 'free', 'none', 'n/a', 'na', 'null', 'nil', '-', '—', 'spare', 'stock')
                 THEN (
                   SELECT p.asset_type || ' (' || COALESCE(NULLIF(p.brand, ''), 'Printer') || ')'
                   FROM assets p
                   WHERE (p.asset_type IN ('Normal Printer', 'Tag Printer', 'Label Printer', 'Scanner') OR LOWER(p.asset_type) LIKE '%printer%' OR LOWER(p.asset_type) LIKE '%scanner%')
                     AND LOWER(TRIM(p.assigned_user)) = LOWER(TRIM(a.assigned_user))
                     AND p.id != a.id
                     AND p.assigned_user IS NOT NULL
                     AND TRIM(p.assigned_user) != ''
                     AND LOWER(TRIM(p.assigned_user)) NOT IN ('unassigned', 'free', 'none', 'n/a', 'na', 'null', 'nil', '-', '—', 'spare', 'stock')
                   LIMIT 1
                 )
                 ELSE NULL
               END
             ) as primary_printer
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
    if (department && department !== 'all' && department.trim() !== '') {
      query += ` AND LOWER(TRIM(a.department)) = LOWER(TRIM(?))`;
      params.push(department.trim());
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

    if (has_printer === 'yes') {
      query += ` AND LOWER(a.asset_type) IN ('desktop', 'laptop')
        AND a.assigned_user IS NOT NULL
        AND TRIM(a.assigned_user) != ''
        AND LOWER(TRIM(a.assigned_user)) NOT IN ('unassigned', 'free', 'none', 'n/a', 'na', 'null', 'nil', '-', '—', 'spare', 'stock')
        AND (
          SELECT COUNT(*)
          FROM assets p
          WHERE (p.asset_type IN ('Normal Printer', 'Tag Printer', 'Label Printer', 'Scanner') OR LOWER(p.asset_type) LIKE '%printer%' OR LOWER(p.asset_type) LIKE '%scanner%')
            AND LOWER(TRIM(p.assigned_user)) = LOWER(TRIM(a.assigned_user))
            AND p.id != a.id
            AND p.assigned_user IS NOT NULL
            AND TRIM(p.assigned_user) != ''
            AND LOWER(TRIM(p.assigned_user)) NOT IN ('unassigned', 'free', 'none', 'n/a', 'na', 'null', 'nil', '-', '—', 'spare', 'stock')
        ) > 0`;
    } else if (has_printer === 'no') {
      query += ` AND (
        LOWER(a.asset_type) NOT IN ('desktop', 'laptop')
        OR a.assigned_user IS NULL
        OR TRIM(a.assigned_user) = ''
        OR LOWER(TRIM(a.assigned_user)) IN ('unassigned', 'free', 'none', 'n/a', 'na', 'null', 'nil', '-', '—', 'spare', 'stock')
        OR (
          SELECT COUNT(*)
          FROM assets p
          WHERE (p.asset_type IN ('Normal Printer', 'Tag Printer', 'Label Printer', 'Scanner') OR LOWER(p.asset_type) LIKE '%printer%' OR LOWER(p.asset_type) LIKE '%scanner%')
            AND LOWER(TRIM(p.assigned_user)) = LOWER(TRIM(a.assigned_user))
            AND p.id != a.id
            AND p.assigned_user IS NOT NULL
            AND TRIM(p.assigned_user) != ''
            AND LOWER(TRIM(p.assigned_user)) NOT IN ('unassigned', 'free', 'none', 'n/a', 'na', 'null', 'nil', '-', '—', 'spare', 'stock')
        ) = 0
      )`;
    }

    if (occupancy === 'free' || occupancy === 'unoccupied') {
      query += ` AND ${FREE_ASSET_SQL}`;
    } else if (occupancy === 'occupied') {
      query += ` AND ${OCCUPIED_ASSET_SQL}`;
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

    // Enrich with lifecycle info & free/occupancy status
    const enriched = assets.map(asset => {
      const lifecycle = computeAssetLifecycle(asset, asset.repair_count, asset.total_repair_cost);
      const isFree = isFreeAsset(asset.assigned_user);
      return {
        ...asset,
        ...lifecycle,
        is_free: isFree,
        is_occupied: !isFree,
        has_printer: Number(asset.printer_count || 0) > 0,
        primary_printer: asset.primary_printer || null
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

    // Fetch linked printers & workstations for this user
    let linkedPrinters = [];
    let linkedWorkstations = [];
    const cleanUser = (asset.assigned_user || '').trim();
    if (cleanUser && !['unassigned', 'free', 'none', 'n/a', 'na'].includes(cleanUser.toLowerCase())) {
      linkedPrinters = db.prepare(`
        SELECT id, internal_serial_number, asset_type, brand, model_name, serial_number,
               working_status, condition_rating, location, department, remarks
        FROM assets
        WHERE (
          asset_type IN ('Normal Printer', 'Tag Printer', 'Label Printer', 'Scanner')
          OR LOWER(asset_type) LIKE '%printer%'
          OR LOWER(asset_type) LIKE '%scanner%'
        )
        AND LOWER(TRIM(assigned_user)) = LOWER(?)
        AND id != ?
        ORDER BY id ASC
      `).all(cleanUser, asset.id);

      linkedWorkstations = db.prepare(`
        SELECT id, internal_serial_number, asset_type, brand, model_name, serial_number,
               working_status, condition_rating, location, department, remarks
        FROM assets
        WHERE asset_type IN ('Desktop', 'Laptop', 'Server')
        AND LOWER(TRIM(assigned_user)) = LOWER(?)
        AND id != ?
        ORDER BY id ASC
      `).all(cleanUser, asset.id);
    }

    const totalRepairCost = repairs.reduce((sum, r) => sum + (Number(r.repair_cost) || 0), 0);
    const lifecycle = computeAssetLifecycle(asset, repairs.length, totalRepairCost);
    const isFree = isFreeAsset(asset.assigned_user);

    res.json({
      asset: {
        ...asset,
        ...lifecycle,
        is_free: isFree,
        is_occupied: !isFree,
        repair_count: repairs.length,
        total_repair_cost: totalRepairCost,
        repairs,
        accessories,
        linked_printers: linkedPrinters,
        linked_workstations: linkedWorkstations,
        has_printer: linkedPrinters.length > 0
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

    // Quick Heal antivirus protection is strictly for Desktops and Laptops ONLY
    const isWorkstation = ['desktop', 'laptop'].includes(String(asset_type || '').trim().toLowerCase());
    const finalKeyId = isWorkstation && quick_heal_key_id ? Number(quick_heal_key_id) : null;

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
      finalKeyId,
      working_status || 'Working',
      condition_rating || 'Good',
      is_repaired ? 1 : 0,
      parts_added_summary ? parts_added_summary.trim() : '',
      remarks ? remarks.trim() : ''
    );

    const newAssetId = result.lastInsertRowid;

    // If Quick Heal Key was mapped (Desktops/Laptops only), update key status and assigned asset
    if (finalKeyId) {
      db.prepare(`
        UPDATE quick_heal_keys
        SET status = 'Assigned', assigned_asset_id = ?, assigned_user = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(newAssetId, assigned_user || '', finalKeyId);
    }

    // Ensure department exists in Department Master
    if (department) {
      ensureDepartmentExists(department, location);
    }

    // Ensure assigned user exists in User Master (employees table)
    if (assigned_user) {
      ensureEmployeeExists(assigned_user, department, location);
    }

    logAudit(req.user.id, req.user.username, 'CREATE_ASSET', 'asset', newAssetId, `Created asset ${internal_serial_number}`);

    res.status(201).json({ message: 'Asset created successfully', id: newAssetId, assetId: newAssetId });
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

    // Handle Quick Heal key changes (strictly restricted to Desktops & Laptops)
    const effectiveType = asset_type ? asset_type.trim() : existing.asset_type;
    const isWorkstation = ['desktop', 'laptop'].includes(String(effectiveType || '').trim().toLowerCase());
    const oldKeyId = existing.quick_heal_key_id;
    const newKeyId = isWorkstation && quick_heal_key_id ? Number(quick_heal_key_id) : null;

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

    // Ensure assigned user exists in User Master (employees table) and department exists
    const updatedUser = assigned_user !== undefined ? assigned_user.trim() : existing.assigned_user;
    const updatedDept = department !== undefined ? department.trim() : existing.department;
    const updatedLoc = location !== undefined ? location.trim() : existing.location;
    if (updatedDept) {
      ensureDepartmentExists(updatedDept, updatedLoc);
    }
    if (updatedUser) {
      ensureEmployeeExists(updatedUser, updatedDept, updatedLoc);
    }

    logAudit(req.user.id, req.user.username, 'UPDATE_ASSET', 'asset', assetId, `Updated asset ${finalSerial}`);

    res.json({ message: 'Asset updated successfully', asset: { ...existing, internal_serial_number: finalSerial } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/assets/:id/assign - Quick assign / reassign asset to user or mark free
router.post('/assets/:id/assign', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const assetId = req.params.id;
    const existing = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    if (!existing) {
      return res.status(404).json({ error: 'Asset not found.' });
    }

    let { assigned_user, department, location } = req.body;
    assigned_user = (assigned_user || '').trim();
    const finalDept = department !== undefined ? department.trim() : (existing.department || '');
    const finalLoc = location !== undefined ? location.trim() : (existing.location || '');

    const becomesFree = isFreeAsset(assigned_user);
    const finalUser = becomesFree ? '' : assigned_user;

    db.prepare(`
      UPDATE assets SET
        assigned_user = ?,
        department = ?,
        location = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(finalUser, finalDept, finalLoc, assetId);

    // If workstation has a mapped Quick Heal key, keep key user in sync
    if (existing.quick_heal_key_id) {
      db.prepare(`
        UPDATE quick_heal_keys
        SET assigned_user = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(finalUser, existing.quick_heal_key_id);
    }

    if (!becomesFree) {
      if (finalDept) ensureDepartmentExists(finalDept, finalLoc);
      ensureEmployeeExists(finalUser, finalDept, finalLoc);
    }

    logAudit(
      req.user.id,
      req.user.username,
      'ASSIGN_ASSET',
      'asset',
      assetId,
      becomesFree
        ? `Unassigned asset #${existing.internal_serial_number} (marked free/in stock)`
        : `Assigned asset #${existing.internal_serial_number} to ${finalUser}`
    );

    const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    res.json({
      message: becomesFree
        ? `Asset #${existing.internal_serial_number} marked as Free / In Stock`
        : `Asset #${existing.internal_serial_number} successfully assigned to ${finalUser}`,
      asset: {
        ...updated,
        is_free: becomesFree,
        is_occupied: !becomesFree
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/assets/:id/unassign - Unassign asset and release it back to Free stock
router.post('/assets/:id/unassign', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const assetId = req.params.id;
    const existing = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    if (!existing) {
      return res.status(404).json({ error: 'Asset not found.' });
    }

    db.prepare(`
      UPDATE assets SET
        assigned_user = '',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(assetId);

    if (existing.quick_heal_key_id) {
      db.prepare(`
        UPDATE quick_heal_keys
        SET assigned_user = '', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(existing.quick_heal_key_id);
    }

    logAudit(
      req.user.id,
      req.user.username,
      'UNASSIGN_ASSET',
      'asset',
      assetId,
      `Unassigned asset #${existing.internal_serial_number} (marked free/in stock)`
    );

    const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);
    res.json({
      message: `Asset #${existing.internal_serial_number} unassigned and marked Free / In Stock.`,
      asset: {
        ...updated,
        is_free: true,
        is_occupied: false
      }
    });
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

// Helper: Generate Excel Template with interactive Data Validation Dropdowns
async function generateAssetExcelTemplate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VB EXPORTS IT Asset Hub';
  wb.created = new Date();

  // 1. Primary Data Sheet
  const ws = wb.addWorksheet('it_assets_bulk_import_template', {
    views: [{ state: 'frozen', ySplit: 1 }]
  });

  ws.columns = [
    { header: 'Internal Serial Number', key: 'internal_serial_number', width: 24 },
    { header: 'Asset Type', key: 'asset_type', width: 18 },
    { header: 'Brand', key: 'brand', width: 16 },
    { header: 'Model Name', key: 'model_name', width: 22 },
    { header: 'Manufacturer Serial', key: 'serial_number', width: 22 },
    { header: 'Purchase Date', key: 'purchase_date', width: 16 },
    { header: 'Purchase Vendor', key: 'purchase_vendor', width: 22 },
    { header: 'Purchase Cost', key: 'purchase_cost', width: 16 },
    { header: 'Department', key: 'department', width: 20 },
    { header: 'Location', key: 'location', width: 25 },
    { header: 'Assigned User', key: 'assigned_user', width: 20 },
    { header: 'Working Status', key: 'working_status', width: 18 },
    { header: 'Condition Rating', key: 'condition_rating', width: 18 },
    { header: 'Parts Added', key: 'parts_added_summary', width: 25 },
    { header: 'Remarks', key: 'remarks', width: 25 }
  ];

  // Header style
  const headerRow = ws.getRow(1);
  headerRow.height = 28;
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF4F46E5' } // Brand Indigo
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  // Sample data rows
  const sampleRows = [
    ['50060', 'Laptop', 'Lenovo', 'ThinkPad T14', 'PF-99901', '15-01-2026', 'Lenovo Store', 65000, 'Accounts', 'Head Office Floor 2', 'Rohan Gupta', 'Working', 'Good', '', 'Standard office laptop'],
    ['50061', 'Desktop', 'Dell', 'OptiPlex 3080', 'DL-44821', '20-11-2025', 'Dell Direct', 48000, 'Orders', 'Orders Floor Desk 4', 'Priya Patel', 'Working', 'Good', 'Upgraded 16GB RAM', 'For order processing'],
    ['50062', 'Tag Printer', 'TSC', 'TE244', 'TSC-8812', '10-08-2025', 'TSC Vendor', 14500, 'Dispatch', 'Dispatch Bay', 'FREE', 'Working', 'Good', '', 'Picklist label printing']
  ];

  sampleRows.forEach(r => {
    const row = ws.addRow(r);
    row.height = 20;
    row.alignment = { vertical: 'middle' };
  });

  // Allowed list values for dropdowns
  const assetTypes = [
    'Desktop',
    'Laptop',
    'Normal Printer',
    'Tag Printer',
    'Label Printer',
    'Scanner',
    'WebCam',
    'Server',
    'Other'
  ];

  // Pull all distinct departments from Department Master, assets, and employees tables
  const deptRows = db.prepare(`
    SELECT DISTINCT TRIM(name) as name
    FROM departments
    WHERE name IS NOT NULL AND TRIM(name) != ''
    UNION
    SELECT DISTINCT TRIM(department) as name
    FROM assets
    WHERE department IS NOT NULL AND TRIM(department) != ''
    UNION
    SELECT DISTINCT TRIM(department) as name
    FROM employees
    WHERE department IS NOT NULL AND TRIM(department) != ''
    ORDER BY name ASC
  `).all();

  let departments = deptRows.map(d => d.name).filter(Boolean);
  if (departments.length === 0) {
    departments = [
      'Orders',
      'Dispatch',
      'Listings',
      'Company',
      'Accounts',
      'Data Analysis',
      'Return',
      'IT Infrastructure',
      'Warehouse',
      'HR',
      'Sales',
      'Other'
    ];
  }
  if (!departments.some(d => d.toLowerCase() === 'other')) {
    departments.push('Other');
  }

  const statuses = [
    'Working',
    'In Repair',
    'Not Working',
    'Retired'
  ];

  const conditions = [
    'Brand New',
    'Good',
    'Fair',
    'Poor'
  ];

  // 2. Reference sheet for reliable dropdown options in Excel
  const lookupWs = wb.addWorksheet('Lists');
  lookupWs.state = 'hidden';

  assetTypes.forEach((v, i) => { lookupWs.getCell(`A${i + 1}`).value = v; });
  departments.forEach((v, i) => { lookupWs.getCell(`B${i + 1}`).value = v; });
  statuses.forEach((v, i) => { lookupWs.getCell(`C${i + 1}`).value = v; });
  conditions.forEach((v, i) => { lookupWs.getCell(`D${i + 1}`).value = v; });

  // Reference lists for dropdown menus
  const typeFormula = '"Desktop,Laptop,Normal Printer,Tag Printer,Label Printer,Scanner,WebCam,Server,Other"';
  const deptFormula = `"${departments.map(d => d.replace(/"/g, '""')).join(',')}"`;
  const statusFormula = '"Working,In Repair,Not Working,Retired"';
  const conditionFormula = '"Brand New,Good,Fair,Poor"';

  // 3. Apply Data Validation Dropdowns for rows 2 to 1000
  for (let r = 2; r <= 1000; r++) {
    // Column B: Asset Type
    ws.getCell(`B${r}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [typeFormula],
      showErrorMessage: true,
      errorTitle: 'Invalid Asset Type',
      error: 'Please choose an Asset Type from the dropdown menu.'
    };

    // Column I: Department
    ws.getCell(`I${r}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [deptFormula],
      showErrorMessage: true,
      errorTitle: 'Invalid Department',
      error: 'Please choose a Department from the dropdown menu.'
    };

    // Column L: Working Status
    ws.getCell(`L${r}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [statusFormula],
      showErrorMessage: true,
      errorTitle: 'Invalid Working Status',
      error: 'Please choose a Working Status from the dropdown menu.'
    };

    // Column M: Condition Rating
    ws.getCell(`M${r}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [conditionFormula],
      showErrorMessage: true,
      errorTitle: 'Invalid Condition Rating',
      error: 'Please choose Brand New, Good, Fair, or Poor from the dropdown menu.'
    };
  }

  return await wb.xlsx.writeBuffer();
}

// GET /api/assets/template/excel - Download Excel Template with Data Validation Dropdowns
router.get(['/assets/template/excel', '/assets/template'], async (req, res) => {
  try {
    const buffer = await generateAssetExcelTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="it_assets_bulk_import_template.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('Error generating Excel template:', err);
    res.status(500).json({ error: 'Failed to generate Excel template' });
  }
});

// GET /api/assets/template/csv - Deprecated, redirect to standardized Excel template
router.get('/assets/template/csv', (req, res) => {
  res.redirect(302, '/api/assets/template/excel');
});

// POST /api/assets/bulk-import - Bulk import assets via Excel (.xlsx) or JSON
router.post('/assets/bulk-import', requireRoles('admin', 'technician'), upload.single('file'), (req, res) => {
  try {
    let rows = [];

    if (req.file) {
      if (req.file.originalname && req.file.originalname.toLowerCase().endsWith('.csv')) {
        return res.status(400).json({
          error: 'CSV format is disabled. Please download and upload using the standardized Excel (.xlsx) template with dropdown data validation.'
        });
      }
      // Parse Excel from uploaded buffer
      const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
      const sheetName = wb.SheetNames[0];
      rows = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
    } else if (req.body.assets && Array.isArray(req.body.assets)) {
      rows = req.body.assets;
    } else {
      return res.status(400).json({ error: 'Please upload an Excel (.xlsx) file, or provide asset rows in the request.' });
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
        let rawDate = row['Purchase Date'] || row['purchase_date'] || '';
        let purchaseDate = null;
        if (rawDate && rawDate !== 'None') {
          if (typeof rawDate === 'number') {
            const d = new Date((rawDate - (25567 + 2)) * 86400 * 1000);
            if (!isNaN(d.getTime())) purchaseDate = d.toISOString().split('T')[0];
          } else {
            const str = String(rawDate).trim();
            const dmy = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
            if (dmy) {
              purchaseDate = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
            } else {
              const ymd = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
              if (ymd) {
                purchaseDate = `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
              } else {
                purchaseDate = str;
              }
            }
          }
        }
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

        // Auto-add or update user in User Master (employees)
        if (user) {
          ensureEmployeeExists(user, dept, location);
        }

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

// GET /api/export/excel or /api/assets/export/excel - Export All Assets to formatted Excel (.xlsx)
router.get(['/export/excel', '/assets/export/excel'], async (req, res) => {
  try {
    const assets = db.prepare(`
      SELECT a.internal_serial_number, a.asset_type, a.brand, a.model_name, a.serial_number,
             a.purchase_date, a.purchase_vendor, a.purchase_cost, a.department, a.location,
             a.assigned_user, k.product_key as quick_heal_key, a.working_status, a.is_repaired,
             a.parts_added_summary, a.remarks
      FROM assets a
      LEFT JOIN quick_heal_keys k ON a.quick_heal_key_id = k.id
      ORDER BY CAST(a.internal_serial_number AS INTEGER) ASC, a.id ASC
    `).all();

    const wb = new ExcelJS.Workbook();
    wb.creator = 'VB EXPORTS IT Asset Hub';
    wb.created = new Date();
    const ws = wb.addWorksheet('IT_Assets_Inventory', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });

    ws.columns = [
      { header: 'Serial #', key: 'internal_serial_number', width: 14 },
      { header: 'Asset Type', key: 'asset_type', width: 18 },
      { header: 'Brand', key: 'brand', width: 16 },
      { header: 'Model Name', key: 'model_name', width: 22 },
      { header: 'Hardware Serial', key: 'serial_number', width: 20 },
      { header: 'Purchase Date', key: 'purchase_date', width: 15 },
      { header: 'Vendor', key: 'purchase_vendor', width: 20 },
      { header: 'Cost (₹)', key: 'purchase_cost', width: 15 },
      { header: 'Department', key: 'department', width: 18 },
      { header: 'Location', key: 'location', width: 22 },
      { header: 'Assigned Custodian', key: 'assigned_user', width: 22 },
      { header: 'Antivirus Key', key: 'quick_heal_key', width: 24 },
      { header: 'Working Status', key: 'working_status', width: 16 },
      { header: 'Repaired?', key: 'is_repaired', width: 14 },
      { header: 'Upgrades / Parts Added', key: 'parts_added_summary', width: 25 },
      { header: 'Remarks / Notes', key: 'remarks', width: 30 }
    ];

    const headerRow = ws.getRow(1);
    headerRow.height = 26;
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11, name: 'Calibri' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4F46E5' }
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    assets.forEach(row => {
      const addedRow = ws.addRow({
        ...row,
        is_repaired: row.is_repaired ? 'Yes' : 'No'
      });
      addedRow.height = 20;
      addedRow.alignment = { vertical: 'middle' };
    });

    const buffer = await wb.xlsx.writeBuffer();
    const filename = `IT_Assets_Inventory_${new Date().toISOString().split('T')[0]}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
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
      LEFT JOIN assets a ON r.asset_id = a.id
      WHERE 1=1
    `;
    const params = [];

    if (ticket_status === 'open') {
      query += ` AND r.status IN ('In Progress', 'Awaiting Parts', 'Diagnosing')`;
    } else if (ticket_status === 'pending') {
      query += ` AND r.status = 'Pending Approval'`;
    } else if (ticket_status === 'closed') {
      query += ` AND r.status IN ('Completed', 'Beyond Repair', 'Closed', 'Rejected')`;
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
        LOWER(COALESCE(r.requester_name, '')) LIKE ? OR
        LOWER(COALESCE(r.requester_phone, '')) LIKE ? OR
        LOWER(COALESCE(r.requester_department, '')) LIKE ? OR
        LOWER(COALESCE(r.repair_vendor, '')) LIKE ? OR
        LOWER(COALESCE(r.technician_name, '')) LIKE ? OR
        LOWER(COALESCE(r.parts_added, '')) LIKE ? OR
        LOWER(COALESCE(a.internal_serial_number, '')) LIKE ? OR
        LOWER(COALESCE(a.assigned_user, '')) LIKE ?
      )`;
      params.push(term, term, term, term, term, term, term, term, term, term);
    }

    query += ` ORDER BY r.created_at DESC`;
    const repairs = db.prepare(query).all(...params);

    const counts = db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'Pending Approval' THEN 1 ELSE 0 END), 0) as pending_count,
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

// POST /api/repairs/:id/approve - Approve a pending public/internal request
router.post('/repairs/:id/approve', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const repairId = req.params.id;
    const existing = db.prepare('SELECT * FROM repairs WHERE id = ?').get(repairId);
    if (!existing) {
      return res.status(404).json({ error: 'Repair ticket not found.' });
    }

    const {
      technician_name,
      technician_contact,
      repair_vendor,
      due_date,
      repair_type,
      remarks
    } = req.body;

    const finalTech = (technician_name !== undefined && technician_name.trim()) ? technician_name.trim() : (existing.technician_name || req.user.full_name || req.user.username);
    const finalDueDate = due_date || existing.due_date;
    const finalType = repair_type || existing.repair_type || 'Software Installation / Service';
    const finalRemarks = (remarks !== undefined && remarks.trim()) ? remarks.trim() : (existing.remarks || '');

    const transaction = db.transaction(() => {
      db.prepare(`
        UPDATE repairs SET
          status = 'In Progress',
          technician_name = ?,
          technician_contact = COALESCE(?, technician_contact),
          repair_vendor = COALESCE(?, repair_vendor),
          due_date = ?,
          repair_type = ?,
          approved_by = ?,
          approved_at = CURRENT_TIMESTAMP,
          remarks = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        finalTech,
        technician_contact ? technician_contact.trim() : null,
        repair_vendor ? repair_vendor.trim() : null,
        finalDueDate,
        finalType,
        req.user.username,
        finalRemarks,
        repairId
      );

      // If linked asset is active and this is hardware repair, update asset status to In Repair
      if (existing.asset_id && !['Software Installation / Service', 'General IT Support'].includes(finalType)) {
        db.prepare(`UPDATE assets SET working_status = 'In Repair', is_repaired = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND working_status = 'Working'`).run(existing.asset_id);
      }
    });

    transaction();

    logAudit(req.user.id, req.user.username, 'APPROVE_REPAIR', 'repair', repairId, `Approved ticket ${existing.ticket_number} (Assigned to: ${finalTech})`);

    const updated = db.prepare(`
      SELECT r.*, a.internal_serial_number, a.brand, a.asset_type, a.assigned_user, a.department
      FROM repairs r
      LEFT JOIN assets a ON r.asset_id = a.id
      WHERE r.id = ?
    `).get(repairId);

    res.json({ message: `Ticket ${existing.ticket_number} approved and moved to In Progress.`, ticket: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/repairs/:id/reject - Reject a ticket with reason
router.post('/repairs/:id/reject', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const repairId = req.params.id;
    const existing = db.prepare('SELECT * FROM repairs WHERE id = ?').get(repairId);
    if (!existing) {
      return res.status(404).json({ error: 'Repair ticket not found.' });
    }

    const { rejection_reason, remarks } = req.body;
    const reason = (rejection_reason && rejection_reason.trim()) ? rejection_reason.trim() : (remarks ? remarks.trim() : 'Declined by IT Administrator');

    db.prepare(`
      UPDATE repairs SET
        status = 'Rejected',
        rejection_reason = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(reason, repairId);

    logAudit(req.user.id, req.user.username, 'REJECT_REPAIR', 'repair', repairId, `Rejected ticket ${existing.ticket_number}: ${reason}`);

    res.json({ message: `Ticket ${existing.ticket_number} marked as Rejected.`, reason });
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

    if (department && department.trim() && department !== 'all') {
      whereClause += ' AND LOWER(TRIM(a.department)) = LOWER(TRIM(?))';
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

    if (department && department.trim() && department !== 'all') {
      whereClause += ' AND LOWER(TRIM(a.department)) = LOWER(TRIM(?))';
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
          } else if (diffDays <= 30) {
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

    const isWorkstation = ['desktop', 'laptop'].includes((asset.asset_type || '').trim().toLowerCase());
    if (!isWorkstation) {
      return res.status(400).json({ error: `Quick Heal antivirus keys can only be assigned to Desktops and Laptops (this device is a '${asset.asset_type}').` });
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
      SELECT acc.*,
             COALESCE(acc.internal_serial_number, acc.accessory_code) as internal_serial_number,
             COALESCE(acc.accessory_code, acc.internal_serial_number) as accessory_code,
             a.internal_serial_number as asset_serial,
             a.assigned_user as asset_user
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
        LOWER(COALESCE(acc.internal_serial_number, acc.accessory_code)) LIKE ? OR
        LOWER(acc.accessory_code) LIKE ? OR
        LOWER(acc.name) LIKE ? OR
        LOWER(acc.brand) LIKE ? OR
        LOWER(acc.model) LIKE ? OR
        LOWER(COALESCE(acc.assigned_user, '')) LIKE ? OR
        LOWER(COALESCE(acc.location, '')) LIKE ?
      )`;
      params.push(term, term, term, term, term, term, term);
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
    const {
      accessory_code, internal_serial_number, name, category, brand, model,
      serial_number, quantity, assigned_user, assigned_asset_id, location,
      status, purchase_date, cost, remarks
    } = req.body;

    if (!name || !category) {
      return res.status(400).json({ error: 'Accessory name and category are required.' });
    }

    // Auto-generate internal serial number if missing
    let code = (internal_serial_number || accessory_code || '').trim().replace(/^#/, '');
    if (!code) {
      let maxId = db.prepare('SELECT MAX(id) as m FROM accessories').get().m || 0;
      let nextNum = maxId + 1;
      code = `ACC-${String(nextNum).padStart(3, '0')}`;
      while (db.prepare('SELECT id FROM accessories WHERE accessory_code = ? OR internal_serial_number = ?').get(code, code)) {
        nextNum++;
        code = `ACC-${String(nextNum).padStart(3, '0')}`;
      }
    }

    const insert = db.prepare(`
      INSERT INTO accessories (
        accessory_code, internal_serial_number, name, category, brand, model, serial_number,
        quantity, assigned_user, assigned_asset_id, location, status,
        purchase_date, cost, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      code,
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

    if (assigned_user) {
      ensureEmployeeExists(assigned_user, '', location);
    }

    logAudit(req.user.id, req.user.username, 'CREATE_ACCESSORY', 'accessory', result.lastInsertRowid, `Created accessory #${code} - ${name}`);

    res.status(201).json({ message: 'Accessory added successfully', id: result.lastInsertRowid, internal_serial_number: code, accessory_code: code });
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

    const {
      accessory_code, internal_serial_number, name, category, brand, model,
      serial_number, quantity, assigned_user, assigned_asset_id, location,
      status, purchase_date, cost, remarks
    } = req.body;

    const serialIn = (internal_serial_number !== undefined ? internal_serial_number : accessory_code);
    const serialToSave = (serialIn !== undefined && serialIn.trim()) ? serialIn.trim().replace(/^#/, '') : (existing.internal_serial_number || existing.accessory_code);

    db.prepare(`
      UPDATE accessories SET
        accessory_code = ?,
        internal_serial_number = ?,
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
      serialToSave,
      serialToSave,
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

    const finalUser = assigned_user !== undefined ? assigned_user : existing.assigned_user;
    if (finalUser) {
      ensureEmployeeExists(finalUser, '', location || existing.location);
    }

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

    if (assigned_user) {
      ensureEmployeeExists(assigned_user, '', location);
    }

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
    'Internal Serial Number',
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

// GET /api/accessories/template/excel - Download Accessories Excel (.xlsx) Template
router.get('/accessories/template/excel', (req, res) => {
  const headers = [
    'Internal Serial Number',
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

  const sampleData = [
    { 'Internal Serial Number': 'ACC-010', 'Category': 'Mouse', 'Item Name': 'Logitech B100 USB Optical Mouse', 'Brand': 'Logitech', 'Model': 'B100', 'Serial Number': '', 'Quantity': 10, 'Location': 'IT Store Room', 'Status': 'In Stock', 'Remarks': 'Spare optical mice' },
    { 'Internal Serial Number': 'ACC-011', 'Category': 'Keyboard', 'Item Name': 'Dell KB216 Wired Standard Keyboard', 'Brand': 'Dell', 'Model': 'KB216', 'Serial Number': '', 'Quantity': 5, 'Location': 'IT Store Room', 'Status': 'In Stock', 'Remarks': 'Standard desktop keyboards' },
    { 'Internal Serial Number': 'ACC-012', 'Category': 'Scanner', 'Item Name': 'Zebra DS2208 Barcode Scanner', 'Brand': 'Zebra', 'Model': 'DS2208', 'Serial Number': '', 'Quantity': 2, 'Location': 'Dispatch Bay', 'Status': 'In Stock', 'Remarks': '2D Barcode scanner' }
  ];

  const ws = xlsx.utils.json_to_sheet(sampleData, { header: headers });
  ws['!cols'] = [
    { wch: 22 }, // Internal Serial Number
    { wch: 15 }, // Category
    { wch: 35 }, // Item Name
    { wch: 15 }, // Brand
    { wch: 15 }, // Model
    { wch: 20 }, // Serial Number
    { wch: 10 }, // Quantity
    { wch: 18 }, // Location
    { wch: 12 }, // Status
    { wch: 30 }  // Remarks
  ];

  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Accessories');
  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="accessories_import_template.xlsx"');
  res.status(200).send(buffer);
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

    const validCategories = ['Mouse', 'Keyboard', 'Scanner', 'Print Head', 'Cable/Adapter', 'UPS', 'Monitor', 'Other'];
    let importedCount = 0;
    let skippedCount = 0;
    const errors = [];

    // Get initial max code counter
    const existingCodes = db.prepare('SELECT accessory_code, internal_serial_number FROM accessories').all().map(r => r.internal_serial_number || r.accessory_code);
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
        accessory_code, internal_serial_number, name, category, brand, model, serial_number,
        quantity, assigned_user, location, status, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

        let code = cleanRow['internal serial number'] || cleanRow['internal_serial_number'] || cleanRow['internal serial'] || cleanRow['internal serial #'] || cleanRow['accessory code'] || cleanRow['accessory_code'] || cleanRow['code'] || '';
        code = code.replace(/^#/, '').trim();
        if (!code) {
          code = `ACC-${String(nextNum).padStart(3, '0')}`;
          nextNum++;
        }

        // Check if code already exists
        const existing = db.prepare('SELECT id, status FROM accessories WHERE accessory_code = ? OR internal_serial_number = ?').get(code, code);
        if (existing) {
          if (existing.status === 'In Stock' && status === 'In Stock') {
            // Merge quantity into existing in-stock batch
            updateStockStmt.run(qty, existing.id);
            importedCount++;
          } else {
            skippedCount++;
            errors.push(`Row ${rowNum}: Accessory with Serial #${code} already exists and is not in stock.`);
          }
          return;
        }

        insertStmt.run(
          code,
          code,
          name,
          category,
          brand,
          model,
          serial,
          qty,
          user,
          location,
          status,
          remarks
        );
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
// 5.5 USER MASTER (EMPLOYEES / CUSTODIANS)
// ==========================================

// GET /api/employees - List all employees with comprehensive hardware & printer breakdown
router.get('/employees', (req, res) => {
  try {
    const { search, department, has_printer, status = 'Active' } = req.query;

    let query = `SELECT * FROM employees WHERE 1=1`;
    const params = [];

    if (status && status !== 'all') {
      query += ` AND status = ?`;
      params.push(status);
    }

    if (department && department.trim() && department !== 'all') {
      query += ` AND LOWER(department) = LOWER(?)`;
      params.push(department.trim());
    }

    if (search && search.trim()) {
      const term = `%${search.trim().toLowerCase()}%`;
      query += ` AND (
        LOWER(name) LIKE ? OR
        LOWER(COALESCE(department, '')) LIKE ? OR
        LOWER(COALESCE(designation, '')) LIKE ? OR
        LOWER(COALESCE(location, '')) LIKE ? OR
        LOWER(COALESCE(email, '')) LIKE ? OR
        LOWER(COALESCE(phone, '')) LIKE ?
      )`;
      params.push(term, term, term, term, term, term);
    }

    query += ` ORDER BY name ASC`;

    const employees = db.prepare(query).all(...params);

    // Fetch all assigned assets and accessories to map to employees
    const allAssets = db.prepare(`
      SELECT a.*, k.product_key as quick_heal_key_str
      FROM assets a
      LEFT JOIN quick_heal_keys k ON a.quick_heal_key_id = k.id
      WHERE a.assigned_user IS NOT NULL AND TRIM(a.assigned_user) != ''
    `).all();

    const allAccs = db.prepare(`
      SELECT * FROM accessories
      WHERE assigned_user IS NOT NULL AND TRIM(assigned_user) != ''
    `).all();

    const assetsByUser = {};
    for (const a of allAssets) {
      const u = a.assigned_user.trim().toLowerCase();
      if (!assetsByUser[u]) assetsByUser[u] = [];
      assetsByUser[u].push(a);
    }

    const accsByUser = {};
    for (const acc of allAccs) {
      const u = acc.assigned_user.trim().toLowerCase();
      if (!accsByUser[u]) accsByUser[u] = [];
      accsByUser[u].push(acc);
    }

    let totalWithPrinters = 0;
    let totalWorkstations = 0;

    const enriched = employees.map(emp => {
      const uKey = emp.name.trim().toLowerCase();
      const userAssets = assetsByUser[uKey] || [];
      const userAccs = accsByUser[uKey] || [];

      const workstations = userAssets.filter(a => {
        const t = (a.asset_type || '').toLowerCase();
        return t === 'desktop' || t === 'laptop' || t === 'server';
      });

      const printers = userAssets.filter(a => {
        const t = (a.asset_type || '').toLowerCase();
        return t.includes('printer') || t.includes('scanner') || ['normal printer', 'tag printer', 'label printer', 'scanner'].includes(t);
      });

      const otherAssets = userAssets.filter(a => !workstations.includes(a) && !printers.includes(a));

      const hasPrinter = printers.length > 0;
      if (hasPrinter) totalWithPrinters++;
      totalWorkstations += workstations.length;

      return {
        ...emp,
        workstations,
        printers,
        other_assets: otherAssets,
        accessories: userAccs,
        workstation_count: workstations.length,
        printer_count: printers.length,
        accessory_count: userAccs.length,
        has_printer: hasPrinter
      };
    });

    let filtered = enriched;
    if (has_printer === 'yes') {
      filtered = filtered.filter(e => e.has_printer);
    } else if (has_printer === 'no') {
      filtered = filtered.filter(e => !e.has_printer);
    }

    res.json({
      employees: filtered,
      stats: {
        total: employees.length,
        with_printers: totalWithPrinters,
        without_printers: employees.length - totalWithPrinters,
        total_workstations: totalWorkstations
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/employees/:id - Single employee profile with asset history
router.get('/employees/:id', (req, res) => {
  try {
    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const uKey = employee.name.trim().toLowerCase();
    const assets = db.prepare(`
      SELECT a.*, k.product_key as quick_heal_key_str, k.validity_date as quick_heal_validity
      FROM assets a
      LEFT JOIN quick_heal_keys k ON a.quick_heal_key_id = k.id
      WHERE LOWER(TRIM(a.assigned_user)) = ?
      ORDER BY a.asset_type ASC, a.id ASC
    `).all(uKey);

    const accessories = db.prepare(`
      SELECT * FROM accessories WHERE LOWER(TRIM(assigned_user)) = ? ORDER BY id ASC
    `).all(uKey);

    const workstations = assets.filter(a => ['desktop', 'laptop', 'server'].includes((a.asset_type || '').toLowerCase()));
    const printers = assets.filter(a => {
      const t = (a.asset_type || '').toLowerCase();
      return t.includes('printer') || t.includes('scanner') || ['normal printer', 'tag printer', 'label printer', 'scanner'].includes(t);
    });

    res.json({
      employee: {
        ...employee,
        workstations,
        printers,
        accessories,
        workstation_count: workstations.length,
        printer_count: printers.length,
        accessory_count: accessories.length,
        has_printer: printers.length > 0
      },
      assigned_workstations: workstations,
      assigned_printers: printers,
      assigned_accessories: accessories,
      workstations,
      printers,
      accessories
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/employees - Create new employee in User Master
router.post('/employees', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const { name, department, designation, email, phone, location, status, notes } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Employee name is required.' });
    }

    const cleanName = name.trim();
    const existing = db.prepare('SELECT id FROM employees WHERE name = ? COLLATE NOCASE').get(cleanName);
    if (existing) {
      return res.status(400).json({ error: `User '${cleanName}' already exists in User Master.` });
    }

    const result = db.prepare(`
      INSERT INTO employees (name, department, designation, email, phone, location, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cleanName,
      department ? department.trim() : '',
      designation ? designation.trim() : '',
      email ? email.trim() : '',
      phone ? phone.trim() : '',
      location ? location.trim() : '',
      status || 'Active',
      notes ? notes.trim() : ''
    );

    logAudit(req.user.id, req.user.username, 'CREATE_EMPLOYEE', 'employee', result.lastInsertRowid, `Created User Master entry for ${cleanName}`);

    res.status(201).json({
      message: `User '${cleanName}' successfully added to User Master.`,
      id: result.lastInsertRowid,
      employee: {
        id: result.lastInsertRowid,
        name: cleanName,
        department: department || '',
        location: location || ''
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/employees/:id - Update employee in User Master
router.put('/employees/:id', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const empId = req.params.id;
    const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
    if (!existing) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    const { name, department, designation, email, phone, location, status, notes } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Employee name is required.' });
    }

    const cleanName = name.trim();
    const dup = db.prepare('SELECT id FROM employees WHERE name = ? COLLATE NOCASE AND id != ?').get(cleanName, empId);
    if (dup) {
      return res.status(400).json({ error: `Another user with name '${cleanName}' already exists.` });
    }

    db.prepare(`
      UPDATE employees
      SET name = ?,
          department = ?,
          designation = ?,
          email = ?,
          phone = ?,
          location = ?,
          status = ?,
          notes = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      cleanName,
      department ? department.trim() : '',
      designation ? designation.trim() : '',
      email ? email.trim() : '',
      phone ? phone.trim() : '',
      location ? location.trim() : '',
      status || existing.status || 'Active',
      notes ? notes.trim() : '',
      empId
    );

    // If name changed, cascade update to assigned_user across assets, keys, and accessories!
    if (existing.name.toLowerCase() !== cleanName.toLowerCase()) {
      db.prepare(`
        UPDATE assets SET assigned_user = ?, updated_at = CURRENT_TIMESTAMP
        WHERE LOWER(TRIM(assigned_user)) = ?
      `).run(cleanName, existing.name.trim().toLowerCase());

      db.prepare(`
        UPDATE quick_heal_keys SET assigned_user = ?, updated_at = CURRENT_TIMESTAMP
        WHERE LOWER(TRIM(assigned_user)) = ?
      `).run(cleanName, existing.name.trim().toLowerCase());

      db.prepare(`
        UPDATE accessories SET assigned_user = ?, updated_at = CURRENT_TIMESTAMP
        WHERE LOWER(TRIM(assigned_user)) = ?
      `).run(cleanName, existing.name.trim().toLowerCase());
    }

    logAudit(req.user.id, req.user.username, 'UPDATE_EMPLOYEE', 'employee', empId, `Updated User Master entry for ${cleanName}`);

    res.json({ message: 'User updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/employees/:id - Delete employee
router.delete('/employees/:id', requireRoles('admin'), (req, res) => {
  try {
    const empId = req.params.id;
    const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
    if (!existing) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    // Check if employee has assigned assets
    const assignedAssets = db.prepare('SELECT COUNT(*) as count FROM assets WHERE LOWER(TRIM(assigned_user)) = ?').get(existing.name.trim().toLowerCase()).count;
    if (assignedAssets > 0) {
      return res.status(400).json({
        error: `Cannot delete '${existing.name}' because ${assignedAssets} asset(s) are currently assigned to this user. Please reassign the assets first, or set status to Inactive.`
      });
    }

    db.prepare('DELETE FROM employees WHERE id = ?').run(empId);
    logAudit(req.user.id, req.user.username, 'DELETE_EMPLOYEE', 'employee', empId, `Deleted user ${existing.name}`);

    res.json({ message: `User '${existing.name}' removed from User Master.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 5.6 DEPARTMENT MASTER & BREAKDOWN
// ==========================================

// GET /api/departments - List all departments with comprehensive breakdown statistics
router.get('/departments', (req, res) => {
  try {
    const { search } = req.query;
    let query = 'SELECT * FROM departments WHERE 1=1';
    const params = [];
    if (search && search.trim()) {
      query += ' AND (name LIKE ? OR code LIKE ? OR head_of_department LIKE ? OR location LIKE ?)';
      const s = `%${search.trim()}%`;
      params.push(s, s, s, s);
    }
    query += ' ORDER BY name ASC';
    const departments = db.prepare(query).all(...params);

    // Fetch all assets & employees to compute rich breakdown stats for each department
    const allAssets = db.prepare(`
      SELECT id, internal_serial_number, asset_type, brand, model_name, department, location, assigned_user, working_status, condition_rating, purchase_cost
      FROM assets
    `).all();

    const allEmployees = db.prepare(`
      SELECT id, name, department, designation, location, phone, email, status
      FROM employees
    `).all();

    const enriched = departments.map(d => {
      const dNameNorm = (d.name || '').trim().toLowerCase();
      const deptAssets = allAssets.filter(a => (a.department || '').trim().toLowerCase() === dNameNorm);
      const deptEmployees = allEmployees.filter(e => (e.department || '').trim().toLowerCase() === dNameNorm);

      // Asset working status counts
      const working = deptAssets.filter(a => a.working_status === 'Working').length;
      const in_repair = deptAssets.filter(a => a.working_status === 'In Repair').length;
      const not_working = deptAssets.filter(a => a.working_status === 'Not Working').length;
      const retired = deptAssets.filter(a => a.working_status === 'Retired').length;

      // Asset types breakdown
      const assetTypesMap = {};
      deptAssets.forEach(a => {
        const type = a.asset_type || 'Unknown';
        assetTypesMap[type] = (assetTypesMap[type] || 0) + 1;
      });

      // Total asset inventory purchase value
      const totalValue = deptAssets.reduce((sum, a) => sum + (Number(a.purchase_cost) || 0), 0);

      // Unique active custodians in this department
      const activeCustodians = [...new Set(deptAssets.map(a => a.assigned_user).filter(u => u && !['unassigned', 'free', 'none', 'n/a'].includes(u.toLowerCase())))];

      return {
        ...d,
        stats: {
          total_assets: deptAssets.length,
          working,
          in_repair,
          not_working,
          retired,
          total_personnel: deptEmployees.length,
          active_custodians_count: activeCustodians.length,
          total_value: totalValue,
          asset_types: assetTypesMap
        }
      };
    });

    res.json({
      departments: enriched,
      stats: {
        total_departments: departments.length,
        total_department_assets: allAssets.filter(a => a.department && a.department.trim()).length,
        total_department_personnel: allEmployees.filter(e => e.department && e.department.trim()).length,
        total_department_value: allAssets.filter(a => a.department && a.department.trim()).reduce((s, a) => s + (Number(a.purchase_cost) || 0), 0)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/departments/:id - Single department profile with full asset & personnel breakdown
router.get('/departments/:id', (req, res) => {
  try {
    const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(req.params.id);
    if (!dept) {
      return res.status(404).json({ error: 'Department not found' });
    }

    const dNameNorm = dept.name.trim().toLowerCase();

    // Assets in this department
    const assets = db.prepare(`
      SELECT a.*, k.product_key as quick_heal_key_str
      FROM assets a
      LEFT JOIN quick_heal_keys k ON a.quick_heal_key_id = k.id
      WHERE LOWER(TRIM(a.department)) = ?
      ORDER BY a.internal_serial_number ASC
    `).all(dNameNorm);

    // Employees in this department
    const employees = db.prepare(`
      SELECT *
      FROM employees
      WHERE LOWER(TRIM(department)) = ?
      ORDER BY name ASC
    `).all(dNameNorm);

    // Compute breakdown summaries
    const assetTypes = {};
    let totalValue = 0;
    let working = 0, inRepair = 0, notWorking = 0, retired = 0;

    assets.forEach(a => {
      assetTypes[a.asset_type] = (assetTypes[a.asset_type] || 0) + 1;
      totalValue += Number(a.purchase_cost) || 0;
      if (a.working_status === 'Working') working++;
      else if (a.working_status === 'In Repair') inRepair++;
      else if (a.working_status === 'Not Working') notWorking++;
      else if (a.working_status === 'Retired') retired++;
    });

    res.json({
      department: dept,
      stats: {
        total_assets: assets.length,
        total_personnel: employees.length,
        total_value: totalValue,
        working,
        in_repair: inRepair,
        not_working: notWorking,
        retired,
        asset_types: assetTypes
      },
      assets,
      employees
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/departments - Create new department in Department Master
router.post('/departments', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const { name, code, description, head_of_department, location } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Department name is required.' });
    }

    const cleanName = name.trim();
    const existing = db.prepare('SELECT id FROM departments WHERE name = ? COLLATE NOCASE').get(cleanName);
    if (existing) {
      return res.status(400).json({ error: `Department '${cleanName}' already exists in Department Master.` });
    }

    const stmt = db.prepare(`
      INSERT INTO departments (name, code, description, head_of_department, location)
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      cleanName,
      code ? code.trim().toUpperCase() : '',
      description ? description.trim() : '',
      head_of_department ? head_of_department.trim() : '',
      location ? location.trim() : ''
    );

    logAudit(req.user.id, req.user.username, 'CREATE_DEPARTMENT', 'department', String(result.lastInsertRowid), `Created department ${cleanName}`);

    res.status(201).json({
      message: `Department '${cleanName}' created successfully`,
      id: Number(result.lastInsertRowid)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/departments/:id - Update department
router.put('/departments/:id', requireRoles('admin', 'technician'), (req, res) => {
  try {
    const deptId = req.params.id;
    const existing = db.prepare('SELECT * FROM departments WHERE id = ?').get(deptId);
    if (!existing) {
      return res.status(404).json({ error: 'Department not found.' });
    }

    const { name, code, description, head_of_department, location } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Department name is required.' });
    }

    const cleanName = name.trim();
    const duplicate = db.prepare('SELECT id FROM departments WHERE name = ? COLLATE NOCASE AND id != ?').get(cleanName, deptId);
    if (duplicate) {
      return res.status(400).json({ error: `Another department with name '${cleanName}' already exists.` });
    }

    const oldName = existing.name;

    const stmt = db.prepare(`
      UPDATE departments
      SET name = ?, code = ?, description = ?, head_of_department = ?, location = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    stmt.run(
      cleanName,
      code ? code.trim().toUpperCase() : '',
      description ? description.trim() : '',
      head_of_department ? head_of_department.trim() : '',
      location ? location.trim() : '',
      deptId
    );

    // If department name was changed, sync assets & employees assigned to the old name
    if (oldName.toLowerCase() !== cleanName.toLowerCase()) {
      db.prepare(`
        UPDATE assets SET department = ?, updated_at = CURRENT_TIMESTAMP
        WHERE LOWER(TRIM(department)) = ?
      `).run(cleanName, oldName.toLowerCase());

      db.prepare(`
        UPDATE employees SET department = ?, updated_at = CURRENT_TIMESTAMP
        WHERE LOWER(TRIM(department)) = ?
      `).run(cleanName, oldName.toLowerCase());
    }

    logAudit(req.user.id, req.user.username, 'UPDATE_DEPARTMENT', 'department', String(deptId), `Updated department ${cleanName}`);

    res.json({ message: `Department '${cleanName}' updated successfully.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/departments/:id - Delete department
router.delete('/departments/:id', requireRoles('admin'), (req, res) => {
  try {
    const deptId = req.params.id;
    const existing = db.prepare('SELECT * FROM departments WHERE id = ?').get(deptId);
    if (!existing) {
      return res.status(404).json({ error: 'Department not found.' });
    }

    const dNameNorm = existing.name.trim().toLowerCase();

    // Check if department has assigned assets or personnel
    const assetCount = db.prepare('SELECT COUNT(*) as count FROM assets WHERE LOWER(TRIM(department)) = ?').get(dNameNorm).count;
    const empCount = db.prepare('SELECT COUNT(*) as count FROM employees WHERE LOWER(TRIM(department)) = ?').get(dNameNorm).count;

    if (assetCount > 0 || empCount > 0) {
      return res.status(400).json({
        error: `Cannot delete department '${existing.name}' because it currently has ${assetCount} asset(s) and ${empCount} user(s) assigned. Please reassign them first.`
      });
    }

    db.prepare('DELETE FROM departments WHERE id = ?').run(deptId);

    logAudit(req.user.id, req.user.username, 'DELETE_DEPARTMENT', 'department', String(deptId), `Deleted department ${existing.name}`);

    res.json({ message: `Department '${existing.name}' deleted successfully.` });
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
        employees: [],
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
      LEFT JOIN assets a ON r.asset_id = a.id
      WHERE 1=1
    `;
    const repairParams = [];
    tokens.forEach(tok => {
      const term = `%${tok}%`;
      repairQuery += ` AND (
        LOWER(r.ticket_number) LIKE ? OR
        LOWER(r.issue_description) LIKE ? OR
        LOWER(COALESCE(r.requester_name, '')) LIKE ? OR
        LOWER(COALESCE(r.requester_phone, '')) LIKE ? OR
        LOWER(COALESCE(r.repair_vendor, '')) LIKE ? OR
        LOWER(COALESCE(r.technician_name, '')) LIKE ? OR
        LOWER(COALESCE(r.parts_added, '')) LIKE ? OR
        LOWER(COALESCE(a.internal_serial_number, '')) LIKE ? OR
        LOWER(COALESCE(a.assigned_user, '')) LIKE ?
      )`;
      repairParams.push(term, term, term, term, term, term, term, term, term);
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
      SELECT acc.*,
             COALESCE(acc.internal_serial_number, acc.accessory_code) as internal_serial_number,
             COALESCE(acc.accessory_code, acc.internal_serial_number) as accessory_code,
             a.internal_serial_number as asset_serial
      FROM accessories acc
      LEFT JOIN assets a ON acc.assigned_asset_id = a.id
      WHERE 1=1
    `;
    const accParams = [];
    tokens.forEach(tok => {
      const term = `%${tok}%`;
      accQuery += ` AND (
        LOWER(COALESCE(acc.internal_serial_number, acc.accessory_code)) LIKE ? OR
        LOWER(acc.accessory_code) LIKE ? OR
        LOWER(acc.name) LIKE ? OR
        LOWER(acc.category) LIKE ? OR
        LOWER(COALESCE(acc.brand, '')) LIKE ? OR
        LOWER(COALESCE(acc.model, '')) LIKE ? OR
        LOWER(COALESCE(acc.assigned_user, '')) LIKE ? OR
        LOWER(COALESCE(acc.location, '')) LIKE ?
      )`;
      accParams.push(term, term, term, term, term, term, term, term);
    });
    accQuery += ` ORDER BY acc.id ASC LIMIT 20`;
    const accessories = db.prepare(accQuery).all(...accParams);

    // 5. User Master (Employees) Tokenized Search
    let empQuery = `SELECT * FROM employees WHERE 1=1`;
    const empParams = [];
    tokens.forEach(tok => {
      const term = `%${tok}%`;
      empQuery += ` AND (
        LOWER(name) LIKE ? OR
        LOWER(COALESCE(department, '')) LIKE ? OR
        LOWER(COALESCE(designation, '')) LIKE ? OR
        LOWER(COALESCE(location, '')) LIKE ?
      )`;
      empParams.push(term, term, term, term);
    });
    empQuery += ` ORDER BY name ASC LIMIT 15`;
    const employees = db.prepare(empQuery).all(...empParams);

    // 6. Users Search (Admin and Technicians only)
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

    const totalResults = assets.length + repairs.length + keys.length + accessories.length + employees.length + users.length;

    res.json({
      query: q,
      totalResults,
      assets,
      repairs,
      keys,
      accessories,
      employees,
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

// POST /api/admin/clear-inventory-data - Danger Zone: Purge all operational inventory data
router.post('/admin/clear-inventory-data', requireRoles('admin'), (req, res) => {
  try {
    const { confirm } = req.body;
    if (confirm !== 'PURGE_ALL_DATA') {
      return res.status(400).json({
        error: 'Confirmation string required. Please provide { "confirm": "PURGE_ALL_DATA" }'
      });
    }

    purgeOperationalData();

    logAudit(
      req.user.id,
      req.user.username,
      'PURGE_ALL_OPERATIONAL_DATA',
      'system',
      'all',
      `All IT Assets, Repairs, Quick Heal Keys, Accessories, and Expenses were purged for fresh real data entry by ${req.user.username}`
    );

    res.json({
      success: true,
      message: 'All operational records (IT Assets, Repairs, Quick Heal Keys, Accessories, and Expenses) have been completely removed. Database is clean for fresh real data entry.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
