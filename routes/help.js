const express = require('express');
const router = express.Router();
const { db } = require('../database');

// Helper to log public audit events
function logHelpAudit(action, entityId, details) {
  try {
    db.prepare(`
      INSERT INTO audit_logs (user_id, username, action, entity_type, entity_id, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(null, 'public_helpdesk', action, 'repair', String(entityId), details);
  } catch (e) {
    console.error('Audit log error:', e);
  }
}

// Ensure a fallback general asset exists for requests where user doesn't have a specific hardware asset
function getOrCreateFallbackAsset() {
  let asset = db.prepare(`SELECT id, internal_serial_number FROM assets WHERE internal_serial_number = 'GEN-IT' OR asset_type = 'General Support' LIMIT 1`).get();
  if (!asset) {
    const res = db.prepare(`
      INSERT INTO assets (
        internal_serial_number, asset_type, brand, model_name, working_status,
        condition_rating, department, location, remarks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'GEN-IT', 'General Support', 'Youthnic IT', 'Help Desk Desk & Common Facilities',
      'Working', 'Good', 'General', 'Head Office', 'Virtual anchor asset for general help desk tickets'
    );
    asset = { id: res.lastInsertRowid, internal_serial_number: 'GEN-IT' };
  }
  return asset;
}

// Simple in-memory rate limiting map
function createRateLimiter(windowMs, maxRequests, errMsg) {
  const attempts = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of attempts.entries()) {
      if (now > data.resetAt) attempts.delete(ip);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const ip = (req.ip || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    const now = Date.now();
    const data = attempts.get(ip);
    if (!data || now > data.resetAt) {
      attempts.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (data.count >= maxRequests) {
      const waitMinutes = Math.ceil((data.resetAt - now) / 60000);
      return res.status(429).json({
        error: errMsg || `Too many requests. Please try again in ${waitMinutes} minute(s).`
      });
    }
    data.count += 1;
    next();
  };
}

const helpRequestLimiter = createRateLimiter(10 * 60 * 1000, 15, 'Too many support requests submitted from this IP. Please wait a few minutes.');
const helpTrackLimiter = createRateLimiter(60 * 1000, 45, 'Too many lookup requests. Please slow down.');

// GET /api/help/options - Public metadata for dropdowns and auto-complete
router.get('/options', (req, res) => {
  try {
    const departments = db.prepare(`
      SELECT name, code FROM departments ORDER BY name ASC
    `).all();

    // Only return name and department to prevent personal contact leakage to unauthenticated visitors
    const employees = db.prepare(`
      SELECT name, department FROM employees WHERE status = 'Active' ORDER BY name ASC
    `).all();

    // Only expose general asset tagging info (no internal location, assigned custodian, or cost)
    const assets = db.prepare(`
      SELECT id, internal_serial_number, asset_type, brand, model_name
      FROM assets
      WHERE working_status != 'Retired'
      ORDER BY internal_serial_number ASC
    `).all();

    res.json({
      departments,
      employees,
      assets,
      repair_types: [
        'Software Installation / Service',
        'Component Repair',
        'Part Replacement',
        'Hardware Upgrade (SSD/RAM)',
        'Preventive Maintenance',
        'Network / WiFi Connectivity',
        'Email / Account Issue',
        'Printer / Scanner Support',
        'General IT Support'
      ],
      priorities: [
        { label: 'Normal - Standard request', value: 'Normal' },
        { label: 'High - Impairs daily work', value: 'High' },
        { label: 'Critical - System down / Work stopped', value: 'Critical' }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/help/request - Submit a new IT repair / service request (No login required)
router.post('/request', helpRequestLimiter, (req, res) => {
  try {
    const {
      requester_name,
      requester_phone,
      requester_email,
      requester_department,
      asset_id,
      internal_serial_number,
      repair_type,
      priority,
      issue_description,
      description,
      remarks
    } = req.body;

    const resolvedDescription = (issue_description || description || '').trim();
    const resolvedRepairType = (repair_type || req.body.issue_type || 'General IT Support').trim();

    if (!requester_name || !requester_name.trim()) {
      return res.status(400).json({ error: 'Please enter your name.' });
    }
    if (requester_name.trim().length > 100) {
      return res.status(400).json({ error: 'Requester name cannot exceed 100 characters.' });
    }
    if (!resolvedDescription) {
      return res.status(400).json({ error: 'Please describe the issue or service needed.' });
    }
    if (resolvedDescription.length > 3000) {
      return res.status(400).json({ error: 'Issue description cannot exceed 3000 characters.' });
    }
    if (requester_phone && requester_phone.trim().length > 30) {
      return res.status(400).json({ error: 'Phone number cannot exceed 30 characters.' });
    }
    if (requester_email && requester_email.trim().length > 100) {
      return res.status(400).json({ error: 'Email address cannot exceed 100 characters.' });
    }

    // Determine target asset
    let targetAssetId = asset_id ? Number(asset_id) : null;
    if (!targetAssetId && internal_serial_number) {
      const cleanSerial = internal_serial_number.replace(/^#/, '').trim();
      const found = db.prepare(`SELECT id FROM assets WHERE LOWER(internal_serial_number) = LOWER(?)`).get(cleanSerial);
      if (found) {
        targetAssetId = found.id;
      }
    }

    // If still no asset, check if requester has an assigned asset
    if (!targetAssetId) {
      const userAsset = db.prepare(`
        SELECT id FROM assets WHERE LOWER(TRIM(assigned_user)) = LOWER(TRIM(?)) LIMIT 1
      `).get(requester_name.trim());
      if (userAsset) {
        targetAssetId = userAsset.id;
      }
    }

    // If still no asset, use fallback general support asset so NOT NULL foreign key is valid
    if (!targetAssetId) {
      const fallback = getOrCreateFallbackAsset();
      targetAssetId = fallback.id;
    }

    // Generate sequential ticket number
    const year = new Date().getFullYear();
    const latestTicket = db.prepare(`
      SELECT ticket_number FROM repairs WHERE ticket_number LIKE ? ORDER BY id DESC LIMIT 1
    `).get(`REP-${year}-%`);

    let nextNum = 1;
    if (latestTicket && latestTicket.ticket_number) {
      const parts = latestTicket.ticket_number.split('-');
      const lastNum = parseInt(parts[2], 10);
      if (!isNaN(lastNum)) nextNum = lastNum + 1;
    }
    const ticket_number = `REP-${year}-${String(nextNum).padStart(3, '0')}`;

    const cleanType = (resolvedRepairType && resolvedRepairType.trim()) ? resolvedRepairType.trim() : 'Software Installation / Service';
    const cleanPriority = ['Normal', 'High', 'Critical'].includes(priority) ? priority : 'Normal';
    const today = new Date().toISOString().split('T')[0];

    const insert = db.prepare(`
      INSERT INTO repairs (
        ticket_number,
        asset_id,
        issue_description,
        repair_date,
        repair_type,
        status,
        requester_name,
        requester_phone,
        requester_email,
        requester_department,
        priority,
        remarks
      ) VALUES (?, ?, ?, ?, ?, 'Pending Approval', ?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      ticket_number,
      targetAssetId,
      resolvedDescription,
      today,
      cleanType,
      requester_name.trim(),
      requester_phone ? requester_phone.trim() : '',
      requester_email ? requester_email.trim() : '',
      requester_department ? requester_department.trim() : '',
      cleanPriority,
      remarks ? remarks.trim().substring(0, 500) : 'Submitted via Public Help Desk'
    );

    // Auto-register user in User Master (employees table) if not already existing
    if (requester_name.trim()) {
      try {
        const emp = db.prepare('SELECT id FROM employees WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))').get(requester_name.trim());
        if (!emp) {
          db.prepare(`
            INSERT INTO employees (name, department, email, phone, location, status)
            VALUES (?, ?, ?, ?, ?, 'Active')
          `).run(
            requester_name.trim(),
            requester_department ? requester_department.trim() : '',
            requester_email ? requester_email.trim() : '',
            requester_phone ? requester_phone.trim() : '',
            'Office'
          );
        }
      } catch (e) {
        // Ignore duplicate employee warning
      }
    }

    logHelpAudit('PUBLIC_TICKET_RAISED', result.lastInsertRowid, `Ticket ${ticket_number} submitted by ${requester_name.trim()} (${cleanType})`);

    // Fetch created ticket with linked asset info
    const createdTicket = db.prepare(`
      SELECT r.ticket_number, r.repair_date, r.due_date, r.repair_type, r.status, r.priority, r.issue_description,
             a.internal_serial_number, a.asset_type, a.brand, a.model_name
      FROM repairs r
      LEFT JOIN assets a ON r.asset_id = a.id
      WHERE r.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({
      success: true,
      ticket_number,
      ticket_id: result.lastInsertRowid,
      ticket: createdTicket,
      message: `Your IT support ticket #${ticket_number} has been submitted successfully and is queued for IT administrator approval.`
    });
  } catch (err) {
    console.error('Public help request error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/help/track/:ticket - Public ticket tracking by ticket number or phone
router.get('/track/:ticket', helpTrackLimiter, (req, res) => {
  try {
    const rawSearch = (req.params.ticket || '').trim();
    if (!rawSearch) {
      return res.status(400).json({ error: 'Please enter a ticket number or phone number.' });
    }
    if (rawSearch.length > 50) {
      return res.status(400).json({ error: 'Search query too long.' });
    }

    const cleanTicket = rawSearch.toUpperCase().replace(/^#/, '');

    const ticket = db.prepare(`
      SELECT r.ticket_number, r.repair_date, r.due_date, r.completion_date,
             r.repair_type, r.priority, r.status, r.issue_description,
             r.requester_name, r.requester_department,
             r.technician_name, r.technician_contact, r.rejection_reason,
             a.internal_serial_number, a.asset_type, a.brand, a.model_name
      FROM repairs r
      LEFT JOIN assets a ON r.asset_id = a.id
      WHERE UPPER(r.ticket_number) = ? OR UPPER(r.ticket_number) = ? OR r.requester_phone = ?
      ORDER BY r.id DESC
      LIMIT 1
    `).get(cleanTicket, `REP-${cleanTicket}`, rawSearch);

    if (!ticket) {
      return res.status(404).json({ error: `No support ticket found matching "${rawSearch}". Please double-check your Ticket Number.` });
    }

    res.json({ ticket });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
