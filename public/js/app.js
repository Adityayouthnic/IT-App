/**
 * IT Asset & Lifecycle Management Web Application
 * Core Client Application Script
 */

let currentUser = null;
let currentView = 'dashboard';
let cachedAssets = [];
let cachedKeys = [];

// ==========================================
// 1. INITIALIZATION & AUTHENTICATION
// ==========================================

document.addEventListener('DOMContentLoaded', async () => {
  await checkAuth();
  setupGlobalEvents();
  handleRoute();
});

async function checkAuth() {
  const token = localStorage.getItem('it_app_token');
  if (!token) {
    window.location.href = '/login';
    return;
  }

  try {
    const res = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) {
      localStorage.removeItem('it_app_token');
      localStorage.removeItem('it_app_user');
      window.location.href = '/login';
      return;
    }

    const data = await res.json();
    currentUser = data.user;
    updateUserUI();
  } catch (err) {
    console.error('Auth verification error:', err);
    window.location.href = '/login';
  }
}

function updateUserUI() {
  if (!currentUser) return;

  const nameEl = document.getElementById('sidebar-user-name');
  const roleEl = document.getElementById('sidebar-user-role');
  const avatarEl = document.getElementById('sidebar-avatar');

  if (nameEl) nameEl.textContent = currentUser.full_name || currentUser.username;
  if (avatarEl) avatarEl.textContent = (currentUser.full_name || currentUser.username).charAt(0).toUpperCase();

  if (roleEl) {
    roleEl.textContent = currentUser.role.toUpperCase();
    roleEl.className = `user-role-badge role-${currentUser.role}`;
  }

  // Handle Role-based visibility
  const adminElements = document.querySelectorAll('.admin-only');
  adminElements.forEach(el => {
    el.style.display = (currentUser.role === 'admin') ? '' : 'none';
  });

  const techActions = document.querySelectorAll('.tech-action');
  techActions.forEach(el => {
    el.style.display = (currentUser.role === 'viewer') ? 'none' : '';
  });
}

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {}
  localStorage.removeItem('it_app_token');
  localStorage.removeItem('it_app_user');
  showToast('Logged out successfully', 'info');
  setTimeout(() => {
    window.location.href = '/login';
  }, 300);
}

// Global API Fetch helper with Auth Header
async function apiFetch(url, options = {}) {
  const token = localStorage.getItem('it_app_token');
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };

  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    logout();
    throw new Error('Session expired');
  }
  return res;
}

// ==========================================
// 2. ROUTING & VIEW NAVIGATION
// ==========================================

function handleRoute() {
  const hash = window.location.hash.replace('#', '') || 'dashboard';
  navigate(hash, {}, false);
}

window.addEventListener('hashchange', handleRoute);

function navigate(viewName, params = {}, updateHash = true) {
  currentView = viewName;
  if (updateHash) {
    window.location.hash = viewName;
  }

  // Update Nav links
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.view === viewName);
  });

  // Switch View Containers
  document.querySelectorAll('.view-container').forEach(view => {
    view.classList.remove('active');
  });

  const activeViewEl = document.getElementById(`view-${viewName}`);
  if (activeViewEl) {
    activeViewEl.classList.add('active');
  }

  // Close mobile sidebar if open
  document.getElementById('sidebar').classList.remove('mobile-open');

  // Trigger view data loaders
  switch (viewName) {
    case 'dashboard':
      loadDashboard();
      break;
    case 'assets':
      loadAssets(params);
      break;
    case 'repairs':
      loadRepairs(params);
      break;
    case 'keys':
      loadKeys(params);
      break;
    case 'accessories':
      loadAccessories(params);
      break;
    case 'search':
      if (params.q) {
        document.getElementById('dedicated-search-input').value = params.q;
        executeMasterSearch(params.q, 'master-search-results-container');
      }
      break;
    case 'settings':
      if (currentUser && currentUser.role === 'admin') {
        loadUsers();
        loadAuditLogs();
      }
      break;
  }
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('mobile-open');
}

// ==========================================
// 3. TOAST NOTIFICATIONS & MODALS
// ==========================================

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
  toast.innerHTML = `<span>${icon}</span> <span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(50px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('active');
    const firstInput = modal.querySelector('input:not([type=hidden]), select, textarea');
    if (firstInput) setTimeout(() => firstInput.focus(), 100);
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('active');
  }
}

function setupGlobalEvents() {
  // Close modals on backdrop click
  document.querySelectorAll('.modal-backdrop').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal(modal.id);
      }
    });
  });

  // Hotkey listener: Ctrl+K or / opens Master Search; Escape closes modals
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openMasterSearchModal();
    } else if (e.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop.active').forEach(m => closeModal(m.id));
    }
  });
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==========================================
// 4. VIEW: DASHBOARD
// ==========================================

async function loadDashboard() {
  try {
    const res = await apiFetch('/api/dashboard/stats');
    if (!res.ok) return;
    const data = await res.json();

    // Update KPI counters
    document.getElementById('kpi-total-assets').textContent = data.assets.total || 0;
    document.getElementById('sidebar-asset-count').textContent = data.assets.total || 0;

    document.getElementById('kpi-working-assets').textContent = data.assets.working || 0;
    document.getElementById('kpi-repair-assets').textContent = data.assets.in_repair || 0;
    document.getElementById('sidebar-repair-count').textContent = data.repairs.open_tickets || 0;

    document.getElementById('kpi-eol-assets').textContent = (data.assets.not_working || 0) + (data.assets.retired || 0);

    document.getElementById('kpi-total-keys').textContent = data.keys.total || 0;
    document.getElementById('sidebar-key-count').textContent = data.keys.available || 0;
    document.getElementById('kpi-keys-sub').textContent = `${data.keys.available || 0} available / ${data.keys.assigned || 0} assigned`;

    document.getElementById('kpi-repair-cost').textContent = `₹${(data.repairs.total_cost || 0).toLocaleString('en-IN')}`;

    // Render Department Distribution
    const deptContainer = document.getElementById('dept-breakdown-container');
    deptContainer.innerHTML = '';
    const maxDeptCount = data.deptBreakdown[0]?.count || 1;

    data.deptBreakdown.forEach(item => {
      const pct = Math.round((item.count / maxDeptCount) * 100);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; flex-direction:column; gap:4px; cursor:pointer;';
      row.onclick = () => navigate('assets', { department: item.department });
      row.innerHTML = `
        <div style="display:flex; justify-content:space-between; font-size:13px; font-weight:600;">
          <span>${escapeHtml(item.department)}</span>
          <span style="color:var(--primary); font-weight:700;">${item.count} assets</span>
        </div>
        <div style="height:8px; background:#f1f5f9; border-radius:4px; overflow:hidden;">
          <div style="width:${pct}%; height:100%; background:var(--primary-gradient); border-radius:4px;"></div>
        </div>
      `;
      deptContainer.appendChild(row);
    });

    // Render System Types Tags
    const typeContainer = document.getElementById('type-breakdown-container');
    typeContainer.innerHTML = '';
    data.typeBreakdown.forEach(item => {
      const tag = document.createElement('div');
      tag.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:8px 12px; background:#f8fafc; border:1px solid var(--border-color); border-radius:8px; cursor:pointer; font-size:13px; font-weight:600;';
      tag.onclick = () => navigate('assets', { type: item.asset_type });
      tag.innerHTML = `
        <span>💻 ${escapeHtml(item.asset_type)}</span>
        <span class="badge badge-key-assigned">${item.count}</span>
      `;
      typeContainer.appendChild(tag);
    });

    // Render Recent Repairs
    const repairsTbody = document.getElementById('dashboard-recent-repairs');
    repairsTbody.innerHTML = '';
    if (data.recentRepairs.length === 0) {
      repairsTbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:20px;">No repair tickets logged yet.</td></tr>`;
    } else {
      data.recentRepairs.forEach(r => {
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.onclick = () => navigate('repairs', { search: r.ticket_number });
        tr.innerHTML = `
          <td><strong>${escapeHtml(r.ticket_number)}</strong></td>
          <td><span class="badge badge-key-assigned">#${escapeHtml(r.internal_serial_number)}</span></td>
          <td style="max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(r.issue_description)}</td>
          <td>${escapeHtml(r.repair_vendor || r.technician_name || 'Internal IT')}</td>
          <td>₹${(r.repair_cost || 0).toLocaleString('en-IN')}</td>
          <td><span class="badge badge-repair">${escapeHtml(r.status)}</span></td>
        `;
        repairsTbody.appendChild(tr);
      });
    }

    // Render EOL Warnings
    const eolContainer = document.getElementById('dashboard-eol-warnings');
    eolContainer.innerHTML = '';
    if (data.eolWarnings.length === 0) {
      eolContainer.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:13px;">All registered assets are in good operating condition.</div>`;
    } else {
      data.eolWarnings.forEach(w => {
        const item = document.createElement('div');
        item.style.cssText = 'padding:12px; background:#fff7ed; border:1px solid #ffedd5; border-radius:8px; cursor:pointer;';
        item.onclick = () => viewAssetDetail(w.id);
        item.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong>#${escapeHtml(w.internal_serial_number)} - ${escapeHtml(w.brand)} ${escapeHtml(w.asset_type)}</strong>
            <span class="badge badge-notworking">${escapeHtml(w.working_status)}</span>
          </div>
          <p style="font-size:12px; color:#9a3412; margin-top:4px;">User: ${escapeHtml(w.assigned_user || 'Unassigned')} | ${escapeHtml(w.department || '')}</p>
          <div style="font-size:11px; color:#c2410c; margin-top:2px;">Repairs: ${w.repair_count} ticket(s) • Total spend: ₹${(w.total_repair_spent || 0).toLocaleString('en-IN')}</div>
        `;
        eolContainer.appendChild(item);
      });
    }

  } catch (err) {
    console.error('Dashboard load error:', err);
  }
}

// ==========================================
// 5. VIEW: IT ASSETS REGISTRY
// ==========================================

let assetSearchTimeout = null;
function debounceAssetSearch() {
  clearTimeout(assetSearchTimeout);
  assetSearchTimeout = setTimeout(() => loadAssets(), 300);
}

function resetAssetFilters() {
  document.getElementById('asset-filter-search').value = '';
  document.getElementById('asset-filter-type').value = '';
  document.getElementById('asset-filter-dept').value = '';
  document.getElementById('asset-filter-status').value = '';
  document.getElementById('asset-filter-key').value = '';
  loadAssets();
}

async function loadAssets(filterParams = {}) {
  try {
    const search = filterParams.search !== undefined ? filterParams.search : document.getElementById('asset-filter-search')?.value || '';
    const type = filterParams.type !== undefined ? filterParams.type : document.getElementById('asset-filter-type')?.value || '';
    const dept = filterParams.department !== undefined ? filterParams.department : document.getElementById('asset-filter-dept')?.value || '';
    const status = filterParams.status !== undefined ? filterParams.status : document.getElementById('asset-filter-status')?.value || '';
    const key = filterParams.quick_heal !== undefined ? filterParams.quick_heal : document.getElementById('asset-filter-key')?.value || '';

    // Sync input controls if params passed
    if (filterParams.search && document.getElementById('asset-filter-search')) document.getElementById('asset-filter-search').value = filterParams.search;
    if (filterParams.type && document.getElementById('asset-filter-type')) document.getElementById('asset-filter-type').value = filterParams.type;
    if (filterParams.department && document.getElementById('asset-filter-dept')) document.getElementById('asset-filter-dept').value = filterParams.department;
    if (filterParams.status && document.getElementById('asset-filter-status')) document.getElementById('asset-filter-status').value = filterParams.status;

    const params = new URLSearchParams();
    if (search) params.append('search', search);
    if (type) params.append('type', type);
    if (dept) params.append('department', dept);
    if (status) params.append('status', status);
    if (key) params.append('quick_heal', key);

    const res = await apiFetch(`/api/assets?${params.toString()}`);
    if (!res.ok) return;
    const data = await res.json();
    cachedAssets = data.assets;

    const tbody = document.getElementById('assets-table-body');
    tbody.innerHTML = '';

    document.getElementById('assets-count-label').textContent = `Showing ${data.total} assets`;

    if (data.assets.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; padding:40px; color:var(--text-muted);">No IT assets match the current filter.</td></tr>`;
      return;
    }

    data.assets.forEach(a => {
      const tr = document.createElement('tr');

      // Status pill class
      let statusBadge = `<span class="badge badge-working">Working</span>`;
      if (a.working_status === 'In Repair') statusBadge = `<span class="badge badge-repair">In Repair</span>`;
      else if (a.working_status === 'Not Working') statusBadge = `<span class="badge badge-notworking">Not Working</span>`;
      else if (a.working_status === 'Retired') statusBadge = `<span class="badge badge-retired">Retired</span>`;

      // Quick Heal pill
      let keyBadge = `<span style="color:#94a3b8; font-size:12px;">— None —</span>`;
      if (a.quick_heal_key_str) {
        keyBadge = `<span class="badge badge-key-available" title="${escapeHtml(a.quick_heal_key_str)}">🔑 Mapped</span>`;
      }

      // Lifecycle health badge
      let healthBadge = `<span class="badge badge-health-healthy">Healthy</span>`;
      if (a.healthClass === 'danger') {
        healthBadge = `<span class="badge badge-health-danger" title="${escapeHtml(a.eolReason)}">⚠️ ${escapeHtml(a.healthScore)}</span>`;
      } else if (a.healthClass === 'warning') {
        healthBadge = `<span class="badge badge-health-warning" title="${escapeHtml(a.eolReason)}">⚡ ${escapeHtml(a.healthScore)}</span>`;
      }

      const isViewer = currentUser?.role === 'viewer';
      const isAdmin = currentUser?.role === 'admin';

      tr.innerHTML = `
        <td><strong style="color:var(--primary); font-family:monospace; font-size:14px;">${escapeHtml(a.internal_serial_number)}</strong></td>
        <td>${escapeHtml(a.asset_type)}</td>
        <td><strong>${escapeHtml(a.brand || '')}</strong> <span style="color:var(--text-muted); font-size:12px;">${escapeHtml(a.model_name || '')}</span></td>
        <td>${escapeHtml(a.department || '—')}</td>
        <td><span style="font-size:12px; color:var(--text-muted);">${escapeHtml(a.location || '—')}</span></td>
        <td><strong>${escapeHtml(a.assigned_user || 'Unassigned')}</strong></td>
        <td>${keyBadge}</td>
        <td>${statusBadge}</td>
        <td>${healthBadge}</td>
        <td style="text-align:right; white-space:nowrap;">
          <button class="action-btn" title="View Complete Dossier" onclick="viewAssetDetail(${a.id})">👁️</button>
          ${!isViewer ? `<button class="action-btn" title="Edit Asset" onclick="openEditAssetModal(${a.id})">✏️</button>` : ''}
          ${!isViewer ? `<button class="action-btn" title="Log Repair" onclick="openRepairModal(${a.id})">🔧</button>` : ''}
          ${isAdmin ? `<button class="action-btn btn-delete" title="Delete Asset" onclick="deleteAsset(${a.id}, '${escapeHtml(a.internal_serial_number)}')">🗑️</button>` : ''}
        </td>
      `;
      tbody.appendChild(tr);
    });

  } catch (err) {
    console.error('Assets load error:', err);
  }
}

// Open Asset Detail Dossier Modal
async function viewAssetDetail(assetId) {
  try {
    const res = await apiFetch(`/api/assets/${assetId}`);
    if (!res.ok) {
      showToast('Failed to load asset details', 'error');
      return;
    }
    const { asset } = await res.json();

    document.getElementById('dossier-header-title').textContent = `Asset Dossier: #${asset.internal_serial_number} (${asset.brand} ${asset.asset_type})`;

    // Action buttons inside dossier
    const btnRepair = document.getElementById('dossier-btn-repair');
    const btnEdit = document.getElementById('dossier-btn-edit');

    if (btnRepair) btnRepair.onclick = () => { closeModal('modal-asset-detail'); openRepairModal(asset.id); };
    if (btnEdit) btnEdit.onclick = () => { closeModal('modal-asset-detail'); openEditAssetModal(asset.id); };

    // Format Repairs Timeline
    let repairsHtml = '';
    if (asset.repairs && asset.repairs.length > 0) {
      repairsHtml = `
        <div style="margin-top:20px;">
          <h4 style="font-size:14px; font-weight:700; margin-bottom:10px;">🛠️ Maintenance & Repair History (${asset.repairs.length} records, Total: ₹${asset.total_repair_cost.toLocaleString('en-IN')})</h4>
          <table class="data-table" style="font-size:12px;">
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Date</th>
                <th>Issue Description</th>
                <th>Parts Replaced / Added</th>
                <th>Vendor / Tech</th>
                <th>Cost</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${asset.repairs.map(r => `
                <tr>
                  <td><strong>${escapeHtml(r.ticket_number)}</strong></td>
                  <td>${escapeHtml(r.repair_date)}</td>
                  <td>${escapeHtml(r.issue_description)}</td>
                  <td><strong style="color:var(--primary);">${escapeHtml(r.parts_added || 'None')}</strong></td>
                  <td>${escapeHtml(r.repair_vendor || r.technician_name || 'Internal')}</td>
                  <td>₹${(r.repair_cost || 0).toLocaleString('en-IN')}</td>
                  <td><span class="badge badge-repair">${escapeHtml(r.status)}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } else {
      repairsHtml = `<div style="margin-top:16px; padding:12px; background:#f8fafc; border-radius:8px; font-size:13px; color:var(--text-muted);">✨ No repairs or component replacements logged yet.</div>`;
    }

    const body = document.getElementById('dossier-body');
    body.innerHTML = `
      <div class="asset-profile-header">
        <div class="asset-profile-title">
          <h2>💻 #${escapeHtml(asset.internal_serial_number)} - ${escapeHtml(asset.brand)} ${escapeHtml(asset.asset_type)}</h2>
          <p>Assigned to <strong>${escapeHtml(asset.assigned_user || 'Unassigned')}</strong> • ${escapeHtml(asset.department || 'General')} • Location: ${escapeHtml(asset.location || 'Head Office')}</p>
        </div>
        <div>
          <span class="badge ${asset.working_status === 'Working' ? 'badge-working' : asset.working_status === 'In Repair' ? 'badge-repair' : 'badge-notworking'}" style="font-size:14px; padding:6px 14px;">
            ${escapeHtml(asset.working_status)}
          </span>
        </div>
      </div>

      <!-- Lifecycle & EOL Status Banner -->
      <div class="lifecycle-banner ${asset.healthClass === 'danger' ? 'health-danger' : asset.healthClass === 'warning' ? 'health-warning' : 'health-healthy'}">
        <div style="font-size:26px;">${asset.healthClass === 'danger' ? '⚠️' : asset.healthClass === 'warning' ? '⚡' : '🛡️'}</div>
        <div>
          <strong style="font-size:14px;">Lifecycle Rating: ${escapeHtml(asset.healthScore)}</strong>
          <p style="font-size:12px; margin-top:2px;">${escapeHtml(asset.eolReason)}</p>
        </div>
      </div>

      <!-- Key Details Grid -->
      <div class="asset-dossier-grid">
        <div class="dossier-box">
          <span>Brand & Model</span>
          <strong>${escapeHtml(asset.brand || '—')} ${escapeHtml(asset.model_name || '')}</strong>
        </div>
        <div class="dossier-box">
          <span>Hardware Serial Number</span>
          <strong style="font-family:monospace;">${escapeHtml(asset.serial_number || 'N/A')}</strong>
        </div>
        <div class="dossier-box">
          <span>Operational Age</span>
          <strong>${escapeHtml(asset.ageString)}</strong>
        </div>
        <div class="dossier-box">
          <span>Purchase Date</span>
          <strong>${escapeHtml(asset.purchase_date || 'Not recorded in sheet')}</strong>
        </div>
        <div class="dossier-box">
          <span>Purchased From (Vendor)</span>
          <strong>${escapeHtml(asset.purchase_vendor || 'Standard Procurement')}</strong>
        </div>
        <div class="dossier-box">
          <span>Procurement Cost</span>
          <strong>₹${(asset.purchase_cost || 0).toLocaleString('en-IN')}</strong>
        </div>
        <div class="dossier-box">
          <span>Quick Heal Antivirus</span>
          <strong style="font-family:monospace; color:var(--primary); font-size:12px;">${escapeHtml(asset.quick_heal_key_str || 'No key mapped yet')}</strong>
          ${asset.quick_heal_validity ? `<span style="display:block; font-size:11px; color:#16a34a;">Valid till: ${escapeHtml(asset.quick_heal_validity)}</span>` : ''}
        </div>
        <div class="dossier-box">
          <span>Condition Rating</span>
          <strong>${escapeHtml(asset.condition_rating || 'Good')}</strong>
        </div>
        <div class="dossier-box">
          <span>Total Maintenance Spend</span>
          <strong>₹${(asset.total_repair_cost || 0).toLocaleString('en-IN')} (${asset.repair_count} repairs)</strong>
        </div>
      </div>

      <!-- Parts Added / Upgraded Ledger -->
      <div style="margin-bottom:16px; padding:14px; background:#f1f5f9; border-radius:8px; border:1px solid #cbd5e1;">
        <span style="font-size:11px; text-transform:uppercase; font-weight:700; color:#475569;">🧩 Parts Added & Component Upgrades Summary:</span>
        <div style="font-size:13px; font-weight:600; color:#1e293b; margin-top:4px;">
          ${escapeHtml(asset.parts_added_summary || 'No components upgraded/added yet.')}
        </div>
      </div>

      <!-- Operational Remarks -->
      <div style="padding:14px; background:#f8fafc; border-radius:8px; border:1px solid var(--border-color);">
        <span style="font-size:11px; text-transform:uppercase; font-weight:700; color:#64748b;">📝 Operational Usage & Remarks:</span>
        <div style="font-size:13px; color:#334155; margin-top:4px; line-height:1.5;">
          ${escapeHtml(asset.remarks || 'No remarks provided.')}
        </div>
      </div>

      ${repairsHtml}
    `;

    // Store for printing tag
    window.currentDossierAsset = asset;
    openModal('modal-asset-detail');

  } catch (err) {
    console.error('Asset detail view error:', err);
  }
}

// Print Asset Tag / Sticker
function printAssetTag() {
  const asset = window.currentDossierAsset;
  if (!asset) return;

  document.getElementById('tag-serial').textContent = asset.internal_serial_number;
  document.getElementById('tag-type-brand').textContent = `${asset.asset_type} - ${asset.brand || ''}`;
  document.getElementById('tag-dept-user').textContent = `Dept: ${asset.department || 'N/A'} | User: ${asset.assigned_user || 'Unassigned'}`;

  openModal('modal-print-tag');
}

// Add New Asset Modal
async function openNewAssetModal() {
  document.getElementById('form-asset').reset();
  document.getElementById('asset-form-id').value = '';
  document.getElementById('asset-form-title').textContent = 'Add New IT Asset';

  try {
    // Auto-fetch recommended serial number
    const res = await apiFetch('/api/assets/next-serial');
    if (res.ok) {
      const data = await res.json();
      document.getElementById('asset-serial').value = data.nextSerial;
    }

    // Populate available Quick Heal keys in dropdown
    await populateKeySelector();

    openModal('modal-asset-form');
  } catch (err) {
    console.error('Error opening new asset modal:', err);
  }
}

// Edit Asset Modal
async function openEditAssetModal(assetId) {
  try {
    const res = await apiFetch(`/api/assets/${assetId}`);
    if (!res.ok) return;
    const { asset } = await res.json();

    document.getElementById('asset-form-title').textContent = `Edit IT Asset #${asset.internal_serial_number}`;
    document.getElementById('asset-form-id').value = asset.id;
    document.getElementById('asset-serial').value = asset.internal_serial_number;
    document.getElementById('asset-type').value = asset.asset_type;
    document.getElementById('asset-brand').value = asset.brand || '';
    document.getElementById('asset-model').value = asset.model_name || '';
    document.getElementById('asset-hw-serial').value = asset.serial_number || '';
    document.getElementById('asset-purchase-date').value = asset.purchase_date || '';
    document.getElementById('asset-vendor').value = asset.purchase_vendor || '';
    document.getElementById('asset-cost').value = asset.purchase_cost || 0;
    document.getElementById('asset-department').value = asset.department || 'Orders';
    document.getElementById('asset-location').value = asset.location || '';
    document.getElementById('asset-user').value = asset.assigned_user || '';
    document.getElementById('asset-status').value = asset.working_status || 'Working';
    document.getElementById('asset-condition').value = asset.condition_rating || 'Good';
    document.getElementById('asset-parts').value = asset.parts_added_summary || '';
    document.getElementById('asset-remarks').value = asset.remarks || '';

    await populateKeySelector(asset.quick_heal_key_id);

    openModal('modal-asset-form');
  } catch (err) {
    console.error('Error opening edit asset modal:', err);
  }
}

async function populateKeySelector(selectedKeyId = null) {
  const select = document.getElementById('asset-key-select');
  select.innerHTML = '<option value="">-- No Key Mapped --</option>';

  const res = await apiFetch('/api/keys');
  if (!res.ok) return;
  const data = await res.json();

  data.keys.forEach(k => {
    // Only show available keys OR the currently mapped key for this asset
    if (k.status === 'Available' || k.id === Number(selectedKeyId)) {
      const opt = document.createElement('option');
      opt.value = k.id;
      opt.textContent = `${k.product_key} (${k.validity_date ? 'Exp: ' + k.validity_date : 'No Exp'})`;
      if (k.id === Number(selectedKeyId)) opt.selected = true;
      select.appendChild(opt);
    }
  });
}

// Handle Add / Edit Asset Form Submit
async function handleAssetSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('asset-form-id').value;
  const btn = document.getElementById('btn-save-asset');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  const payload = {
    internal_serial_number: document.getElementById('asset-serial').value.trim(),
    asset_type: document.getElementById('asset-type').value,
    brand: document.getElementById('asset-brand').value.trim(),
    model_name: document.getElementById('asset-model').value.trim(),
    serial_number: document.getElementById('asset-hw-serial').value.trim(),
    purchase_date: document.getElementById('asset-purchase-date').value || null,
    purchase_vendor: document.getElementById('asset-vendor').value.trim(),
    purchase_cost: Number(document.getElementById('asset-cost').value) || 0,
    department: document.getElementById('asset-department').value,
    location: document.getElementById('asset-location').value.trim(),
    assigned_user: document.getElementById('asset-user').value.trim(),
    working_status: document.getElementById('asset-status').value,
    quick_heal_key_id: document.getElementById('asset-key-select').value || null,
    condition_rating: document.getElementById('asset-condition').value,
    parts_added_summary: document.getElementById('asset-parts').value.trim(),
    remarks: document.getElementById('asset-remarks').value.trim()
  };

  try {
    const url = id ? `/api/assets/${id}` : '/api/assets';
    const method = id ? 'PUT' : 'POST';

    const res = await apiFetch(url, {
      method,
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'Asset saved successfully!', 'success');
      closeModal('modal-asset-form');
      loadAssets();
      loadDashboard();
    } else {
      showToast(data.error || 'Failed to save asset', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Network error', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Asset Details';
  }
}

// Delete Asset (Admin only)
async function deleteAsset(assetId, serial) {
  if (!confirm(`Are you sure you want to permanently delete Asset #${serial}? All linked repair logs will be deleted.`)) {
    return;
  }

  try {
    const res = await apiFetch(`/api/assets/${assetId}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'Asset deleted', 'success');
      loadAssets();
      loadDashboard();
    } else {
      showToast(data.error || 'Failed to delete asset', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function exportAssetsCSV() {
  window.open('/api/export/csv', '_blank');
}

// ==========================================
// 6. VIEW: REPAIRS & LIFECYCLE MANAGEMENT
// ==========================================

let repairSearchTimeout = null;
function debounceRepairSearch() {
  clearTimeout(repairSearchTimeout);
  repairSearchTimeout = setTimeout(() => loadRepairs(), 300);
}

async function loadRepairs(filterParams = {}) {
  try {
    const search = filterParams.search !== undefined ? filterParams.search : document.getElementById('repair-filter-search')?.value || '';
    const status = filterParams.status !== undefined ? filterParams.status : document.getElementById('repair-filter-status')?.value || '';

    if (filterParams.search && document.getElementById('repair-filter-search')) {
      document.getElementById('repair-filter-search').value = filterParams.search;
    }

    const params = new URLSearchParams();
    if (search) params.append('search', search);
    if (status) params.append('status', status);

    const res = await apiFetch(`/api/repairs?${params.toString()}`);
    if (!res.ok) return;
    const data = await res.json();

    const tbody = document.getElementById('repairs-table-body');
    tbody.innerHTML = '';

    if (data.repairs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:30px; color:var(--text-muted);">No repair tickets found.</td></tr>`;
      return;
    }

    data.repairs.forEach(r => {
      const tr = document.createElement('tr');
      const isViewer = currentUser?.role === 'viewer';
      const isAdmin = currentUser?.role === 'admin';

      let statusBadge = `<span class="badge badge-repair">${escapeHtml(r.status)}</span>`;
      if (r.status === 'Completed') statusBadge = `<span class="badge badge-working">Completed</span>`;
      else if (r.status === 'Beyond Repair') statusBadge = `<span class="badge badge-notworking">Beyond Repair (EOL)</span>`;

      tr.innerHTML = `
        <td><strong style="color:var(--primary); font-family:monospace;">${escapeHtml(r.ticket_number)}</strong></td>
        <td><span class="badge badge-key-assigned" style="cursor:pointer;" onclick="viewAssetDetail(${r.asset_id})">#${escapeHtml(r.internal_serial_number)}</span></td>
        <td style="max-width:240px;">${escapeHtml(r.issue_description)}</td>
        <td><strong style="color:#0284c7;">${escapeHtml(r.parts_added || '— None —')}</strong></td>
        <td>${escapeHtml(r.repair_vendor || r.technician_name || 'In-House IT')}</td>
        <td>${escapeHtml(r.repair_date)}</td>
        <td><strong>₹${(r.repair_cost || 0).toLocaleString('en-IN')}</strong></td>
        <td>${statusBadge}</td>
        <td style="text-align:right; white-space:nowrap;">
          ${!isViewer ? `<button class="action-btn" title="Edit Repair Status" onclick="openEditRepairModal(${r.id})">✏️</button>` : ''}
          ${isAdmin ? `<button class="action-btn btn-delete" title="Delete Ticket" onclick="deleteRepair(${r.id}, '${escapeHtml(r.ticket_number)}')">🗑️</button>` : ''}
        </td>
      `;
      tbody.appendChild(tr);
    });

    loadEolAnalysis();

  } catch (err) {
    console.error('Repairs load error:', err);
  }
}

// Load Automated End of Life (EOL) Recommendations Panel
async function loadEolAnalysis() {
  try {
    const res = await apiFetch('/api/assets');
    if (!res.ok) return;
    const data = await res.json();

    const container = document.getElementById('eol-recommendations-list');
    container.innerHTML = '';

    // Filter assets that have repairs or warning flags
    const flagged = data.assets.filter(a => a.repair_count > 0 || a.working_status !== 'Working' || a.healthClass !== 'success');

    if (flagged.length === 0) {
      container.innerHTML = `<div style="padding:20px; color:var(--text-muted); font-size:13px;">No assets currently meet the high-wear threshold. All devices operational.</div>`;
      return;
    }

    flagged.forEach(a => {
      const card = document.createElement('div');
      card.style.cssText = 'background:#ffffff; border:1px solid var(--border-color); border-radius:12px; padding:16px; box-shadow:var(--shadow-sm); cursor:pointer;';
      card.onclick = () => viewAssetDetail(a.id);

      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div>
            <strong style="font-size:15px; color:var(--text-main);">#${escapeHtml(a.internal_serial_number)} - ${escapeHtml(a.brand)} ${escapeHtml(a.asset_type)}</strong>
            <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">User: ${escapeHtml(a.assigned_user || 'Unassigned')} • ${escapeHtml(a.department || '')}</div>
          </div>
          <span class="badge ${a.healthClass === 'danger' ? 'badge-notworking' : 'badge-repair'}">${escapeHtml(a.healthScore)}</span>
        </div>
        <div style="margin: 10px 0; padding: 10px; background:#f8fafc; border-radius:8px; font-size:12px;">
          <div><strong>Repairs Logged:</strong> ${a.repair_count} ticket(s)</div>
          <div><strong>Total Repair Spend:</strong> ₹${(a.total_repair_cost || 0).toLocaleString('en-IN')}</div>
          <div><strong>Parts Replaced:</strong> ${escapeHtml(a.parts_added_summary || 'Standard servicing')}</div>
        </div>
        <p style="font-size:12px; color:#b91c1c; font-weight:500;">💡 Recommendation: ${escapeHtml(a.eolReason)}</p>
      `;
      container.appendChild(card);
    });

  } catch (err) {
    console.error('EOL analysis error:', err);
  }
}

// Open Repair Ticket Form
async function openRepairModal(preselectedAssetId = null) {
  document.getElementById('form-repair').reset();
  document.getElementById('repair-form-id').value = '';
  document.getElementById('repair-form-title').textContent = 'Log Asset Repair / Part Replacement';
  document.getElementById('repair-date').value = new Date().toISOString().split('T')[0];

  // Populate Asset Select Dropdown
  const select = document.getElementById('repair-asset-select');
  select.innerHTML = '<option value="">-- Choose IT Asset --</option>';

  try {
    const res = await apiFetch('/api/assets');
    if (res.ok) {
      const data = await res.json();
      data.assets.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = `#${a.internal_serial_number} - ${a.brand || ''} ${a.asset_type} (${a.assigned_user || 'Unassigned'})`;
        if (preselectedAssetId && (a.id === Number(preselectedAssetId) || a.internal_serial_number === String(preselectedAssetId))) {
          opt.selected = true;
        }
        select.appendChild(opt);
      });
    }
    openModal('modal-repair-form');
  } catch (err) {
    console.error(err);
  }
}

// Edit Repair Ticket
async function openEditRepairModal(repairId) {
  try {
    const res = await apiFetch('/api/repairs');
    if (!res.ok) return;
    const { repairs } = await res.json();
    const repair = repairs.find(r => r.id === repairId);
    if (!repair) return;

    document.getElementById('repair-form-title').textContent = `Update Ticket ${repair.ticket_number}`;
    document.getElementById('repair-form-id').value = repair.id;

    await openRepairModal(repair.asset_id);

    document.getElementById('repair-form-id').value = repair.id;
    document.getElementById('repair-date').value = repair.repair_date || '';
    document.getElementById('repair-type').value = repair.repair_type || 'Component Repair';
    document.getElementById('repair-issue').value = repair.issue_description || '';
    document.getElementById('repair-parts').value = repair.parts_added || '';
    document.getElementById('repair-vendor').value = repair.repair_vendor || '';
    document.getElementById('repair-tech').value = repair.technician_name || '';
    document.getElementById('repair-cost').value = repair.repair_cost || 0;
    document.getElementById('repair-status').value = repair.status || 'In Progress';
    document.getElementById('repair-remarks').value = repair.remarks || '';

  } catch (err) {
    console.error(err);
  }
}

// Submit Repair Ticket
async function handleRepairSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('repair-form-id').value;
  const btn = document.getElementById('btn-save-repair');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  const payload = {
    asset_id: document.getElementById('repair-asset-select').value,
    repair_date: document.getElementById('repair-date').value,
    repair_type: document.getElementById('repair-type').value,
    issue_description: document.getElementById('repair-issue').value.trim(),
    parts_added: document.getElementById('repair-parts').value.trim(),
    repair_vendor: document.getElementById('repair-vendor').value.trim(),
    technician_name: document.getElementById('repair-tech').value.trim(),
    repair_cost: Number(document.getElementById('repair-cost').value) || 0,
    status: document.getElementById('repair-status').value,
    remarks: document.getElementById('repair-remarks').value.trim(),
    update_asset_status: true
  };

  try {
    const url = id ? `/api/repairs/${id}` : '/api/repairs';
    const method = id ? 'PUT' : 'POST';

    const res = await apiFetch(url, {
      method,
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'Repair ticket saved!', 'success');
      closeModal('modal-repair-form');
      loadRepairs();
      loadAssets();
      loadDashboard();
    } else {
      showToast(data.error || 'Failed to save ticket', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Repair Ticket';
  }
}

async function deleteRepair(repairId, ticketNo) {
  if (!confirm(`Delete repair ticket ${ticketNo}?`)) return;

  try {
    const res = await apiFetch(`/api/repairs/${repairId}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      loadRepairs();
      loadDashboard();
    } else {
      showToast(data.error, 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==========================================
// 7. VIEW: QUICK HEAL KEYS MANAGEMENT
// ==========================================

let keySearchTimeout = null;
function debounceKeySearch() {
  clearTimeout(keySearchTimeout);
  keySearchTimeout = setTimeout(() => loadKeys(), 300);
}

async function loadKeys(filterParams = {}) {
  try {
    const search = filterParams.search !== undefined ? filterParams.search : document.getElementById('key-filter-search')?.value || '';
    const status = filterParams.status !== undefined ? filterParams.status : document.getElementById('key-filter-status')?.value || '';

    const params = new URLSearchParams();
    if (search) params.append('search', search);
    if (status) params.append('status', status);

    const res = await apiFetch(`/api/keys?${params.toString()}`);
    if (!res.ok) return;
    const data = await res.json();
    cachedKeys = data.keys;

    // Update Quick Heal KPIs
    const total = data.keys.length;
    const avail = data.keys.filter(k => k.status === 'Available').length;
    const assigned = data.keys.filter(k => k.status === 'Assigned').length;
    const expiring = data.keys.filter(k => k.is_expiring_soon).length;

    document.getElementById('keys-kpi-total').textContent = total;
    document.getElementById('keys-kpi-avail').textContent = avail;
    document.getElementById('keys-kpi-assigned').textContent = assigned;
    document.getElementById('keys-kpi-expiring').textContent = expiring;

    const tbody = document.getElementById('keys-table-body');
    tbody.innerHTML = '';

    if (data.keys.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:30px; color:var(--text-muted);">No Quick Heal keys found.</td></tr>`;
      return;
    }

    data.keys.forEach(k => {
      const tr = document.createElement('tr');
      const isViewer = currentUser?.role === 'viewer';
      const isAdmin = currentUser?.role === 'admin';

      let statusBadge = `<span class="badge badge-key-available">Available</span>`;
      if (k.status === 'Assigned') {
        statusBadge = `<span class="badge badge-key-assigned">Assigned</span>`;
      }

      // Remaining validity
      let validityDisplay = '<span style="color:#64748b;">N/A</span>';
      if (k.days_remaining !== null) {
        if (k.is_expired) {
          validityDisplay = `<span class="badge badge-notworking">Expired (${Math.abs(k.days_remaining)}d ago)</span>`;
        } else if (k.is_expiring_soon) {
          validityDisplay = `<span class="badge badge-repair">${k.days_remaining} days left</span>`;
        } else {
          const yrs = (k.days_remaining / 365).toFixed(1);
          validityDisplay = `<span class="badge badge-working">~${yrs} years left</span>`;
        }
      }

      // Mapped Asset info
      let mappedAsset = `<span style="color:#94a3b8; font-size:12px;">Not Assigned</span>`;
      if (k.assigned_asset_id && k.internal_serial_number) {
        mappedAsset = `<span class="badge badge-key-assigned" style="cursor:pointer;" onclick="viewAssetDetail(${k.assigned_asset_id})">#${escapeHtml(k.internal_serial_number)} (${escapeHtml(k.asset_type || '')})</span>`;
      }

      tr.innerHTML = `
        <td><strong style="color:var(--primary); font-family:monospace; font-size:13px; letter-spacing:1px;">${escapeHtml(k.product_key)}</strong></td>
        <td>${escapeHtml(k.edition || 'Total Security')}</td>
        <td>${escapeHtml(k.validity_date || '—')}</td>
        <td>${validityDisplay}</td>
        <td>${statusBadge}</td>
        <td>${mappedAsset}</td>
        <td>${escapeHtml(k.assigned_user || k.asset_assigned_user || '—')}</td>
        <td style="text-align:right; white-space:nowrap;">
          ${!isViewer && k.status === 'Available' ? `<button class="topbar-btn btn-primary" style="padding:4px 10px; font-size:11px;" onclick="openMapKeyModal(${k.id}, '${escapeHtml(k.product_key)}')">🔗 Map to Asset</button>` : ''}
          ${!isViewer && k.status === 'Assigned' ? `<button class="topbar-btn btn-secondary" style="padding:4px 10px; font-size:11px;" onclick="unmapKey(${k.id})">Unmap</button>` : ''}
          ${isAdmin ? `<button class="action-btn btn-delete" title="Delete Key" onclick="deleteKey(${k.id}, '${escapeHtml(k.product_key)}')">🗑️</button>` : ''}
        </td>
      `;
      tbody.appendChild(tr);
    });

  } catch (err) {
    console.error('Keys load error:', err);
  }
}

function openKeyModal() {
  document.getElementById('form-key').reset();
  openModal('modal-key-form');
}

function openBulkKeyModal() {
  document.getElementById('form-key-bulk').reset();
  openModal('modal-key-bulk');
}

async function handleKeySubmit(e) {
  e.preventDefault();
  const payload = {
    product_key: document.getElementById('key-code').value.trim(),
    edition: document.getElementById('key-edition').value.trim(),
    validity_date: document.getElementById('key-validity').value,
    notes: document.getElementById('key-notes').value.trim()
  };

  try {
    const res = await apiFetch('/api/keys', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok) {
      showToast('Quick Heal key added successfully!', 'success');
      closeModal('modal-key-form');
      loadKeys();
    } else {
      showToast(data.error || 'Failed to add key', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleBulkKeySubmit(e) {
  e.preventDefault();
  const payload = {
    raw_keys: document.getElementById('bulk-key-input').value,
    default_validity: document.getElementById('bulk-key-validity').value,
    default_edition: document.getElementById('bulk-key-edition').value
  };

  try {
    const res = await apiFetch('/api/keys/bulk-add', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      closeModal('modal-key-bulk');
      loadKeys();
    } else {
      showToast(data.error || 'Bulk import failed', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// 1-Click Map Key to Asset Modal
async function openMapKeyModal(keyId, keyCode) {
  document.getElementById('map-key-id').value = keyId;
  document.getElementById('map-key-display').textContent = keyCode;

  const select = document.getElementById('map-asset-select');
  select.innerHTML = '<option value="">-- Select Workstation / Laptop / Asset --</option>';

  try {
    const res = await apiFetch('/api/assets');
    if (res.ok) {
      const data = await res.json();
      data.assets.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = `#${a.internal_serial_number} - ${a.brand || ''} ${a.asset_type} (${a.assigned_user || 'Unassigned'} - ${a.department || 'General'})`;
        select.appendChild(opt);
      });
    }
    openModal('modal-map-key');
  } catch (err) {
    console.error(err);
  }
}

async function handleMapKeySubmit(e) {
  e.preventDefault();
  const keyId = document.getElementById('map-key-id').value;
  const assetId = document.getElementById('map-asset-select').value;

  try {
    const res = await apiFetch(`/api/keys/${keyId}/map`, {
      method: 'POST',
      body: JSON.stringify({ asset_id: assetId })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      closeModal('modal-map-key');
      loadKeys();
      loadAssets();
    } else {
      showToast(data.error || 'Failed to map key', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function unmapKey(keyId) {
  if (!confirm('Unmap this Quick Heal key? The license will be returned to the Available pool.')) return;

  try {
    const res = await apiFetch(`/api/keys/${keyId}/unmap`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      loadKeys();
      loadAssets();
    } else {
      showToast(data.error, 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteKey(keyId, keyCode) {
  if (!confirm(`Delete key ${keyCode}?`)) return;

  try {
    const res = await apiFetch(`/api/keys/${keyId}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      loadKeys();
    } else {
      showToast(data.error, 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==========================================
// 8. VIEW: ACCESSORIES INVENTORY
// ==========================================

let accSearchTimeout = null;
function debounceAccSearch() {
  clearTimeout(accSearchTimeout);
  accSearchTimeout = setTimeout(() => loadAccessories(), 300);
}

async function loadAccessories(filterParams = {}) {
  try {
    const search = filterParams.search !== undefined ? filterParams.search : document.getElementById('acc-filter-search')?.value || '';
    const cat = filterParams.category !== undefined ? filterParams.category : document.getElementById('acc-filter-cat')?.value || '';
    const status = filterParams.status !== undefined ? filterParams.status : document.getElementById('acc-filter-status')?.value || '';

    const params = new URLSearchParams();
    if (search) params.append('search', search);
    if (cat) params.append('category', cat);
    if (status) params.append('status', status);

    const res = await apiFetch(`/api/accessories?${params.toString()}`);
    if (!res.ok) return;
    const data = await res.json();

    document.getElementById('sidebar-acc-count').textContent = data.accessories.length;

    const tbody = document.getElementById('accessories-table-body');
    tbody.innerHTML = '';

    if (data.accessories.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:30px; color:var(--text-muted);">No accessories found.</td></tr>`;
      return;
    }

    data.accessories.forEach(item => {
      const tr = document.createElement('tr');
      const isViewer = currentUser?.role === 'viewer';
      const isAdmin = currentUser?.role === 'admin';

      let statusBadge = `<span class="badge badge-working">${escapeHtml(item.status)}</span>`;
      if (item.status === 'Assigned') statusBadge = `<span class="badge badge-key-assigned">Assigned</span>`;
      else if (item.status === 'Damaged') statusBadge = `<span class="badge badge-notworking">Damaged</span>`;

      tr.innerHTML = `
        <td><strong style="font-family:monospace; color:var(--primary);">${escapeHtml(item.accessory_code)}</strong></td>
        <td><strong>${escapeHtml(item.name)}</strong></td>
        <td><span class="badge badge-repair">${escapeHtml(item.category)}</span></td>
        <td>${escapeHtml(item.brand || '')} ${escapeHtml(item.model || '')}</td>
        <td><strong>${item.quantity}</strong></td>
        <td>${escapeHtml(item.location || 'IT Store')}</td>
        <td>${escapeHtml(item.assigned_user || (item.asset_serial ? '#' + item.asset_serial : '—'))}</td>
        <td>${statusBadge}</td>
        <td style="text-align:right; white-space:nowrap;">
          ${!isViewer ? `<button class="action-btn" title="Edit" onclick="openEditAccessoryModal(${item.id})">✏️</button>` : ''}
          ${isAdmin ? `<button class="action-btn btn-delete" title="Delete" onclick="deleteAccessory(${item.id})">🗑️</button>` : ''}
        </td>
      `;
      tbody.appendChild(tr);
    });

  } catch (err) {
    console.error('Accessories load error:', err);
  }
}

function openAccessoryModal() {
  document.getElementById('form-accessory').reset();
  document.getElementById('acc-form-id').value = '';
  document.getElementById('acc-form-title').textContent = 'Add Accessory';
  openModal('modal-accessory-form');
}

async function openEditAccessoryModal(accId) {
  try {
    const res = await apiFetch('/api/accessories');
    if (!res.ok) return;
    const { accessories } = await res.json();
    const item = accessories.find(a => a.id === accId);
    if (!item) return;

    document.getElementById('acc-form-title').textContent = `Edit Accessory ${item.accessory_code}`;
    document.getElementById('acc-form-id').value = item.id;
    document.getElementById('acc-code').value = item.accessory_code;
    document.getElementById('acc-category').value = item.category;
    document.getElementById('acc-name').value = item.name;
    document.getElementById('acc-brand').value = item.brand || '';
    document.getElementById('acc-qty').value = item.quantity;
    document.getElementById('acc-location').value = item.location || '';
    document.getElementById('acc-status').value = item.status;
    document.getElementById('acc-remarks').value = item.remarks || '';

    openModal('modal-accessory-form');
  } catch (err) {
    console.error(err);
  }
}

async function handleAccessorySubmit(e) {
  e.preventDefault();
  const id = document.getElementById('acc-form-id').value;
  const payload = {
    accessory_code: document.getElementById('acc-code').value.trim(),
    category: document.getElementById('acc-category').value,
    name: document.getElementById('acc-name').value.trim(),
    brand: document.getElementById('acc-brand').value.trim(),
    quantity: Number(document.getElementById('acc-qty').value) || 1,
    location: document.getElementById('acc-location').value.trim(),
    status: document.getElementById('acc-status').value,
    remarks: document.getElementById('acc-remarks').value.trim()
  };

  try {
    const url = id ? `/api/accessories/${id}` : '/api/accessories';
    const method = id ? 'PUT' : 'POST';

    const res = await apiFetch(url, {
      method,
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'Accessory saved', 'success');
      closeModal('modal-accessory-form');
      loadAccessories();
    } else {
      showToast(data.error || 'Failed to save accessory', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteAccessory(id) {
  if (!confirm('Delete this accessory item?')) return;
  try {
    const res = await apiFetch(`/api/accessories/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      loadAccessories();
    } else {
      showToast(data.error, 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==========================================
// 9. MASTER SEARCH INTELLIGENCE
// ==========================================

function openMasterSearchModal() {
  openModal('modal-master-search');
  setTimeout(() => {
    document.getElementById('popup-search-input').focus();
  }, 150);
}

let masterSearchTimeout = null;
function debounceMasterSearch() {
  clearTimeout(masterSearchTimeout);
  const q = document.getElementById('dedicated-search-input').value.trim();
  masterSearchTimeout = setTimeout(() => {
    executeMasterSearch(q, 'master-search-results-container');
  }, 250);
}

let popupSearchTimeout = null;
function debouncePopupSearch() {
  clearTimeout(popupSearchTimeout);
  const q = document.getElementById('popup-search-input').value.trim();
  popupSearchTimeout = setTimeout(() => {
    executeMasterSearch(q, 'popup-search-results', true);
  }, 250);
}

function quickSearch(keyword) {
  document.getElementById('dedicated-search-input').value = keyword;
  executeMasterSearch(keyword, 'master-search-results-container');
}

async function executeMasterSearch(query, targetContainerId, isModal = false) {
  const container = document.getElementById(targetContainerId);
  if (!query) {
    container.innerHTML = `
      <div style="text-align:center; padding:40px 20px; color:var(--text-muted);">
        <div style="font-size:36px; margin-bottom:8px;">🔍</div>
        <p>Type a search keyword (e.g. brand, staff name, serial, part, ticket) to search all modules.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `<div style="text-align:center; padding:30px; color:var(--primary); font-weight:600;">Searching all databases for "${escapeHtml(query)}"...</div>`;

  try {
    const res = await apiFetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) return;
    const data = await res.json();

    if (data.totalResults === 0) {
      container.innerHTML = `
        <div style="text-align:center; padding:50px 20px; color:var(--text-muted);">
          <div style="font-size:36px; margin-bottom:8px;">🤷‍♂️</div>
          <h3>No matching records found</h3>
          <p>We searched Assets, Repairs, Keys, Accessories, and Users for "<strong>${escapeHtml(query)}</strong>" without any matches.</p>
        </div>
      `;
      return;
    }

    let html = `<div style="margin-bottom:16px; font-size:13px; font-weight:600; color:var(--text-muted);">Found ${data.totalResults} matching results across infrastructure</div>`;

    // 1. Assets Results
    if (data.assets && data.assets.length > 0) {
      html += `
        <div class="search-results-section">
          <div class="search-section-title">💻 IT Assets (${data.assets.length})</div>
          ${data.assets.map(a => `
            <div class="search-result-item" onclick="if(${isModal}){closeModal('modal-master-search');} viewAssetDetail(${a.id})">
              <div>
                <strong style="color:var(--primary); font-size:14px;">#${escapeHtml(a.internal_serial_number)} - ${escapeHtml(a.brand)} ${escapeHtml(a.asset_type)}</strong>
                <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">User: <strong>${escapeHtml(a.assigned_user || 'Unassigned')}</strong> | Dept: ${escapeHtml(a.department || '—')} | Location: ${escapeHtml(a.location || '—')}</div>
                ${a.remarks ? `<div style="font-size:11px; color:#64748b; margin-top:2px;">${escapeHtml(a.remarks)}</div>` : ''}
              </div>
              <span class="badge ${a.working_status === 'Working' ? 'badge-working' : 'badge-notworking'}">${escapeHtml(a.working_status)}</span>
            </div>
          `).join('')}
        </div>
      `;
    }

    // 2. Repairs Results
    if (data.repairs && data.repairs.length > 0) {
      html += `
        <div class="search-results-section">
          <div class="search-section-title">🔧 Maintenance & Repair Tickets (${data.repairs.length})</div>
          ${data.repairs.map(r => `
            <div class="search-result-item" onclick="if(${isModal}){closeModal('modal-master-search');} navigate('repairs', { search: '${r.ticket_number}' })">
              <div>
                <strong style="color:var(--primary); font-size:14px;">${escapeHtml(r.ticket_number)} (Asset #${escapeHtml(r.internal_serial_number)})</strong>
                <div style="font-size:12px; color:#1e293b; margin-top:2px;"><strong>Fault:</strong> ${escapeHtml(r.issue_description)}</div>
                ${r.parts_added ? `<div style="font-size:11px; color:#0284c7; margin-top:2px;"><strong>Parts Added:</strong> ${escapeHtml(r.parts_added)}</div>` : ''}
              </div>
              <div>
                <span class="badge badge-repair">${escapeHtml(r.status)}</span>
                <span style="display:block; font-size:11px; text-align:right; margin-top:4px;">₹${(r.repair_cost || 0).toLocaleString('en-IN')}</span>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }

    // 3. Quick Heal Keys Results
    if (data.keys && data.keys.length > 0) {
      html += `
        <div class="search-results-section">
          <div class="search-section-title">🔑 Quick Heal Antivirus Keys (${data.keys.length})</div>
          ${data.keys.map(k => `
            <div class="search-result-item" onclick="if(${isModal}){closeModal('modal-master-search');} navigate('keys', { search: '${k.product_key}' })">
              <div>
                <strong style="color:var(--primary); font-family:monospace; font-size:13px;">${escapeHtml(k.product_key)}</strong>
                <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">Valid till: ${escapeHtml(k.validity_date || 'N/A')} • Assigned: ${escapeHtml(k.assigned_user || (k.internal_serial_number ? 'Asset #' + k.internal_serial_number : 'Available in pool'))}</div>
              </div>
              <span class="badge ${k.status === 'Assigned' ? 'badge-key-assigned' : 'badge-key-available'}">${escapeHtml(k.status)}</span>
            </div>
          `).join('')}
        </div>
      `;
    }

    // 4. Accessories Results
    if (data.accessories && data.accessories.length > 0) {
      html += `
        <div class="search-results-section">
          <div class="search-section-title">🖱️ Accessories & Components (${data.accessories.length})</div>
          ${data.accessories.map(acc => `
            <div class="search-result-item" onclick="if(${isModal}){closeModal('modal-master-search');} navigate('accessories', { search: '${acc.accessory_code}' })">
              <div>
                <strong style="color:var(--primary); font-size:14px;">${escapeHtml(acc.accessory_code)} - ${escapeHtml(acc.name)}</strong>
                <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">Location: ${escapeHtml(acc.location || 'Store Room')} | Stock: ${acc.quantity} units</div>
              </div>
              <span class="badge badge-working">${escapeHtml(acc.status)}</span>
            </div>
          `).join('')}
        </div>
      `;
    }

    // 5. Users Results
    if (data.users && data.users.length > 0) {
      html += `
        <div class="search-results-section">
          <div class="search-section-title">👥 Staff & System Accounts (${data.users.length})</div>
          ${data.users.map(u => `
            <div class="search-result-item">
              <div>
                <strong style="font-size:14px;">${escapeHtml(u.full_name)} (@${escapeHtml(u.username)})</strong>
                <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">${escapeHtml(u.email || 'No email provided')}</div>
              </div>
              <span class="user-role-badge role-${u.role}">${escapeHtml(u.role.toUpperCase())}</span>
            </div>
          `).join('')}
        </div>
      `;
    }

    container.innerHTML = html;

  } catch (err) {
    console.error('Master search error:', err);
  }
}

// ==========================================
// 10. SETTINGS & USER MANAGEMENT (ADMIN ONLY)
// ==========================================

async function loadUsers() {
  try {
    const res = await apiFetch('/api/users');
    if (!res.ok) return;
    const { users } = await res.json();

    const tbody = document.getElementById('users-table-body');
    tbody.innerHTML = '';

    users.forEach(u => {
      const tr = document.createElement('tr');
      const isSelf = currentUser && currentUser.id === u.id;

      tr.innerHTML = `
        <td><strong>@${escapeHtml(u.username)}</strong> ${isSelf ? '<span class="badge badge-working" style="font-size:10px;">You</span>' : ''}</td>
        <td>${escapeHtml(u.full_name)}</td>
        <td>${escapeHtml(u.email || '—')}</td>
        <td><span class="user-role-badge role-${u.role}">${escapeHtml(u.role.toUpperCase())}</span></td>
        <td><span class="badge ${u.status === 'active' ? 'badge-working' : 'badge-notworking'}">${escapeHtml(u.status)}</span></td>
        <td>${new Date(u.created_at).toLocaleDateString()}</td>
        <td style="text-align:right; white-space:nowrap;">
          <button class="action-btn" title="Edit User & Role" onclick="openEditUserModal(${u.id})">✏️</button>
          ${!isSelf ? `<button class="action-btn btn-delete" title="Delete User" onclick="deleteUser(${u.id}, '${escapeHtml(u.username)}')">🗑️</button>` : ''}
        </td>
      `;
      tbody.appendChild(tr);
    });

  } catch (err) {
    console.error('Users load error:', err);
  }
}

function openUserModal() {
  document.getElementById('form-user').reset();
  document.getElementById('user-form-id').value = '';
  document.getElementById('user-form-title').textContent = 'Add System User';
  document.getElementById('user-username').readOnly = false;
  document.getElementById('user-password').required = true;
  document.getElementById('user-password-label').textContent = 'Password *';
  openModal('modal-user-form');
}

async function openEditUserModal(userId) {
  try {
    const res = await apiFetch('/api/users');
    if (!res.ok) return;
    const { users } = await res.json();
    const user = users.find(u => u.id === userId);
    if (!user) return;

    document.getElementById('user-form-title').textContent = `Edit User @${user.username}`;
    document.getElementById('user-form-id').value = user.id;
    document.getElementById('user-username').value = user.username;
    document.getElementById('user-username').readOnly = true;
    document.getElementById('user-fullname').value = user.full_name;
    document.getElementById('user-email').value = user.email || '';
    document.getElementById('user-role').value = user.role;
    document.getElementById('user-status').value = user.status;

    document.getElementById('user-password').required = false;
    document.getElementById('user-password-label').textContent = 'New Password (Leave blank to keep unchanged)';

    openModal('modal-user-form');
  } catch (err) {
    console.error(err);
  }
}

async function handleUserSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('user-form-id').value;
  const payload = {
    username: document.getElementById('user-username').value.trim(),
    full_name: document.getElementById('user-fullname').value.trim(),
    email: document.getElementById('user-email').value.trim(),
    role: document.getElementById('user-role').value,
    status: document.getElementById('user-status').value
  };

  const passwordVal = document.getElementById('user-password').value;
  if (id) {
    if (passwordVal) payload.new_password = passwordVal;
  } else {
    payload.password = passwordVal;
  }

  try {
    const url = id ? `/api/users/${id}` : '/api/users';
    const method = id ? 'PUT' : 'POST';

    const res = await apiFetch(url, {
      method,
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'User saved', 'success');
      closeModal('modal-user-form');
      loadUsers();
    } else {
      showToast(data.error || 'Failed to save user', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteUser(userId, username) {
  if (!confirm(`Delete user account @${username}?`)) return;

  try {
    const res = await apiFetch(`/api/users/${userId}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      loadUsers();
    } else {
      showToast(data.error, 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadAuditLogs() {
  try {
    const res = await apiFetch('/api/audit-logs');
    if (!res.ok) return;
    const { logs } = await res.json();

    const tbody = document.getElementById('audit-logs-table-body');
    tbody.innerHTML = '';

    if (logs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-muted);">No audit events recorded yet.</td></tr>`;
      return;
    }

    logs.forEach(log => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-size:12px; color:var(--text-muted);">${new Date(log.created_at).toLocaleString()}</td>
        <td><strong>@${escapeHtml(log.username)}</strong></td>
        <td><span class="badge badge-key-assigned">${escapeHtml(log.action)}</span></td>
        <td>${escapeHtml(log.entity_type)}</td>
        <td style="font-size:12px; max-width:300px;">${escapeHtml(log.details)}</td>
      `;
      tbody.appendChild(tr);
    });

  } catch (err) {
    console.error('Audit logs error:', err);
  }
}

// Download Complete JSON Database Backup
async function downloadDatabaseBackup() {
  try {
    const [resAssets, resRepairs, resKeys, resAccessories] = await Promise.all([
      apiFetch('/api/assets'),
      apiFetch('/api/repairs'),
      apiFetch('/api/keys'),
      apiFetch('/api/accessories')
    ]);

    const backup = {
      exported_at: new Date().toISOString(),
      organization: 'VB EXPORTS',
      assets: (await resAssets.json()).assets,
      repairs: (await resRepairs.json()).repairs,
      quick_heal_keys: (await resKeys.json()).keys,
      accessories: (await resAccessories.json()).accessories
    };

    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `IT_App_Backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Database JSON backup downloaded!', 'success');
  } catch (err) {
    showToast('Failed to generate backup: ' + err.message, 'error');
  }
}
