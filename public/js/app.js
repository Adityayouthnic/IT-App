/**
 * IT Asset & Lifecycle Hub • Core Client Application Script
 * Powered by Tailwind CSS & Lucide Icons
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
  updateGlobalSidebarCounters();
  fetchUserMasterList();
  populateDepartmentDropdowns();
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
    if (currentUser.role === 'admin') {
      roleEl.className = 'inline-block text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30';
    } else if (currentUser.role === 'technician') {
      roleEl.className = 'inline-block text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30';
    } else {
      roleEl.className = 'inline-block text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
    }
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

  lucide.createIcons();
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
  }, 250);
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
// 1.1 GLOBAL SIDEBAR BADGE SYNCHRONIZATION
// ==========================================

async function updateGlobalSidebarCounters() {
  try {
    const res = await apiFetch('/api/dashboard/stats');
    if (!res.ok) return;
    const data = await res.json();

    const assetBadge = document.getElementById('sidebar-asset-count');
    if (assetBadge) {
      assetBadge.textContent = data.assets?.total ?? 0;
    }

    const repairBadge = document.getElementById('sidebar-repair-count');
    if (repairBadge) {
      repairBadge.textContent = data.repairs?.open_tickets ?? 0;
    }

    const keyBadge = document.getElementById('sidebar-key-count');
    if (keyBadge) {
      keyBadge.textContent = data.keys?.total ?? 0;
    }

    const accBadge = document.getElementById('sidebar-acc-count');
    if (accBadge) {
      accBadge.textContent = data.accessories?.total ?? 0;
    }

    const userMasterBadge = document.getElementById('sidebar-user-master-count');
    if (userMasterBadge) {
      userMasterBadge.textContent = data.employees?.total ?? 0;
    }

    const deptBadge = document.getElementById('sidebar-dept-count');
    if (deptBadge) {
      deptBadge.textContent = data.departments?.total ?? 0;
    }

    const expBadge = document.getElementById('sidebar-expense-total');
    if (expBadge) {
      const totalRepairCost = data.repairs?.total_cost || 0;
      expBadge.textContent = totalRepairCost >= 1000 ? `₹${(totalRepairCost / 1000).toFixed(1)}k` : `₹${totalRepairCost}`;
    }
  } catch (err) {
    console.debug('Sidebar counters sync error:', err);
  }
}

// ==========================================
// 2. ROUTING & VIEW NAVIGATION
// ==========================================

let isProgrammaticNav = false;

function resetAssetFilterUI(overrides = {}) {
  const s = document.getElementById('asset-filter-search');
  const t = document.getElementById('asset-filter-type');
  const d = document.getElementById('asset-filter-dept');
  const st = document.getElementById('asset-filter-status');
  const k = document.getElementById('asset-filter-key');
  const p = document.getElementById('asset-filter-printer');
  if (s) s.value = overrides.search || '';
  if (t) t.value = overrides.type || '';
  if (d) d.value = overrides.department || '';
  if (st) st.value = overrides.status || '';
  if (k) k.value = overrides.quick_heal || '';
  if (p) p.value = overrides.has_printer || '';
}

function resetEmployeeFilterUI(overrides = {}) {
  const s = document.getElementById('employee-search-input');
  const d = document.getElementById('employee-filter-dept');
  const p = document.getElementById('employee-filter-printer');
  if (s) s.value = overrides.search || '';
  if (d) d.value = overrides.department || 'all';
  if (p) p.value = overrides.has_printer || 'all';
}

function resetRepairFilterUI(overrides = {}) {
  const s = document.getElementById('repair-filter-search');
  const st = document.getElementById('repair-filter-status');
  const fromEl = document.getElementById('repair-filter-date-from');
  const toEl = document.getElementById('repair-filter-date-to');
  if (s) s.value = overrides.search || '';
  if (st) st.value = overrides.status || '';
  if (fromEl) fromEl.value = overrides.date_from || '';
  if (toEl) toEl.value = overrides.date_to || '';
  if (typeof filterRepairTab === 'function') {
    filterRepairTab(overrides.ticket_status || 'all', false);
  }
}

function resetKeyFilterUI(overrides = {}) {
  const s = document.getElementById('key-filter-search');
  const st = document.getElementById('key-filter-status');
  if (s) s.value = overrides.search || '';
  if (st) st.value = overrides.status || '';
}

function resetAccessoryFilterUI(overrides = {}) {
  const s = document.getElementById('acc-filter-search');
  const c = document.getElementById('acc-filter-cat');
  const st = document.getElementById('acc-filter-status');
  if (s) s.value = overrides.search || '';
  if (c) c.value = overrides.category || '';
  if (st) st.value = overrides.status || '';
}

function resetSearchUI(overrides = {}) {
  const inp = document.getElementById('dedicated-search-input');
  if (inp) inp.value = overrides.q || '';
  const container = document.getElementById('master-search-results-container');
  if (container && !overrides.q) {
    container.innerHTML = `
      <div class="text-center py-12 text-slate-400">
        <p class="text-xs">Type a keyword above to search all modules.</p>
      </div>
    `;
  }
}

function handleRoute() {
  if (isProgrammaticNav) return;
  const hash = window.location.hash.replace('#', '') || 'dashboard';
  navigate(hash, {}, false);
}

window.addEventListener('hashchange', handleRoute);

function navigate(viewName, params = {}, updateHash = true) {
  currentView = viewName;
  if (updateHash) {
    isProgrammaticNav = true;
    window.location.hash = viewName;
    setTimeout(() => {
      isProgrammaticNav = false;
    }, 100);
  }

  // Update Nav links
  document.querySelectorAll('.nav-btn').forEach(link => {
    const isActive = link.dataset.view === viewName;
    link.classList.toggle('active', isActive);
    if (isActive) {
      link.className = 'nav-btn active flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold cursor-pointer transition-all duration-150';
    } else {
      link.className = 'nav-btn flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold cursor-pointer text-slate-400 hover:text-white hover:bg-slate-900 transition-all duration-150';
    }
  });

  // Switch View Panels
  document.querySelectorAll('.view-panel').forEach(view => {
    view.classList.add('hidden');
    view.classList.remove('active');
  });

  const activeViewEl = document.getElementById(`view-${viewName}`);
  if (activeViewEl) {
    activeViewEl.classList.remove('hidden');
    activeViewEl.classList.add('active');
  }

  // Close mobile sidebar if open
  closeSidebar();

  // Keep sidebar badges synchronized across all views
  updateGlobalSidebarCounters();

  // Trigger view data loaders with fresh resets or explicit params
  switch (viewName) {
    case 'dashboard':
      loadDashboard();
      break;
    case 'assets':
      resetAssetFilterUI(params);
      loadAssets(params);
      break;
    case 'repairs':
      resetRepairFilterUI(params);
      loadRepairs(params);
      break;
    case 'keys':
      resetKeyFilterUI(params);
      loadKeys(params);
      break;
    case 'accessories':
      resetAccessoryFilterUI(params);
      loadAccessories(params);
      break;
    case 'expenses':
      resetExpensesFilterUI(params);
      loadExpenses(params);
      break;
    case 'employees':
      resetEmployeeFilterUI(params);
      loadEmployees(params);
      break;
    case 'departments':
      resetDepartmentFilterUI(params);
      loadDepartments(params);
      break;
    case 'search':
      resetSearchUI(params);
      if (params.q) {
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

  setTimeout(() => lucide.createIcons(), 50);
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  sidebar.classList.toggle('-translate-x-full');
  backdrop.classList.toggle('hidden');
}

function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (sidebar) sidebar.classList.add('-translate-x-full');
  if (backdrop) backdrop.classList.add('hidden');
}

// ==========================================
// 3. TOAST NOTIFICATIONS & MODALS
// ==========================================

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast-item pointer-events-auto flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-xl text-xs font-semibold text-white transition-all';

  if (type === 'success') {
    toast.classList.add('bg-emerald-600');
    toast.innerHTML = `<i data-lucide="check-circle" class="w-4 h-4 text-emerald-200"></i><span>${escapeHtml(message)}</span>`;
  } else if (type === 'error') {
    toast.classList.add('bg-rose-600');
    toast.innerHTML = `<i data-lucide="alert-circle" class="w-4 h-4 text-rose-200"></i><span>${escapeHtml(message)}</span>`;
  } else {
    toast.classList.add('bg-slate-900');
    toast.innerHTML = `<i data-lucide="info" class="w-4 h-4 text-sky-400"></i><span>${escapeHtml(message)}</span>`;
  }

  container.appendChild(toast);
  lucide.createIcons();

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('hidden');
    modal.scrollTop = 0;
    const scrollContainers = modal.querySelectorAll('.overflow-y-auto, [id$="-body"]');
    scrollContainers.forEach(c => { c.scrollTop = 0; });
    const firstInput = modal.querySelector('input:not([type=hidden]), select, textarea');
    if (firstInput) {
      setTimeout(() => {
        try {
          firstInput.focus({ preventScroll: true });
        } catch (e) {
          firstInput.focus();
        }
      }, 60);
    }
    lucide.createIcons();
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('hidden');
  }
}

function setupGlobalEvents() {
  // Close modals on backdrop click
  document.querySelectorAll('.fixed.inset-0.z-50').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal(modal.id);
      }
    });
  });

  // Dynamically toggle Quick Heal key selector when asset type changes
  const assetTypeEl = document.getElementById('asset-type');
  if (assetTypeEl) {
    assetTypeEl.addEventListener('change', updateAssetKeyFieldVisibility);
  }

  // Hotkey listener: Ctrl+K or / opens Master Search; Escape closes modals
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openMasterSearchModal();
    } else if (e.key === 'Escape') {
      document.querySelectorAll('.fixed.inset-0.z-50:not(.hidden)').forEach(m => closeModal(m.id));
    }
  });

  // Bulk import drag-and-drop listeners
  const dropzone = document.getElementById('dropzone-bulk-import');
  if (dropzone) {
    ['dragenter', 'dragover'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add('border-brand-500', 'bg-brand-50/30');
      });
    });
    ['dragleave', 'drop'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('border-brand-500', 'bg-brand-50/30');
      });
    });
    dropzone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length > 0) {
        handleBulkFileSelect({ target: { files: dt.files } });
      }
    });
  }
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

    // KPI Numbers
    const totalAssets = data.assets?.total || 0;
    const workingAssets = data.assets?.working || 0;
    const repairAssets = data.assets?.in_repair || 0;
    const openTickets = data.repairs?.open_tickets || 0;
    const eolAssets = (data.assets?.not_working || 0) + (data.assets?.retired || 0);
    const totalKeys = data.keys?.total || 0;
    const availKeys = data.keys?.available || 0;
    const assignedKeys = data.keys?.assigned || 0;
    const totalAcc = data.accessories?.total || 0;
    const totalRepairCost = data.repairs?.total_cost || 0;

    document.getElementById('kpi-total-assets').textContent = totalAssets;
    document.getElementById('sidebar-asset-count').textContent = totalAssets;

    document.getElementById('kpi-working-assets').textContent = workingAssets;
    const workingPct = totalAssets > 0 ? Math.round((workingAssets / totalAssets) * 100) : 100;
    const workingSubEl = document.querySelector('#kpi-working-assets + p');
    if (workingSubEl) {
      workingSubEl.textContent = totalAssets > 0 ? `${workingPct}% fleet healthy` : '100% fleet healthy';
    }

    document.getElementById('kpi-repair-assets').textContent = repairAssets;
    const repairSubEl = document.querySelector('#kpi-repair-assets + p');
    if (repairSubEl) {
      repairSubEl.textContent = `${openTickets} active ticket${openTickets === 1 ? '' : 's'}`;
    }
    document.getElementById('sidebar-repair-count').textContent = openTickets;

    document.getElementById('kpi-eol-assets').textContent = eolAssets;
    const eolSubEl = document.querySelector('#kpi-eol-assets + p');
    if (eolSubEl) {
      eolSubEl.textContent = eolAssets > 0 ? `${eolAssets} requires review` : 'No defective units';
    }

    document.getElementById('kpi-total-keys').textContent = totalKeys;
    document.getElementById('sidebar-key-count').textContent = totalKeys;
    document.getElementById('kpi-keys-sub').textContent = `${availKeys} available / ${assignedKeys} assigned`;

    const accBadge = document.getElementById('sidebar-acc-count');
    if (accBadge) {
      accBadge.textContent = totalAcc;
    }

    const userMasterBadge = document.getElementById('sidebar-user-master-count');
    if (userMasterBadge && data.employees) {
      userMasterBadge.textContent = data.employees.total ?? 0;
    }

    document.getElementById('kpi-repair-cost').textContent = `₹${totalRepairCost.toLocaleString('en-IN')}`;
    const expBadge = document.getElementById('sidebar-expense-total');
    if (expBadge) {
      expBadge.textContent = totalRepairCost >= 1000 ? `₹${(totalRepairCost / 1000).toFixed(1)}k` : `₹${totalRepairCost}`;
    }

    // Security Alert Banner for Unprotected Laptops / Desktops
    const secBanner = document.getElementById('sec-alert-banner');
    const secCountEl = document.getElementById('sec-alert-count');
    if (secBanner && secCountEl) {
      const unprot = data.unprotectedWorkstations || 0;
      secCountEl.textContent = unprot;
      if (unprot > 0) {
        secBanner.classList.remove('hidden');
      } else {
        secBanner.classList.add('hidden');
      }
    }

    // Render Department Breakdown
    const deptContainer = document.getElementById('dept-breakdown-container');
    deptContainer.innerHTML = '';
    const deptCountHeader = deptContainer?.previousElementSibling?.querySelector('span');
    if (deptCountHeader) {
      deptCountHeader.textContent = `${(data.deptBreakdown || []).length} Departments`;
    }
    if (!data.deptBreakdown || data.deptBreakdown.length === 0) {
      deptContainer.innerHTML = `<div class="py-6 text-center text-slate-400 text-xs">No assets recorded in departments yet.</div>`;
    } else {
      const maxDept = data.deptBreakdown[0]?.count || 1;
      data.deptBreakdown.forEach(item => {
        const pct = Math.round((item.count / maxDept) * 100);
        const row = document.createElement('div');
        row.className = 'cursor-pointer hover:bg-slate-50 p-2 rounded-xl transition-colors';
        row.onclick = () => navigate('assets', { department: item.department });
        row.innerHTML = `
          <div class="flex items-center justify-between text-xs font-semibold text-slate-700 mb-1">
            <span>${escapeHtml(item.department)}</span>
            <span class="text-brand-600 font-bold">${item.count} units</span>
          </div>
          <div class="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
            <div class="h-full bg-gradient-to-r from-brand-600 to-indigo-500 rounded-full" style="width: ${pct}%"></div>
          </div>
        `;
        deptContainer.appendChild(row);
      });
    }

    // Render System Types Breakdown
    const typeContainer = document.getElementById('type-breakdown-container');
    typeContainer.innerHTML = '';
    if (!data.typeBreakdown || data.typeBreakdown.length === 0) {
      typeContainer.innerHTML = `<div class="py-6 text-center text-slate-400 text-xs">No hardware types recorded yet.</div>`;
    } else {
      data.typeBreakdown.forEach(item => {
        const tag = document.createElement('div');
        tag.className = 'flex items-center justify-between p-2.5 rounded-xl bg-slate-50 hover:bg-slate-100 border border-slate-100 cursor-pointer text-xs font-semibold text-slate-700 transition-colors';
        tag.onclick = () => navigate('assets', { type: item.asset_type });
        tag.innerHTML = `
          <div class="flex items-center gap-2">
            <i data-lucide="monitor" class="w-3.5 h-3.5 text-indigo-500"></i>
            <span>${escapeHtml(item.asset_type)}</span>
          </div>
          <span class="px-2 py-0.5 rounded-md bg-indigo-100 text-indigo-800 text-[11px] font-bold">${item.count}</span>
        `;
        typeContainer.appendChild(tag);
      });
    }

    // Render Recent Repairs
    const repairsTbody = document.getElementById('dashboard-recent-repairs');
    repairsTbody.innerHTML = '';
    if (data.recentRepairs.length === 0) {
      repairsTbody.innerHTML = `<tr><td colspan="6" class="py-6 text-center text-slate-400">No recent maintenance tickets.</td></tr>`;
    } else {
      data.recentRepairs.forEach(r => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-50/80 cursor-pointer transition-colors';
        tr.onclick = () => navigate('repairs', { search: r.ticket_number });
        tr.innerHTML = `
          <td class="py-2.5 px-3 font-mono font-bold text-brand-600">${escapeHtml(r.ticket_number)}</td>
          <td class="py-2.5 px-3 font-mono font-semibold text-slate-800">#${escapeHtml(r.internal_serial_number)}</td>
          <td class="py-2.5 px-3 text-slate-600 max-w-xs truncate">${escapeHtml(r.issue_description)}</td>
          <td class="py-2.5 px-3 text-slate-500">${escapeHtml(r.repair_vendor || r.technician_name || 'In-House')}</td>
          <td class="py-2.5 px-3 font-semibold text-slate-900">₹${(r.repair_cost || 0).toLocaleString('en-IN')}</td>
          <td class="py-2.5 px-3">
            <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">${escapeHtml(r.status)}</span>
          </td>
        `;
        repairsTbody.appendChild(tr);
      });
    }

    // Render EOL Warnings
    const eolContainer = document.getElementById('dashboard-eol-warnings');
    eolContainer.innerHTML = '';
    if (data.eolWarnings.length === 0) {
      eolContainer.innerHTML = `<div class="p-4 text-center text-xs text-slate-400">All registered devices are operating normally.</div>`;
    } else {
      data.eolWarnings.forEach(w => {
        const item = document.createElement('div');
        item.className = 'p-3 rounded-xl bg-rose-50/60 border border-rose-100 cursor-pointer hover:bg-rose-50 transition-colors';
        item.onclick = () => viewAssetDetail(w.id);
        item.innerHTML = `
          <div class="flex items-center justify-between">
            <span class="font-bold text-xs text-slate-900">#${escapeHtml(w.internal_serial_number)} • ${escapeHtml(w.brand)} ${escapeHtml(w.asset_type)}</span>
            <span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-rose-100 text-rose-700">${escapeHtml(w.working_status)}</span>
          </div>
          <p class="text-[11px] text-slate-600 mt-1">User: <strong>${escapeHtml(w.assigned_user || 'Unassigned')}</strong> • ${escapeHtml(w.department || '')}</p>
          <div class="text-[10px] text-rose-600 font-semibold mt-1">Repairs: ${w.repair_count} tickets • Total spend: ₹${(w.total_repair_spent || 0).toLocaleString('en-IN')}</div>
        `;
        eolContainer.appendChild(item);
      });
    }

    lucide.createIcons();
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
  assetSearchTimeout = setTimeout(() => loadAssets(), 250);
}

function resetAssetFilters() {
  document.getElementById('asset-filter-search').value = '';
  document.getElementById('asset-filter-type').value = '';
  document.getElementById('asset-filter-dept').value = '';
  document.getElementById('asset-filter-status').value = '';
  document.getElementById('asset-filter-key').value = '';
  if (document.getElementById('asset-filter-printer')) document.getElementById('asset-filter-printer').value = '';
  loadAssets();
}

async function loadAssets(filterParams = {}) {
  try {
    const search = filterParams.search !== undefined ? filterParams.search : document.getElementById('asset-filter-search')?.value || '';
    const type = filterParams.type !== undefined ? filterParams.type : document.getElementById('asset-filter-type')?.value || '';
    const dept = filterParams.department !== undefined ? filterParams.department : document.getElementById('asset-filter-dept')?.value || '';
    const status = filterParams.status !== undefined ? filterParams.status : document.getElementById('asset-filter-status')?.value || '';
    const key = filterParams.quick_heal !== undefined ? filterParams.quick_heal : document.getElementById('asset-filter-key')?.value || '';
    const printer = filterParams.has_printer !== undefined ? filterParams.has_printer : document.getElementById('asset-filter-printer')?.value || '';

    if (filterParams.search && document.getElementById('asset-filter-search')) document.getElementById('asset-filter-search').value = filterParams.search;
    if (filterParams.type && document.getElementById('asset-filter-type')) document.getElementById('asset-filter-type').value = filterParams.type;
    if (filterParams.department && document.getElementById('asset-filter-dept')) document.getElementById('asset-filter-dept').value = filterParams.department;
    if (filterParams.status && document.getElementById('asset-filter-status')) document.getElementById('asset-filter-status').value = filterParams.status;
    if (filterParams.quick_heal && document.getElementById('asset-filter-key')) document.getElementById('asset-filter-key').value = filterParams.quick_heal;
    if (filterParams.has_printer && document.getElementById('asset-filter-printer')) document.getElementById('asset-filter-printer').value = filterParams.has_printer;

    const params = new URLSearchParams();
    if (search) params.append('search', search);
    if (type) params.append('type', type);
    if (dept) params.append('department', dept);
    if (status) params.append('status', status);
    if (key) params.append('quick_heal', key);
    if (printer) params.append('has_printer', printer);

    const res = await apiFetch(`/api/assets?${params.toString()}`);
    if (!res.ok) return;
    const data = await res.json();
    cachedAssets = data.assets;
    window._allAssetsList = data.assets;

    const tbody = document.getElementById('assets-table-body');
    tbody.innerHTML = '';

    document.getElementById('assets-count-label').textContent = `Showing ${data.total} assets`;
    if (!search && !type && !dept && !status && !key) {
      const assetBadge = document.getElementById('sidebar-asset-count');
      if (assetBadge) assetBadge.textContent = data.total;
    }

    if (data.assets.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" class="py-12 text-center text-slate-400">No IT assets match the current filter.</td></tr>`;
      return;
    }

    data.assets.forEach(a => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-50/80 transition-colors';

      // Status pill
      let statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Working</span>`;
      if (a.working_status === 'In Repair') {
        statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">In Repair</span>`;
      } else if (a.working_status === 'Not Working') {
        statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">Not Working</span>`;
      } else if (a.working_status === 'Retired') {
        statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-200">Retired</span>`;
      }

      // Quick Heal pill (Laptops & Desktops strictly prioritized; non-workstations show clean dash)
      const isWorkstation = ['laptop', 'desktop'].includes(String(a.asset_type || '').toLowerCase());
      let keyBadge = `<span class="text-slate-300 text-xs font-normal" title="Antivirus only applies to Laptops & Desktops">—</span>`;

      if (isWorkstation) {
        if (a.quick_heal_key_str) {
          keyBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-purple-50 text-purple-700 border border-purple-200" title="License: ${escapeHtml(a.quick_heal_key_str)}">
          <i data-lucide="shield-check" class="w-3 h-3 text-purple-600"></i>
          <span>Mapped</span>
        </span>`;
        } else {
          keyBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-rose-50 text-rose-700 border border-rose-200/90 shadow-xs" title="Antivirus key not assigned to this ${escapeHtml(a.asset_type)}">
          <i data-lucide="shield-alert" class="w-3 h-3 text-rose-500"></i>
          <span>Unprotected</span>
        </span>`;
        }
      }

      // Health badge
      let healthBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold bg-emerald-50 text-emerald-700">Healthy</span>`;
      if (a.healthClass === 'danger') {
        healthBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200" title="${escapeHtml(a.eolReason)}"><i data-lucide="alert-triangle" class="w-3 h-3"></i><span>${escapeHtml(a.healthScore)}</span></span>`;
      } else if (a.healthClass === 'warning') {
        healthBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200" title="${escapeHtml(a.eolReason)}"><i data-lucide="zap" class="w-3 h-3"></i><span>${escapeHtml(a.healthScore)}</span></span>`;
      }

      const isViewer = currentUser?.role === 'viewer';
      const isAdmin = currentUser?.role === 'admin';

      tr.innerHTML = `
        <td class="py-3 px-4 font-mono font-bold text-brand-600">#${escapeHtml(a.internal_serial_number)}</td>
        <td class="py-3 px-4 font-semibold text-slate-800">${escapeHtml(a.asset_type)}</td>
        <td class="py-3 px-4">
          <div class="font-bold text-slate-900">${escapeHtml(a.brand || '')}</div>
          <div class="text-[11px] text-slate-400">${escapeHtml(a.model_name || 'Standard Model')}</div>
        </td>
        <td class="py-3 px-4 text-slate-600 font-medium">${escapeHtml(a.department || '—')}</td>
        <td class="py-3 px-4 text-slate-500 text-[11px]">${escapeHtml(a.location || '—')}</td>
        <td class="py-3 px-4 font-semibold text-slate-800">
          <div>${escapeHtml(a.assigned_user || 'Unassigned')}</div>
          ${a.has_printer ? `
            <div class="mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-200/60" title="Printer: ${escapeHtml(a.primary_printer || 'Assigned')}">
              <i data-lucide="printer" class="w-2.5 h-2.5 text-amber-600"></i>
              <span>${escapeHtml(a.primary_printer || 'Printer')}</span>
            </div>
          ` : (isWorkstation && a.assigned_user && !['unassigned', 'free'].includes(a.assigned_user.toLowerCase()) ? `
            <div class="mt-0.5 inline-flex items-center gap-1 text-[10px] text-slate-400 font-medium" title="No printer assigned to this user">
              <span>(No Printer)</span>
            </div>
          ` : '')}
        </td>
        <td class="py-3 px-4">${keyBadge}</td>
        <td class="py-3 px-4">${statusBadge}</td>
        <td class="py-3 px-4">${healthBadge}</td>
        <td class="py-3 px-4 text-right">
          <div class="flex items-center justify-end gap-1">
            <button onclick="viewAssetDetail(${a.id})" title="View Dossier" class="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-slate-100 rounded-lg transition-colors">
              <i data-lucide="eye" class="w-4 h-4"></i>
            </button>
            ${!isViewer ? `
              <button onclick="openEditAssetModal(${a.id})" title="Edit Details" class="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-slate-100 rounded-lg transition-colors">
                <i data-lucide="pencil" class="w-4 h-4"></i>
              </button>
              <button onclick="openRepairModal(${a.id})" title="Log Repair" class="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-slate-100 rounded-lg transition-colors">
                <i data-lucide="wrench" class="w-4 h-4"></i>
              </button>
            ` : ''}
            ${isAdmin ? `
              <button onclick="deleteAsset(${a.id}, '${escapeHtml(a.internal_serial_number)}')" title="Delete Asset" class="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
            ` : ''}
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    lucide.createIcons();
  } catch (err) {
    console.error('Assets load error:', err);
  }
}

// Open Asset Detail Dossier Modal
async function viewAssetDetail(assetId) {
  try {
    const res = await apiFetch(`/api/assets/${assetId}`);
    if (!res.ok) return;
    const { asset } = await res.json();

    document.getElementById('dossier-header-title').textContent = `Asset Dossier: #${asset.internal_serial_number} (${asset.brand} ${asset.asset_type})`;

    const btnRepair = document.getElementById('dossier-btn-repair');
    const btnEdit = document.getElementById('dossier-btn-edit');

    if (btnRepair) btnRepair.onclick = () => { closeModal('modal-asset-detail'); openRepairModal(asset.id); };
    if (btnEdit) btnEdit.onclick = () => { closeModal('modal-asset-detail'); openEditAssetModal(asset.id); };

    // Format Repairs Timeline
    let repairsHtml = '';
    if (asset.repairs && asset.repairs.length > 0) {
      repairsHtml = `
        <div class="mt-6 border-t border-slate-100 pt-5">
          <h4 class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">🛠️ Maintenance & Repair History (${asset.repairs.length} records • Total ₹${asset.total_repair_cost.toLocaleString('en-IN')})</h4>
          <div class="overflow-x-auto border border-slate-200 rounded-xl">
            <table class="w-full text-left text-xs">
              <thead class="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase font-semibold">
                <tr>
                  <th class="py-2.5 px-3">Ticket</th>
                  <th class="py-2.5 px-3">Date</th>
                  <th class="py-2.5 px-3">Issue Description</th>
                  <th class="py-2.5 px-3">Parts Replaced</th>
                  <th class="py-2.5 px-3">Vendor / Tech</th>
                  <th class="py-2.5 px-3">Cost</th>
                  <th class="py-2.5 px-3">Status</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                ${asset.repairs.map(r => `
                  <tr class="hover:bg-slate-50">
                    <td class="py-2 px-3 font-mono font-bold text-brand-600">${escapeHtml(r.ticket_number)}</td>
                    <td class="py-2 px-3 text-slate-500">${escapeHtml(r.repair_date)}</td>
                    <td class="py-2 px-3 font-medium text-slate-800">${escapeHtml(r.issue_description)}</td>
                    <td class="py-2 px-3 font-semibold text-sky-600">${escapeHtml(r.parts_added || 'None')}</td>
                    <td class="py-2 px-3 text-slate-500">${escapeHtml(r.repair_vendor || r.technician_name || 'In-House')}</td>
                    <td class="py-2 px-3 font-bold text-slate-900">₹${(r.repair_cost || 0).toLocaleString('en-IN')}</td>
                    <td class="py-2 px-3"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">${escapeHtml(r.status)}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
    } else {
      repairsHtml = `<div class="mt-4 p-4 rounded-xl bg-slate-50 border border-slate-200/80 text-xs text-slate-500 text-center">✨ No maintenance tickets logged for this asset. Machine has standard factory components.</div>`;
    }

    const body = document.getElementById('dossier-body');
    body.innerHTML = `
      <!-- Hero Banner -->
      <div class="p-6 rounded-2xl bg-gradient-to-r from-slate-900 via-slate-850 to-indigo-950 text-white flex items-center justify-between shadow-lg">
        <div>
          <div class="flex items-center gap-3">
            <h2 class="text-2xl font-black font-mono tracking-wide text-white">#${escapeHtml(asset.internal_serial_number)}</h2>
            <span class="px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${asset.working_status === 'Working' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'}">
              ${escapeHtml(asset.working_status)}
            </span>
          </div>
          <p class="text-sm font-semibold text-slate-300 mt-1">${escapeHtml(asset.brand)} ${escapeHtml(asset.asset_type)} • Assigned to <strong class="text-white">${escapeHtml(asset.assigned_user || 'Unassigned')}</strong></p>
          <div class="text-xs text-slate-400 mt-0.5">Department: ${escapeHtml(asset.department || 'General')} • Location: ${escapeHtml(asset.location || 'Head Office')}</div>
        </div>
        <div class="hidden sm:block text-right">
          <div class="text-[10px] font-bold uppercase tracking-widest text-slate-400">Lifecycle Status</div>
          <div class="text-sm font-bold text-indigo-300 mt-0.5">${escapeHtml(asset.healthScore)}</div>
        </div>
      </div>

      <!-- Lifecycle Evaluation Banner -->
      <div class="p-4 rounded-2xl border ${asset.healthClass === 'danger' ? 'bg-rose-50/80 border-rose-200 text-rose-800' : asset.healthClass === 'warning' ? 'bg-amber-50/80 border-amber-200 text-amber-800' : 'bg-emerald-50/80 border-emerald-200 text-emerald-800'} flex items-center gap-3">
        <div class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${asset.healthClass === 'danger' ? 'bg-rose-100 text-rose-600' : asset.healthClass === 'warning' ? 'bg-amber-100 text-amber-600' : 'bg-emerald-100 text-emerald-600'}">
          <i data-lucide="${asset.healthClass === 'danger' ? 'alert-octagon' : asset.healthClass === 'warning' ? 'zap' : 'shield-check'}" class="w-5 h-5"></i>
        </div>
        <div>
          <h4 class="text-xs font-bold uppercase tracking-wider">Lifecycle Intelligence Assessment: ${escapeHtml(asset.healthScore)}</h4>
          <p class="text-xs mt-0.5 font-medium">${escapeHtml(asset.eolReason)}</p>
        </div>
      </div>

      <!-- Technical Specifications Grid -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
          <span class="text-[10px] uppercase font-bold text-slate-400 block mb-1">Brand & Model</span>
          <strong class="text-slate-800 font-bold">${escapeHtml(asset.brand || '')} ${escapeHtml(asset.model_name || '')}</strong>
        </div>
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
          <span class="text-[10px] uppercase font-bold text-slate-400 block mb-1">Hardware Serial</span>
          <strong class="text-slate-800 font-mono font-semibold">${escapeHtml(asset.serial_number || 'N/A')}</strong>
        </div>
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
          <span class="text-[10px] uppercase font-bold text-slate-400 block mb-1">Operational Age</span>
          <strong class="text-slate-800 font-semibold">${escapeHtml(asset.ageString)}</strong>
        </div>
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
          <span class="text-[10px] uppercase font-bold text-slate-400 block mb-1">Purchase Date</span>
          <strong class="text-slate-800 font-semibold">${escapeHtml(asset.purchase_date || 'Standard Setup')}</strong>
        </div>
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
          <span class="text-[10px] uppercase font-bold text-slate-400 block mb-1">Procured From</span>
          <strong class="text-slate-800 font-semibold">${escapeHtml(asset.purchase_vendor || 'IT Vendor')}</strong>
        </div>
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
          <span class="text-[10px] uppercase font-bold text-slate-400 block mb-1">Procurement Cost</span>
          <strong class="text-slate-800 font-semibold">₹${(asset.purchase_cost || 0).toLocaleString('en-IN')}</strong>
        </div>
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
          <span class="text-[10px] uppercase font-bold text-slate-400 block mb-1">Total Maintenance Spend</span>
          <strong class="text-brand-600 font-bold">₹${(asset.total_repair_cost || 0).toLocaleString('en-IN')}</strong>
        </div>
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200/80">
          <span class="text-[10px] uppercase font-bold text-slate-400 block mb-1">Condition Rating</span>
          <strong class="text-slate-800 font-semibold">${escapeHtml(asset.condition_rating || 'Good')}</strong>
        </div>
      </div>

      <!-- Quick Heal License Card: Strictly for Desktops and Laptops ONLY -->
      ${['desktop', 'laptop'].includes(String(asset.asset_type || '').trim().toLowerCase()) ? `
      <div class="p-4 rounded-2xl bg-purple-50/70 border border-purple-200/80 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-purple-600 text-white flex items-center justify-center shadow-sm">
            <i data-lucide="shield-check" class="w-5 h-5"></i>
          </div>
          <div>
            <div class="text-[10px] font-bold uppercase tracking-wider text-purple-700">Quick Heal Antivirus Protection</div>
            <div class="font-mono font-bold text-sm text-purple-900 mt-0.5">${escapeHtml(asset.quick_heal_key_str || 'No Antivirus Key Mapped')}</div>
            ${asset.quick_heal_validity ? `<div class="text-[11px] text-purple-600 mt-0.5">License valid until: <strong>${escapeHtml(asset.quick_heal_validity)}</strong></div>` : ''}
          </div>
        </div>
        ${!asset.quick_heal_key_str ? `
          <button onclick="closeModal('modal-asset-detail'); openMapKeyModalForAsset(${asset.id});" class="tech-action px-3 py-1.5 rounded-xl text-xs font-semibold text-white bg-purple-600 hover:bg-purple-500 shadow-sm cursor-pointer">
            Assign Key
          </button>
        ` : ''}
      </div>
      ` : ''}

      <!-- Parts Added Ledger -->
      <div class="p-4 rounded-2xl bg-sky-50/60 border border-sky-200/80">
        <span class="text-[10px] font-bold uppercase tracking-wider text-sky-700">🧩 Installed Upgrades & Added Parts Ledger:</span>
        <div class="text-xs font-semibold text-slate-800 mt-1">
          ${escapeHtml(asset.parts_added_summary || 'No secondary components installed. Machine has standard factory components.')}
        </div>
      </div>

      <!-- Operational Remarks -->
      <div class="p-4 rounded-2xl bg-slate-50 border border-slate-200/80">
        <span class="text-[10px] font-bold uppercase tracking-wider text-slate-500">📝 Operational Notes & Usage:</span>
        <p class="text-xs text-slate-700 mt-1 font-medium leading-relaxed">${escapeHtml(asset.remarks || 'No usage notes recorded.')}</p>
      </div>

      <!-- Linked Printers & Hardware Breakdown -->
      ${(() => {
        const isPrinter = ['normal printer', 'tag printer', 'label printer', 'scanner'].includes(String(asset.asset_type || '').toLowerCase()) || String(asset.asset_type || '').toLowerCase().includes('printer');
        const userStr = escapeHtml(asset.assigned_user || 'this user');

        if (isPrinter) {
          const ws = asset.linked_workstations || [];
          return `
            <div class="p-4 rounded-2xl bg-amber-50/70 border border-amber-200/90">
              <div class="flex items-center justify-between mb-3">
                <div class="flex items-center gap-2">
                  <div class="w-8 h-8 rounded-xl bg-amber-600 text-white flex items-center justify-center shadow-sm">
                    <i data-lucide="monitor" class="w-4 h-4"></i>
                  </div>
                  <div>
                    <h4 class="text-xs font-bold uppercase tracking-wider text-amber-950">Linked User Workstation (${ws.length})</h4>
                    <p class="text-[11px] text-amber-800">Desktops/Laptops operated by <strong>${userStr}</strong></p>
                  </div>
                </div>
              </div>
              ${ws.length > 0 ? `
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  ${ws.map(w => `
                    <div class="p-3 rounded-xl bg-white border border-amber-100 shadow-sm flex items-center justify-between">
                      <div>
                        <div class="flex items-center gap-1.5">
                          <span class="font-mono font-bold text-brand-600 text-xs cursor-pointer hover:underline" onclick="closeModal('modal-asset-detail'); viewAssetDetail(${w.id});">#${escapeHtml(w.internal_serial_number)}</span>
                          <span class="font-bold text-xs text-slate-900">${escapeHtml(w.brand || '')} ${escapeHtml(w.model_name || w.asset_type)}</span>
                        </div>
                        <div class="text-[11px] text-slate-500 mt-0.5">${escapeHtml(w.asset_type)} • ${escapeHtml(w.location || 'Office Floor')}</div>
                      </div>
                      <button onclick="closeModal('modal-asset-detail'); viewAssetDetail(${w.id});" class="text-xs font-semibold text-amber-700 hover:text-amber-900 underline">
                        View Dossier &rarr;
                      </button>
                    </div>
                  `).join('')}
                </div>
              ` : `
                <div class="p-3 bg-white/70 border border-amber-100 rounded-xl text-center text-xs text-amber-800 font-medium">
                  🖨️ Standalone printer device without dedicated workstation assigned to ${userStr}.
                </div>
              `}
            </div>
          `;
        }

        // For Workstations (Desktop, Laptop, etc)
        const printers = asset.linked_printers || [];
        const hasPrinter = printers.length > 0;

        return `
          <div class="p-4 rounded-2xl ${hasPrinter ? 'bg-amber-50/70 border-amber-200/90' : 'bg-slate-50/80 border-slate-200/80'} border">
            <div class="flex items-center justify-between mb-3">
              <div class="flex items-center gap-2">
                <div class="w-8 h-8 rounded-xl ${hasPrinter ? 'bg-amber-600 text-white' : 'bg-slate-400 text-white'} flex items-center justify-center shadow-sm">
                  <i data-lucide="printer" class="w-4 h-4"></i>
                </div>
                <div>
                  <h4 class="text-xs font-bold uppercase tracking-wider ${hasPrinter ? 'text-amber-950' : 'text-slate-700'}">Linked Printers & Hardware Breakdown (${printers.length})</h4>
                  <p class="text-[11px] ${hasPrinter ? 'text-amber-800' : 'text-slate-500'}">Printers configured for <strong>${userStr}</strong></p>
                </div>
              </div>
              <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold ${hasPrinter ? 'bg-amber-100 text-amber-800 border border-amber-300' : 'bg-slate-100 text-slate-600 border border-slate-200'}">
                <i data-lucide="${hasPrinter ? 'check-circle' : 'info'}" class="w-3 h-3"></i>
                <span>${hasPrinter ? `${printers.length} Printer${printers.length === 1 ? '' : 's'} Linked` : 'No Printer Assigned'}</span>
              </span>
            </div>

            ${hasPrinter ? `
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                ${printers.map(p => `
                  <div class="p-3 rounded-xl bg-white border border-amber-200/80 shadow-sm flex flex-col justify-between hover:border-amber-400 transition-colors">
                    <div>
                      <div class="flex items-center justify-between">
                        <div class="flex items-center gap-1.5">
                          <span class="font-mono font-bold text-brand-600 text-xs cursor-pointer hover:underline" onclick="closeModal('modal-asset-detail'); viewAssetDetail(${p.id});">
                            #${escapeHtml(p.internal_serial_number)}
                          </span>
                          <span class="font-bold text-xs text-slate-900">${escapeHtml(p.brand || '')} ${escapeHtml(p.model_name || '')}</span>
                        </div>
                        <span class="px-2 py-0.5 rounded-md text-[10px] font-bold ${p.working_status === 'Working' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}">
                          ${escapeHtml(p.working_status)}
                        </span>
                      </div>
                      <div class="flex items-center gap-2 mt-1">
                        <span class="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 font-bold text-[10px] border border-amber-300/60">${escapeHtml(p.asset_type)}</span>
                        ${p.serial_number ? `<span class="text-[10px] font-mono text-slate-500">S/N: ${escapeHtml(p.serial_number)}</span>` : ''}
                      </div>
                      ${p.remarks ? `<p class="text-[11px] text-slate-600 mt-1.5 italic line-clamp-2">“${escapeHtml(p.remarks)}”</p>` : ''}
                    </div>
                    <div class="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between text-[11px]">
                      <span class="text-slate-400 text-[10px]">${escapeHtml(p.location || asset.location || 'Same desk')}</span>
                      <button onclick="closeModal('modal-asset-detail'); viewAssetDetail(${p.id});" class="text-xs font-semibold text-amber-700 hover:text-amber-900 underline flex items-center gap-1">
                        View Printer Dossier &rarr;
                      </button>
                    </div>
                  </div>
                `).join('')}
              </div>
            ` : `
              <div class="p-3 bg-white/80 border border-slate-200 rounded-xl flex items-center justify-between gap-3">
                <div class="text-xs text-slate-700">
                  <span class="font-semibold text-slate-800">Standalone Workstation:</span>
                  <span class="text-slate-500 block text-[11px] mt-0.5">${userStr} does not have any dedicated printer (Tag, Label, or Normal printer) assigned.</span>
                </div>
                <button onclick="closeModal('modal-asset-detail'); openNewAssetModalWithPrefill({ asset_type: 'Tag Printer', assigned_user: '${escapeHtml(asset.assigned_user || '')}', department: '${escapeHtml(asset.department || '')}', location: '${escapeHtml(asset.location || '')}' })" class="tech-action px-3 py-1.5 rounded-xl text-xs font-semibold text-amber-800 bg-amber-100 hover:bg-amber-200 flex-shrink-0 transition-colors">
                  + Assign Printer
                </button>
              </div>
            `}
          </div>
        `;
      })()}

      <!-- Issued Accessories & Peripherals for User/Asset -->
      <div class="p-4 rounded-2xl bg-indigo-50/60 border border-indigo-200/80">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <div class="w-8 h-8 rounded-xl bg-indigo-600 text-white flex items-center justify-center shadow-sm">
              <i data-lucide="package" class="w-4 h-4"></i>
            </div>
            <div>
              <h4 class="text-xs font-bold uppercase tracking-wider text-indigo-950">Issued Accessories & Peripherals (${(asset.accessories || []).length})</h4>
              <p class="text-[11px] text-indigo-700">Hardware & peripherals used by <strong>${escapeHtml(asset.assigned_user || 'this device')}</strong></p>
            </div>
          </div>
          <button onclick="closeModal('modal-asset-detail'); navigate('accessories');" class="text-xs font-semibold text-indigo-600 hover:text-indigo-800 underline">
            Accessories Inventory &rarr;
          </button>
        </div>

        ${asset.accessories && asset.accessories.length > 0 ? `
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            ${asset.accessories.map(acc => `
              <div class="p-3 rounded-xl bg-white border border-indigo-100 shadow-sm flex items-center justify-between">
                <div>
                  <div class="flex items-center gap-1.5">
                    <span class="font-mono font-bold text-brand-600 text-xs">${escapeHtml(acc.accessory_code)}</span>
                    <span class="font-bold text-xs text-slate-900">${escapeHtml(acc.name)}</span>
                  </div>
                  <div class="text-[11px] text-slate-500 mt-0.5">${escapeHtml(acc.category)} • ${escapeHtml(acc.brand || 'Standard')} ${escapeHtml(acc.model || '')} (Qty: ${acc.quantity})</div>
                  ${acc.location ? `<div class="text-[10px] text-slate-400 mt-0.5">Location: ${escapeHtml(acc.location)}</div>` : ''}
                </div>
                <span class="px-2 py-0.5 rounded-md text-[10px] font-bold ${acc.status === 'Assigned' ? 'bg-indigo-50 text-indigo-700 border border-indigo-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'}">${escapeHtml(acc.status)}</span>
              </div>
            `).join('')}
          </div>
        ` : `
          <div class="p-3 bg-white/70 border border-indigo-100 rounded-xl text-center text-xs text-indigo-600 font-medium">
            ✨ No accessories or peripherals currently assigned to ${asset.assigned_user ? `<strong>${escapeHtml(asset.assigned_user)}</strong>` : 'this workstation'}.
          </div>
        `}
      </div>

      ${repairsHtml}
    `;

    window.currentDossierAsset = asset;
    openModal('modal-asset-detail');
    const dossierBody = document.getElementById('dossier-body');
    if (dossierBody) {
      dossierBody.scrollTop = 0;
    }
    requestAnimationFrame(() => {
      const db = document.getElementById('dossier-body');
      if (db) db.scrollTop = 0;
      const md = document.getElementById('modal-asset-detail');
      if (md) md.scrollTop = 0;
    });
    lucide.createIcons();
  } catch (err) {
    console.error('Asset detail view error:', err);
  }
}

// Print Asset Physical Tag / Sticker
function printAssetTag() {
  const asset = window.currentDossierAsset;
  if (!asset) return;

  document.getElementById('tag-serial').textContent = asset.internal_serial_number;
  document.getElementById('tag-type-brand').textContent = `${asset.asset_type} - ${asset.brand || ''}`;
  document.getElementById('tag-dept-user').textContent = `Dept: ${asset.department || 'N/A'} • User: ${asset.assigned_user || 'Unassigned'}`;

  openModal('modal-print-tag');
}

// Function to show/hide Quick Heal Antivirus field based on asset type (Desktops & Laptops ONLY)
function updateAssetKeyFieldVisibility() {
  const typeEl = document.getElementById('asset-type');
  const container = document.getElementById('container-asset-key');
  if (!typeEl || !container) return;
  const isWorkstation = ['desktop', 'laptop'].includes((typeEl.value || '').trim().toLowerCase());
  if (isWorkstation) {
    container.classList.remove('hidden');
  } else {
    container.classList.add('hidden');
    const keySelect = document.getElementById('asset-key-select');
    if (keySelect) keySelect.value = '';
  }
}

// Add New Asset Modal
async function openNewAssetModal() {
  document.getElementById('form-asset').reset();
  document.getElementById('asset-form-id').value = '';
  document.getElementById('asset-form-title').textContent = 'Add New IT Asset';
  document.getElementById('asset-serial').value = '';

  try {
    await populateDepartmentDropdowns();
    await populateUserSelect('');
    await populateKeySelector();
    updateAssetKeyFieldVisibility();
    openModal('modal-asset-form');
    lucide.createIcons();
  } catch (err) {
    console.error('Error opening new asset modal:', err);
  }
}

// Open New Asset Modal with prefilled fields
async function openNewAssetModalWithPrefill(prefill = {}) {
  await openNewAssetModal();
  if (prefill.asset_type) document.getElementById('asset-type').value = prefill.asset_type;
  if (prefill.assigned_user) await populateUserSelect(prefill.assigned_user);
  if (prefill.department) {
    await populateDepartmentDropdowns(prefill.department);
    document.getElementById('asset-department').value = prefill.department;
  }
  if (prefill.location) document.getElementById('asset-location').value = prefill.location;
  updateAssetKeyFieldVisibility();
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
    document.getElementById('asset-location').value = asset.location || '';
    document.getElementById('asset-status').value = asset.working_status || 'Working';
    document.getElementById('asset-condition').value = asset.condition_rating || 'Good';
    document.getElementById('asset-parts').value = asset.parts_added_summary || '';
    document.getElementById('asset-remarks').value = asset.remarks || '';

    await populateDepartmentDropdowns(asset.department || 'Orders');
    await populateUserSelect(asset.assigned_user || '');
    await populateKeySelector(asset.quick_heal_key_id);
    updateAssetKeyFieldVisibility();
    openModal('modal-asset-form');
    lucide.createIcons();
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

  const assetType = document.getElementById('asset-type').value;
  const isWorkstation = ['desktop', 'laptop'].includes((assetType || '').trim().toLowerCase());

  const payload = {
    internal_serial_number: document.getElementById('asset-serial').value.trim(),
    asset_type: assetType,
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
    quick_heal_key_id: isWorkstation ? (document.getElementById('asset-key-select').value || null) : null,
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
      fetchUserMasterList();
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

async function deleteAsset(assetId, serial) {
  if (!confirm(`Are you sure you want to permanently delete Asset #${serial}? Linked maintenance tickets will also be deleted.`)) {
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

function openMapKeyModalForAsset(assetId) {
  openEditAssetModal(assetId);
}

// Ensure assets are loaded for dropdowns / comboboxes (independent of search filters)
let allMasterAssets = [];
async function fetchMasterAssets(force = false) {
  if (force || !allMasterAssets || allMasterAssets.length === 0) {
    try {
      const res = await apiFetch('/api/assets');
      if (res.ok) {
        const data = await res.json();
        allMasterAssets = data.assets || [];
        window._allMasterAssets = allMasterAssets;
      }
    } catch (e) {
      console.error('Failed to pre-cache master assets:', e);
    }
  }
  return allMasterAssets;
}

async function ensureAssetsCached() {
  return fetchMasterAssets(false);
}

// Searchable Combobox Component
function initSearchableCombobox({
  containerId,
  inputId,
  dropdownId,
  hiddenInputId,
  clearBtnId,
  previewContainerId,
  previewTextId,
  getAssetsFn,
  filterFn
}) {
  const container = document.getElementById(containerId);
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  const hiddenInput = document.getElementById(hiddenInputId);
  const clearBtn = document.getElementById(clearBtnId);
  const previewContainer = document.getElementById(previewContainerId);
  const previewText = document.getElementById(previewTextId);

  if (!container || !input || !dropdown || !hiddenInput) {
    return { setValue: () => {}, selectAsset: () => {}, openDropdown: () => {} };
  }

  function getAvailableAssets() {
    let list = [];
    if (typeof getAssetsFn === 'function') {
      list = getAssetsFn();
    } else if (window._allMasterAssets && window._allMasterAssets.length > 0) {
      list = window._allMasterAssets;
    } else if (cachedAssets && cachedAssets.length > 0) {
      list = cachedAssets;
    } else {
      list = window._allAssetsList || [];
    }
    if (filterFn) {
      list = list.filter(filterFn);
    }
    // Sort so workstations needing keys appear first, then sorted by assigned user
    return list.slice().sort((a, b) => {
      const aNeeds = ['laptop', 'desktop'].includes(String(a.asset_type || '').toLowerCase()) && !a.quick_heal_key_str;
      const bNeeds = ['laptop', 'desktop'].includes(String(b.asset_type || '').toLowerCase()) && !b.quick_heal_key_str;
      if (aNeeds && !bNeeds) return -1;
      if (!aNeeds && bNeeds) return 1;
      return (a.assigned_user || '').localeCompare(b.assigned_user || '');
    });
  }

  function renderOptions(query = '') {
    const q = query.trim().toLowerCase();
    const assets = getAvailableAssets().filter(a => {
      if (!q) return true;
      const haystack = `${a.internal_serial_number} ${a.asset_type} ${a.brand || ''} ${a.model_name || ''} ${a.assigned_user || ''} ${a.department || ''} ${a.serial_number || ''}`.toLowerCase();
      return haystack.includes(q);
    });

    if (assets.length === 0) {
      dropdown.innerHTML = `<div class="p-3 text-center text-xs text-slate-400 font-medium">No matching workstations or devices found</div>`;
      dropdown.classList.remove('hidden');
      return;
    }

    dropdown.innerHTML = assets.slice(0, 80).map(a => {
      const isWorkstation = ['laptop', 'desktop'].includes(String(a.asset_type || '').toLowerCase());
      const needsKey = isWorkstation && !a.quick_heal_key_str;
      return `
        <div data-id="${a.id}" class="combobox-opt p-3 hover:bg-purple-50/80 cursor-pointer flex items-center justify-between transition-colors border-b border-slate-100 last:border-b-0">
          <div>
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="font-bold text-xs text-slate-900">${escapeHtml(a.assigned_user ? '👤 ' + a.assigned_user : '👤 Unassigned')}</span>
              <span class="font-mono font-bold text-brand-600 text-xs">#${escapeHtml(a.internal_serial_number)}</span>
              <span class="text-xs text-slate-600 font-semibold">• ${escapeHtml(a.brand || '')} ${escapeHtml(a.asset_type)}</span>
            </div>
            <div class="text-[11px] text-slate-500 mt-0.5">Dept: ${escapeHtml(a.department || 'General')} • Loc: ${escapeHtml(a.location || 'Head Office')} ${a.serial_number ? `• S/N: ${escapeHtml(a.serial_number)}` : ''}</div>
          </div>
          <div class="text-right flex flex-col items-end gap-1 flex-shrink-0 ml-2">
            ${needsKey ? `
              <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-rose-50 text-rose-700 border border-rose-200/90 shadow-xs" title="Missing Antivirus Key">
                <i data-lucide="shield-alert" class="w-3 h-3 text-rose-500"></i>
                <span>Unprotected</span>
              </span>
            ` : a.quick_heal_key_str ? `
              <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-purple-50 text-purple-700 border border-purple-200" title="Key: ${escapeHtml(a.quick_heal_key_str)}">
                <i data-lucide="shield-check" class="w-3 h-3 text-purple-600"></i>
                <span>Mapped</span>
              </span>
            ` : `
              <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full ${a.working_status === 'Working' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}">${escapeHtml(a.working_status)}</span>
            `}
          </div>
        </div>
      `;
    }).join('');

    dropdown.classList.remove('hidden');
    lucide.createIcons();

    dropdown.querySelectorAll('.combobox-opt').forEach(opt => {
      opt.onclick = () => {
        const id = opt.getAttribute('data-id');
        const asset = getAvailableAssets().find(a => a.id === Number(id));
        selectAsset(asset);
      };
    });
  }

  function selectAsset(asset) {
    if (!asset) {
      hiddenInput.value = '';
      input.value = '';
      if (previewContainer) previewContainer.classList.add('hidden');
      if (clearBtn) clearBtn.classList.add('hidden');
      dropdown.classList.add('hidden');
      return;
    }

    hiddenInput.value = asset.id;
    input.value = `#${asset.internal_serial_number} - ${asset.brand || ''} ${asset.asset_type} (${asset.assigned_user || 'Unassigned'})`;
    if (previewContainer && previewText) {
      previewText.innerHTML = `Selected: <strong>#${escapeHtml(asset.internal_serial_number)}</strong> (${escapeHtml(asset.brand || '')} ${escapeHtml(asset.asset_type)}) — User: <strong>${escapeHtml(asset.assigned_user || 'Unassigned')}</strong> [${escapeHtml(asset.department || '')}]`;
      previewContainer.classList.remove('hidden');
    }
    if (clearBtn) clearBtn.classList.remove('hidden');
    dropdown.classList.add('hidden');
  }

  input.onfocus = () => {
    renderOptions(input.value);
  };

  input.oninput = () => {
    if (clearBtn) {
      if (input.value) clearBtn.classList.remove('hidden');
      else clearBtn.classList.add('hidden');
    }
    renderOptions(input.value);
  };

  if (clearBtn) {
    clearBtn.onclick = (e) => {
      e.stopPropagation();
      selectAsset(null);
      input.focus();
    };
  }

  // Click outside listener
  const outsideClick = (e) => {
    if (!container.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  };
  document.removeEventListener('click', container._outsideListener || (() => {}));
  container._outsideListener = outsideClick;
  document.addEventListener('click', outsideClick);

  return {
    selectAsset,
    openDropdown: () => renderOptions(input.value),
    closeDropdown: () => dropdown.classList.add('hidden'),
    setValue: (assetId) => {
      if (!assetId) {
        selectAsset(null);
        return;
      }
      const asset = getAvailableAssets().find(a => a.id === Number(assetId) || a.internal_serial_number === String(assetId));
      if (asset) {
        selectAsset(asset);
      } else {
        hiddenInput.value = assetId;
      }
    }
  };
}

// ==========================================
// 6. VIEW: REPAIRS & LIFECYCLE MANAGEMENT
// ==========================================

let repairSearchTimeout = null;
let activeRepairTab = 'all';

function debounceRepairSearch() {
  clearTimeout(repairSearchTimeout);
  repairSearchTimeout = setTimeout(() => loadRepairs(), 250);
}

function filterRepairTab(tab) {
  activeRepairTab = tab;
  ['all', 'open', 'closed'].forEach(t => {
    const el = document.getElementById(`tab-repairs-${t}`);
    if (!el) return;
    if (t === tab) {
      el.className = 'px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all bg-slate-900 text-white shadow-sm flex items-center gap-1.5';
    } else {
      el.className = 'px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all bg-white text-slate-600 hover:bg-slate-100 border border-slate-200 flex items-center gap-1.5';
    }
  });
  loadRepairs();
}

function resetRepairFilters() {
  const searchEl = document.getElementById('repair-filter-search');
  const statusEl = document.getElementById('repair-filter-status');
  const fromEl = document.getElementById('repair-filter-date-from');
  const toEl = document.getElementById('repair-filter-date-to');
  if (searchEl) searchEl.value = '';
  if (statusEl) statusEl.value = '';
  if (fromEl) fromEl.value = '';
  if (toEl) toEl.value = '';
  filterRepairTab('all');
}

async function loadRepairs(filterParams = {}) {
  try {
    const search = filterParams.search !== undefined ? filterParams.search : document.getElementById('repair-filter-search')?.value || '';
    const status = filterParams.status !== undefined ? filterParams.status : document.getElementById('repair-filter-status')?.value || '';
    const ticketStatus = filterParams.ticket_status !== undefined ? filterParams.ticket_status : activeRepairTab;
    const date_from = filterParams.date_from !== undefined ? filterParams.date_from : document.getElementById('repair-filter-date-from')?.value || '';
    const date_to = filterParams.date_to !== undefined ? filterParams.date_to : document.getElementById('repair-filter-date-to')?.value || '';

    if (filterParams.search && document.getElementById('repair-filter-search')) {
      document.getElementById('repair-filter-search').value = filterParams.search;
    }

    const params = new URLSearchParams();
    if (search) params.append('search', search);
    if (status) params.append('status', status);
    if (ticketStatus && ticketStatus !== 'all') params.append('ticket_status', ticketStatus);
    if (date_from) params.append('date_from', date_from);
    if (date_to) params.append('date_to', date_to);

    const res = await apiFetch(`/api/repairs?${params.toString()}`);
    if (!res.ok) return;
    const data = await res.json();
    window._cachedRepairs = data.repairs || [];

    // Update Tab Counters
    if (data.counts) {
      const totalEl = document.getElementById('repairs-total-counter');
      const openEl = document.getElementById('repairs-open-counter');
      const closedEl = document.getElementById('repairs-closed-counter');
      if (totalEl) totalEl.textContent = data.counts.total ?? 0;
      if (openEl) openEl.textContent = data.counts.open_count ?? 0;
      if (closedEl) closedEl.textContent = data.counts.closed_count ?? 0;
      const sidebarRepairEl = document.getElementById('sidebar-repair-count');
      if (sidebarRepairEl) sidebarRepairEl.textContent = data.counts.open_count ?? 0;
    }

    const tbody = document.getElementById('repairs-table-body');
    tbody.innerHTML = '';

    if (data.repairs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" class="py-12 text-center text-slate-400">No maintenance tickets found for this filter.</td></tr>`;
      return;
    }

    const todayStr = new Date().toISOString().split('T')[0];

    data.repairs.forEach(r => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-50/80 transition-colors';
      const isViewer = currentUser?.role === 'viewer';
      const isAdmin = currentUser?.role === 'admin';
      const isOpen = (r.status !== 'Completed' && r.status !== 'Beyond Repair');

      let statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">${escapeHtml(r.status)}</span>`;
      if (r.status === 'Completed') statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Completed</span>`;
      else if (r.status === 'Beyond Repair') statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">Beyond Repair</span>`;

      let dueDateDisplay = '<span class="text-slate-400 text-xs">—</span>';
      if (r.due_date) {
        const isOverdue = isOpen && (r.due_date < todayStr);
        if (isOverdue) {
          dueDateDisplay = `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200 animate-pulse" title="Ticket is overdue!"><i data-lucide="clock" class="w-3 h-3 text-rose-600"></i>Overdue (${escapeHtml(r.due_date)})</span>`;
        } else {
          dueDateDisplay = `<span class="font-mono text-slate-700 text-xs font-semibold">${escapeHtml(r.due_date)}</span>`;
        }
      }

      tr.innerHTML = `
        <td class="py-3 px-4 font-mono font-bold text-brand-600">${escapeHtml(r.ticket_number)}</td>
        <td class="py-3 px-4">
          <span onclick="viewAssetDetail(${r.asset_id})" class="cursor-pointer font-mono font-bold text-slate-900 hover:text-brand-600 hover:underline">#${escapeHtml(r.internal_serial_number)}</span>
          <div class="text-[10px] text-slate-400">${escapeHtml(r.brand || '')} ${escapeHtml(r.asset_type)}</div>
        </td>
        <td class="py-3 px-4 font-medium text-slate-800 max-w-xs">${escapeHtml(r.issue_description)}</td>
        <td class="py-3 px-4 font-semibold text-sky-600">${escapeHtml(r.parts_added || '— None —')}</td>
        <td class="py-3 px-4 text-slate-500">${escapeHtml(r.repair_vendor || r.technician_name || 'In-House')}</td>
        <td class="py-3 px-4 text-slate-500">${escapeHtml(r.repair_date)}</td>
        <td class="py-3 px-4">${dueDateDisplay}</td>
        <td class="py-3 px-4 font-bold text-slate-900">₹${(r.repair_cost || 0).toLocaleString('en-IN')}</td>
        <td class="py-3 px-4">${statusBadge}</td>
        <td class="py-3 px-4 text-right">
          <div class="flex items-center justify-end gap-1">
            ${!isViewer && isOpen ? `
              <button onclick="openCloseTicketModal(${r.id})" title="Resolve & Close Ticket" class="p-1.5 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors">
                <i data-lucide="check-circle-2" class="w-4 h-4"></i>
              </button>
            ` : ''}
            ${!isViewer ? `
              <button onclick="openEditRepairModal(${r.id})" title="Update Ticket" class="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-slate-100 rounded-lg transition-colors">
                <i data-lucide="pencil" class="w-4 h-4"></i>
              </button>
            ` : ''}
            ${isAdmin ? `
              <button onclick="deleteRepair(${r.id}, '${escapeHtml(r.ticket_number)}')" title="Delete Ticket" class="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
            ` : ''}
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    loadEolAnalysis();
    lucide.createIcons();
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

    const flagged = data.assets.filter(a => a.repair_count > 0 || a.working_status !== 'Working' || a.healthClass !== 'success');

    if (flagged.length === 0) {
      container.innerHTML = `<div class="col-span-3 py-6 text-center text-xs text-slate-400">All registered devices are operating at nominal performance thresholds.</div>`;
      return;
    }

    flagged.forEach(a => {
      const card = document.createElement('div');
      card.className = 'p-4 rounded-2xl bg-slate-50 border border-slate-200/80 hover:border-slate-300 hover:shadow-sm cursor-pointer transition-all';
      card.onclick = () => viewAssetDetail(a.id);

      card.innerHTML = `
        <div class="flex items-center justify-between">
          <div>
            <div class="font-mono font-bold text-sm text-slate-900">#${escapeHtml(a.internal_serial_number)} • ${escapeHtml(a.brand)} ${escapeHtml(a.asset_type)}</div>
            <div class="text-[11px] text-slate-500 mt-0.5">User: ${escapeHtml(a.assigned_user || 'Unassigned')} • ${escapeHtml(a.department || '')}</div>
          </div>
          <span class="px-2 py-0.5 rounded-md text-[10px] font-bold ${a.healthClass === 'danger' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'}">${escapeHtml(a.healthScore)}</span>
        </div>
        <div class="my-3 p-2.5 rounded-xl bg-white border border-slate-200/60 text-xs space-y-1">
          <div class="flex justify-between text-slate-600">
            <span>Maintenance Tickets:</span>
            <strong class="text-slate-900">${a.repair_count} ticket(s)</strong>
          </div>
          <div class="flex justify-between text-slate-600">
            <span>Total Maintenance Cost:</span>
            <strong class="text-slate-900">₹${(a.total_repair_cost || 0).toLocaleString('en-IN')}</strong>
          </div>
          <div class="flex justify-between text-slate-600">
            <span>Parts Installed:</span>
            <span class="font-semibold text-sky-600 truncate max-w-[180px]">${escapeHtml(a.parts_added_summary || 'Standard')}</span>
          </div>
        </div>
        <p class="text-xs text-rose-700 font-medium">💡 Recommendation: ${escapeHtml(a.eolReason)}</p>
      `;
      container.appendChild(card);
    });

  } catch (err) {
    console.error('EOL analysis error:', err);
  }
}

// Open Repair Ticket Form
let repairCombobox = null;
async function openRepairModal(preselectedAssetId = null) {
  document.getElementById('form-repair').reset();
  document.getElementById('repair-form-id').value = '';
  document.getElementById('repair-form-title').textContent = 'Log Asset Repair / Part Replacement';
  document.getElementById('repair-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('repair-due-date').value = '';

  await fetchMasterAssets(false);

  if (!repairCombobox) {
    repairCombobox = initSearchableCombobox({
      containerId: 'combobox-repair-asset',
      inputId: 'combobox-repair-asset-input',
      dropdownId: 'combobox-repair-asset-dropdown',
      hiddenInputId: 'repair-asset-select',
      clearBtnId: 'combobox-repair-asset-clear',
      previewContainerId: 'repair-selected-asset-preview',
      previewTextId: 'repair-selected-asset-text',
      getAssetsFn: () => (window._allMasterAssets || []),
      filterFn: () => true
    });
  }

  repairCombobox.setValue(preselectedAssetId);
  openModal('modal-repair-form');
}

// Edit Repair Ticket
async function openEditRepairModal(repairId) {
  try {
    const res = await apiFetch('/api/repairs');
    if (!res.ok) return;
    const { repairs } = await res.json();
    const repair = repairs.find(r => r.id === repairId);
    if (!repair) return;

    await openRepairModal(repair.asset_id);
    document.getElementById('repair-form-title').textContent = `Update Ticket ${repair.ticket_number}`;
    document.getElementById('repair-form-id').value = repair.id;
    document.getElementById('repair-date').value = repair.repair_date || '';
    document.getElementById('repair-due-date').value = repair.due_date || '';
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

async function handleRepairSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('repair-form-id').value;
  const assetId = document.getElementById('repair-asset-select').value;
  if (!assetId) {
    showToast('Please select an IT asset to service', 'error');
    return;
  }

  const btn = document.getElementById('btn-save-repair');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  const payload = {
    asset_id: assetId,
    repair_date: document.getElementById('repair-date').value,
    due_date: document.getElementById('repair-due-date').value || null,
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

// 1-Click Resolve & Close Ticket Modal
async function openCloseTicketModal(repairId) {
  try {
    const repair = (window._cachedRepairs || []).find(r => r.id === repairId);
    if (!repair) {
      const res = await apiFetch('/api/repairs');
      if (!res.ok) return;
      const data = await res.json();
      window._cachedRepairs = data.repairs || [];
    }
    const target = (window._cachedRepairs || []).find(r => r.id === repairId);
    if (!target) return;

    document.getElementById('close-repair-id').value = target.id;
    document.getElementById('close-repair-asset-serial').textContent = '#' + target.internal_serial_number;
    document.getElementById('close-repair-ticket-num').textContent = target.ticket_number;
    document.getElementById('close-repair-asset-name').textContent = `${target.brand || ''} ${target.asset_type || ''} (${target.assigned_user || 'Unassigned'})`;
    document.getElementById('close-repair-asset-issue').textContent = 'Issue: ' + (target.issue_description || 'N/A');

    document.getElementById('close-repair-date').value = new Date().toISOString().split('T')[0];
    document.getElementById('close-repair-cost').value = target.repair_cost || 0;
    document.getElementById('close-repair-parts').value = target.parts_added || '';
    document.getElementById('close-repair-asset-status').value = 'Working';
    document.getElementById('close-repair-remarks').value = '';

    openModal('modal-close-repair');
  } catch (err) {
    console.error('Error opening close ticket modal:', err);
  }
}

async function submitCloseTicket(e) {
  e.preventDefault();
  const repairId = document.getElementById('close-repair-id').value;
  const btn = document.getElementById('btn-submit-close-repair');
  btn.disabled = true;
  btn.textContent = 'Resolving...';

  const payload = {
    completion_date: document.getElementById('close-repair-date').value,
    final_repair_cost: Number(document.getElementById('close-repair-cost').value) || 0,
    parts_added: document.getElementById('close-repair-parts').value.trim(),
    post_repair_asset_status: document.getElementById('close-repair-asset-status').value,
    resolution_notes: document.getElementById('close-repair-remarks').value.trim()
  };

  try {
    const res = await apiFetch(`/api/repairs/${repairId}/close`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'Ticket resolved and asset returned to operational fleet!', 'success');
      closeModal('modal-close-repair');
      loadRepairs();
      loadAssets();
      loadDashboard();
    } else {
      showToast(data.error || 'Failed to close ticket', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirm & Close Ticket';
  }
}

// ==========================================
// 7. VIEW: QUICK HEAL KEYS MANAGEMENT
// ==========================================

let keySearchTimeout = null;
function debounceKeySearch() {
  clearTimeout(keySearchTimeout);
  keySearchTimeout = setTimeout(() => loadKeys(), 250);
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

    const total = data.keys.length;
    const avail = data.keys.filter(k => k.status === 'Available').length;
    const assigned = data.keys.filter(k => k.status === 'Assigned').length;
    const expiring = data.keys.filter(k => k.is_expiring_soon).length;

    document.getElementById('keys-kpi-total').textContent = total;
    document.getElementById('keys-kpi-avail').textContent = avail;
    document.getElementById('keys-kpi-assigned').textContent = assigned;
    document.getElementById('keys-kpi-expiring').textContent = expiring;
    if (!search && !status) {
      const sidebarKeyEl = document.getElementById('sidebar-key-count');
      if (sidebarKeyEl) sidebarKeyEl.textContent = total;
    }

    const tbody = document.getElementById('keys-table-body');
    tbody.innerHTML = '';

    if (data.keys.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="py-12 text-center text-slate-400">No Quick Heal keys found.</td></tr>`;
      return;
    }

    data.keys.forEach(k => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-50/80 transition-colors';
      const isViewer = currentUser?.role === 'viewer';
      const isAdmin = currentUser?.role === 'admin';

      let statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Available</span>`;
      if (k.status === 'Assigned') {
        statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-50 text-purple-700 border border-purple-200">Assigned</span>`;
      }

      let validityDisplay = '<span class="text-slate-400">N/A</span>';
      if (k.days_remaining !== null) {
        if (k.is_expired) {
          validityDisplay = `<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">Expired</span>`;
        } else if (k.is_expiring_soon) {
          validityDisplay = `<span class="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">${k.days_remaining}d left</span>`;
        } else {
          const yrs = (k.days_remaining / 365).toFixed(1);
          validityDisplay = `<span class="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-slate-100 text-slate-700">~${yrs} yrs</span>`;
        }
      }

      let mappedAsset = `<span class="text-slate-400 text-xs">—</span>`;
      if (k.assigned_asset_id && k.internal_serial_number) {
        mappedAsset = `<span onclick="viewAssetDetail(${k.assigned_asset_id})" class="cursor-pointer font-mono font-bold text-brand-600 hover:underline">#${escapeHtml(k.internal_serial_number)} (${escapeHtml(k.asset_type || '')})</span>`;
      }

      tr.innerHTML = `
        <td class="py-3 px-4">
          <div class="flex items-center gap-2">
            <span class="font-mono font-bold text-slate-900 tracking-wide">${escapeHtml(k.product_key)}</span>
            <button onclick="navigator.clipboard.writeText('${escapeHtml(k.product_key)}'); showToast('Copied to clipboard', 'info');" title="Copy Key" class="p-1 text-slate-400 hover:text-slate-600">
              <i data-lucide="copy" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </td>
        <td class="py-3 px-4 font-semibold text-slate-700">${escapeHtml(k.edition || 'Total Security')}</td>
        <td class="py-3 px-4 text-slate-600 font-mono">${escapeHtml(k.validity_date || '—')}</td>
        <td class="py-3 px-4">${validityDisplay}</td>
        <td class="py-3 px-4">${statusBadge}</td>
        <td class="py-3 px-4">${mappedAsset}</td>
        <td class="py-3 px-4 font-medium text-slate-800">${escapeHtml(k.assigned_user || k.asset_assigned_user || '—')}</td>
        <td class="py-3 px-4 text-right">
          <div class="flex items-center justify-end gap-1.5">
            ${!isViewer && k.status === 'Available' ? `
              <button onclick="openMapKeyModal(${k.id}, '${escapeHtml(k.product_key)}')" class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200">
                <i data-lucide="link" class="w-3 h-3"></i>
                <span>Map</span>
              </button>
            ` : ''}
            ${!isViewer && k.status === 'Assigned' ? `
              <button onclick="unmapKey(${k.id})" class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200">
                <span>Unmap</span>
              </button>
            ` : ''}
            ${isAdmin ? `
              <button onclick="deleteKey(${k.id}, '${escapeHtml(k.product_key)}')" class="p-1 text-slate-400 hover:text-rose-600">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
            ` : ''}
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    lucide.createIcons();
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
      updateGlobalSidebarCounters();
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
      updateGlobalSidebarCounters();
    } else {
      showToast(data.error || 'Bulk import failed', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

let currentMapKeyId = null;
let activeMapWorkstationFilter = 'all';
let selectedMapAssetId = null;
let mapWorkstationCandidates = [];

async function openMapKeyModal(keyId, keyCode) {
  currentMapKeyId = keyId;
  selectedMapAssetId = null;

  const keyIdInput = document.getElementById('map-key-id');
  if (keyIdInput) keyIdInput.value = keyId;

  const assetSelectInput = document.getElementById('map-asset-select');
  if (assetSelectInput) assetSelectInput.value = '';

  const displayEl = document.getElementById('map-key-display');
  if (displayEl) displayEl.textContent = keyCode;

  const searchInput = document.getElementById('map-workstation-search');
  if (searchInput) searchInput.value = '';

  const clearBtn = document.getElementById('map-workstation-clear');
  if (clearBtn) clearBtn.classList.add('hidden');

  const previewText = document.getElementById('map-selected-text');
  if (previewText) previewText.textContent = 'No workstation selected yet. Click an eligible workstation above.';

  const previewBadge = document.getElementById('map-selected-badge');
  if (previewBadge) previewBadge.classList.add('hidden');

  const submitBtn = document.getElementById('btn-submit-map-key');
  if (submitBtn) submitBtn.disabled = true;

  await fetchMasterAssets(true);

  // Quick Heal keys are required ONLY for Laptops and Desktops!
  mapWorkstationCandidates = (window._allMasterAssets || []).filter(a =>
    ['laptop', 'desktop'].includes(String(a.asset_type || '').toLowerCase())
  );

  const unprotectedCount = mapWorkstationCandidates.filter(a => !a.quick_heal_key_str).length;
  const totalCount = mapWorkstationCandidates.length;

  const countUnprot = document.getElementById('map-count-unprotected');
  if (countUnprot) countUnprot.textContent = unprotectedCount;

  const countAll = document.getElementById('map-count-all');
  if (countAll) countAll.textContent = totalCount;

  // Default to 'unprotected' if there are unprotected workstations, else 'all'
  setMapWorkstationFilter(unprotectedCount > 0 ? 'unprotected' : 'all');

  openModal('modal-map-key');
}

function setMapWorkstationFilter(filterType) {
  activeMapWorkstationFilter = filterType;

  const tabs = ['unprotected', 'all', 'laptop', 'desktop'];
  tabs.forEach(t => {
    const el = document.getElementById(`map-filter-${t}`);
    if (!el) return;
    const isActive = t === filterType;
    if (t === 'unprotected') {
      el.className = isActive
        ? 'px-2.5 py-1 rounded-lg text-[11px] font-bold bg-rose-600 text-white shadow-sm flex items-center gap-1 transition-all'
        : 'px-2.5 py-1 rounded-lg text-[11px] font-bold bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 flex items-center gap-1 transition-all';
    } else {
      el.className = isActive
        ? 'px-2.5 py-1 rounded-lg text-[11px] font-bold bg-slate-900 text-white shadow-sm transition-all'
        : 'px-2.5 py-1 rounded-lg text-[11px] font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 transition-all';
    }
  });

  renderMapWorkstationList();
}

function renderMapWorkstationList() {
  const container = document.getElementById('map-workstations-container');
  if (!container) return;

  const q = (document.getElementById('map-workstation-search')?.value || '').trim().toLowerCase();
  const clearBtn = document.getElementById('map-workstation-clear');
  if (clearBtn) {
    if (q) clearBtn.classList.remove('hidden');
    else clearBtn.classList.add('hidden');
  }

  let list = mapWorkstationCandidates.slice();

  // Tab filter
  if (activeMapWorkstationFilter === 'unprotected') {
    list = list.filter(a => !a.quick_heal_key_str);
  } else if (activeMapWorkstationFilter === 'laptop') {
    list = list.filter(a => String(a.asset_type || '').toLowerCase() === 'laptop');
  } else if (activeMapWorkstationFilter === 'desktop') {
    list = list.filter(a => String(a.asset_type || '').toLowerCase() === 'desktop');
  }

  // Live search query filter
  if (q) {
    list = list.filter(a => {
      const haystack = `${a.internal_serial_number} ${a.asset_type} ${a.brand || ''} ${a.model_name || ''} ${a.assigned_user || ''} ${a.department || ''} ${a.location || ''} ${a.serial_number || ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }

  // Sort: Unprotected first, then by assigned user
  list.sort((a, b) => {
    const aNeeds = !a.quick_heal_key_str;
    const bNeeds = !b.quick_heal_key_str;
    if (aNeeds && !bNeeds) return -1;
    if (!aNeeds && bNeeds) return 1;
    return (a.assigned_user || '').localeCompare(b.assigned_user || '');
  });

  if (list.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center text-xs text-slate-400 font-medium">
        <i data-lucide="search-x" class="w-6 h-6 mx-auto mb-1 text-slate-300"></i>
        <span>No matching workstations found for current filter.</span>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  container.innerHTML = list.map(a => {
    const isSelected = selectedMapAssetId === a.id;
    const isUnprotected = !a.quick_heal_key_str;

    let statusBadge = '';
    if (isUnprotected) {
      statusBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-rose-50 text-rose-700 border border-rose-200/90 shadow-xs"><i data-lucide="shield-alert" class="w-3 h-3 text-rose-500"></i><span>Unprotected</span></span>`;
    } else {
      statusBadge = `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-purple-50 text-purple-700 border border-purple-200"><i data-lucide="shield-check" class="w-3 h-3 text-purple-600"></i><span>Mapped</span></span>`;
    }

    const initial = (a.assigned_user || 'U').charAt(0).toUpperCase();

    return `
      <div onclick="selectMapWorkstation(${a.id})" class="p-3 rounded-xl border cursor-pointer transition-all flex items-center justify-between ${
        isSelected
          ? 'bg-purple-50/80 border-purple-500 ring-2 ring-purple-500/25 shadow-sm'
          : 'bg-white hover:bg-slate-50 border-slate-200/80 hover:border-slate-300'
      }">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-xs flex-shrink-0 transition-colors ${
            isSelected ? 'bg-purple-600 text-white shadow-sm' : 'bg-slate-100 text-slate-700'
          }">
            ${isSelected ? '<i data-lucide="check" class="w-4 h-4"></i>' : initial}
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-bold text-xs text-slate-900 truncate">${escapeHtml(a.assigned_user || 'Unassigned')}</span>
              <span class="font-mono font-bold text-brand-600 text-xs">#${escapeHtml(a.internal_serial_number)}</span>
              <span class="text-xs text-slate-600 font-medium">• ${escapeHtml(a.brand || '')} ${escapeHtml(a.asset_type)}</span>
            </div>
            <div class="text-[11px] text-slate-500 mt-0.5 truncate">
              Dept: ${escapeHtml(a.department || 'General')} • Loc: ${escapeHtml(a.location || 'Head Office')} ${a.serial_number ? `• S/N: ${escapeHtml(a.serial_number)}` : ''}
            </div>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0 ml-3">
          ${statusBadge}
        </div>
      </div>
    `;
  }).join('');

  lucide.createIcons();
}

function selectMapWorkstation(assetId) {
  selectedMapAssetId = assetId;
  const selectEl = document.getElementById('map-asset-select');
  if (selectEl) selectEl.value = assetId;

  const a = mapWorkstationCandidates.find(w => w.id === assetId);
  const previewText = document.getElementById('map-selected-text');
  const previewBadge = document.getElementById('map-selected-badge');
  const submitBtn = document.getElementById('btn-submit-map-key');

  if (a && previewText) {
    previewText.innerHTML = `Selected: <strong>${escapeHtml(a.assigned_user || 'Unassigned')}</strong> (#${escapeHtml(a.internal_serial_number)} • ${escapeHtml(a.brand || '')} ${escapeHtml(a.asset_type)})`;
    if (previewBadge) previewBadge.classList.remove('hidden');
    if (submitBtn) submitBtn.disabled = false;
  }

  renderMapWorkstationList();
}

function clearMapWorkstationSearch() {
  const searchInput = document.getElementById('map-workstation-search');
  if (searchInput) searchInput.value = '';
  renderMapWorkstationList();
}

async function openMapKeyModalForAsset(assetId) {
  try {
    const res = await apiFetch('/api/keys');
    if (!res.ok) return;
    const data = await res.json();
    const availableKey = (data.keys || []).find(k => k.status === 'Available');
    if (!availableKey) {
      showToast('No Available Quick Heal keys in the license pool. Please add or unmap a key first.', 'error');
      navigate('keys');
      return;
    }
    await openMapKeyModal(availableKey.id, availableKey.product_key);
    selectMapWorkstation(assetId);
  } catch (err) {
    console.error('openMapKeyModalForAsset error:', err);
  }
}

async function handleMapKeySubmit(e) {
  e.preventDefault();
  const keyId = document.getElementById('map-key-id').value;
  const assetId = document.getElementById('map-asset-select').value;
  if (!assetId) {
    showToast('Please select a destination workstation (Laptop or Desktop)', 'error');
    return;
  }

  try {
    const res = await apiFetch(`/api/keys/${keyId}/map`, {
      method: 'POST',
      body: JSON.stringify({ asset_id: assetId })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      closeModal('modal-map-key');
      allMasterAssets = [];
      window._allMasterAssets = [];
      loadKeys();
      loadAssets();
      loadDashboard();
      updateGlobalSidebarCounters();
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
      updateGlobalSidebarCounters();
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
      updateGlobalSidebarCounters();
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
  accSearchTimeout = setTimeout(() => loadAccessories(), 250);
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
    window._cachedAccessories = data.accessories || [];

    const accBadge = document.getElementById('sidebar-acc-count');
    if (accBadge && !search && !cat && !status) {
      accBadge.textContent = data.accessories.length;
    }

    // Update 3 Stock KPI Cards
    if (data.stats) {
      const metricTotal = document.getElementById('acc-metric-total');
      const metricAvail = document.getElementById('acc-metric-available');
      const metricAssigned = document.getElementById('acc-metric-assigned');
      if (metricTotal) metricTotal.textContent = `${data.stats.total_units} Units`;
      if (metricAvail) metricAvail.textContent = `${data.stats.in_stock_units} Units`;
      if (metricAssigned) metricAssigned.textContent = `${data.stats.assigned_units} Units`;
    }

    const tbody = document.getElementById('accessories-table-body');
    tbody.innerHTML = '';

    if (data.accessories.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="py-12 text-center text-slate-400">No accessories found.</td></tr>`;
      return;
    }

    data.accessories.forEach(item => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-50/80 transition-colors';
      const isViewer = currentUser?.role === 'viewer';
      const isAdmin = currentUser?.role === 'admin';

      let statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">${escapeHtml(item.status)}</span>`;
      if (item.status === 'Assigned') statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">Assigned</span>`;
      else if (item.status === 'Damaged') statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">Damaged</span>`;

      tr.innerHTML = `
        <td class="py-3 px-4 font-mono font-bold text-brand-600">${escapeHtml(item.accessory_code)}</td>
        <td class="py-3 px-4 font-bold text-slate-900">${escapeHtml(item.name)}</td>
        <td class="py-3 px-4"><span class="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-slate-100 text-slate-700">${escapeHtml(item.category)}</span></td>
        <td class="py-3 px-4 text-slate-600">${escapeHtml(item.brand || '')} ${escapeHtml(item.model || '')}</td>
        <td class="py-3 px-4 font-black text-slate-900">${item.quantity}</td>
        <td class="py-3 px-4 text-slate-500">${escapeHtml(item.location || 'Store Room')}</td>
        <td class="py-3 px-4 text-slate-700 font-medium">${escapeHtml(item.assigned_user || (item.asset_serial ? '#' + item.asset_serial : '—'))}</td>
        <td class="py-3 px-4">${statusBadge}</td>
        <td class="py-3 px-4 text-right">
          <div class="flex items-center justify-end gap-1">
            ${!isViewer && item.status === 'In Stock' ? `
              <button onclick="openAssignAccessoryModal(${item.id})" title="Issue to Staff" class="p-1.5 text-purple-600 hover:text-purple-700 hover:bg-purple-50 rounded-lg transition-colors">
                <i data-lucide="user-plus" class="w-4 h-4"></i>
              </button>
            ` : ''}
            ${!isViewer && item.status === 'Assigned' ? `
              <button onclick="returnAccessoryToStock(${item.id})" title="Return to Stock" class="p-1.5 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors">
                <i data-lucide="rotate-ccw" class="w-4 h-4"></i>
              </button>
            ` : ''}
            ${!isViewer ? `
              <button onclick="openEditAccessoryModal(${item.id})" title="Edit Item" class="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-slate-100 rounded-lg transition-colors">
                <i data-lucide="pencil" class="w-4 h-4"></i>
              </button>
            ` : ''}
            ${isAdmin ? `
              <button onclick="deleteAccessory(${item.id})" title="Delete Item" class="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
            ` : ''}
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    lucide.createIcons();
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
    const item = (window._cachedAccessories || []).find(a => a.id === accId);
    if (!item) {
      const res = await apiFetch('/api/accessories');
      if (!res.ok) return;
      const data = await res.json();
      window._cachedAccessories = data.accessories || [];
    }
    const current = (window._cachedAccessories || []).find(a => a.id === accId);
    if (!current) return;

    document.getElementById('acc-form-title').textContent = `Edit Accessory ${current.accessory_code}`;
    document.getElementById('acc-form-id').value = current.id;
    document.getElementById('acc-code').value = current.accessory_code;
    document.getElementById('acc-category').value = current.category;
    document.getElementById('acc-name').value = current.name;
    document.getElementById('acc-brand').value = current.brand || '';
    document.getElementById('acc-qty').value = current.quantity;
    document.getElementById('acc-location').value = current.location || '';
    document.getElementById('acc-status').value = current.status;
    document.getElementById('acc-remarks').value = current.remarks || '';

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
      loadDashboard();
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
      loadDashboard();
    } else {
      showToast(data.error, 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Issue Accessory to Staff Modal Handlers
async function openAssignAccessoryModal(accId) {
  const item = (window._cachedAccessories || []).find(a => a.id === accId);
  if (!item) return;

  document.getElementById('assign-acc-id').value = item.id;
  document.getElementById('assign-acc-item-title').textContent = `${item.name} (${item.accessory_code})`;
  document.getElementById('assign-acc-item-info').textContent = `Brand: ${item.brand || 'Standard'} • Available Quantity: ${item.quantity}`;
  
  const qtyInput = document.getElementById('assign-acc-quantity');
  if (qtyInput) {
    qtyInput.value = 1;
    qtyInput.max = item.quantity;
    qtyInput.min = 1;
  }
  const maxHint = document.getElementById('assign-acc-max-hint');
  if (maxHint) {
    maxHint.textContent = `Max: ${item.quantity}`;
  }

  await populateAccessoryUserSelect();
  document.getElementById('assign-acc-location').value = item.location || '';
  document.getElementById('assign-acc-remarks').value = '';

  openModal('modal-assign-accessory');
  lucide.createIcons();
}

async function submitAssignAccessory(e) {
  e.preventDefault();
  const accId = document.getElementById('assign-acc-id').value;
  const qtyInput = document.getElementById('assign-acc-quantity');
  const qty = qtyInput ? (parseInt(qtyInput.value, 10) || 1) : 1;

  if (qty < 1) {
    showToast('Assignment quantity must be at least 1', 'error');
    return;
  }

  const payload = {
    quantity: qty,
    assigned_user: document.getElementById('assign-acc-user').value.trim(),
    location: document.getElementById('assign-acc-location').value.trim(),
    remarks: document.getElementById('assign-acc-remarks').value.trim()
  };

  try {
    const res = await apiFetch(`/api/accessories/${accId}/assign`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'Accessory successfully assigned!', 'success');
      closeModal('modal-assign-accessory');
      loadAccessories();
      loadDashboard();
    } else {
      showToast(data.error || 'Failed to assign accessory', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function returnAccessoryToStock(accId) {
  if (!confirm('Return this accessory item back to Available stock in store room?')) return;

  try {
    const res = await apiFetch(`/api/accessories/${accId}/return`, {
      method: 'POST',
      body: JSON.stringify({ location: 'Store Room' })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'Accessory returned to stock', 'success');
      loadAccessories();
      loadDashboard();
    } else {
      showToast(data.error || 'Failed to return accessory', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==========================================
// 8B. BULK ASSET INVENTORY IMPORT
// ==========================================

let selectedBulkFile = null;

function openBulkImportModal() {
  selectedBulkFile = null;
  const fileInput = document.getElementById('bulk-import-file');
  if (fileInput) fileInput.value = '';

  const label = document.getElementById('bulk-file-label');
  if (label) label.textContent = 'Click to browse file or drag and drop here';

  const previewContainer = document.getElementById('bulk-preview-container');
  if (previewContainer) previewContainer.classList.add('hidden');

  const resultsLog = document.getElementById('bulk-results-log');
  if (resultsLog) {
    resultsLog.innerHTML = '';
    resultsLog.classList.add('hidden');
  }

  const btn = document.getElementById('btn-execute-bulk-import');
  if (btn) btn.disabled = true;

  openModal('modal-bulk-import');
}

async function downloadAssetTemplate(format = 'excel', event = null) {
  if (event) {
    try { event.preventDefault(); } catch (e) {}
  }

  const url = format === 'csv' ? '/api/assets/template/csv' : '/api/assets/template/excel';
  const filename = format === 'csv' ? 'it_assets_bulk_import_template.csv' : 'it_assets_bulk_import_template.xlsx';

  showToast('Preparing ' + (format === 'csv' ? 'CSV' : 'Excel (.xlsx)') + ' template...', 'info');

  try {
    const res = await apiFetch(url);
    if (!res.ok) {
      window.location.href = url;
      return;
    }
    const blob = await res.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 1500);
    showToast('Downloaded ' + filename, 'success');
  } catch (err) {
    console.error('Download error, falling back to direct URL:', err);
    window.location.href = url;
  }
}

function handleBulkFileSelect(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  selectedBulkFile = file;

  const label = document.getElementById('bulk-file-label');
  if (label) {
    label.innerHTML = `<span class="text-brand-600 font-bold">${escapeHtml(file.name)}</span> (${(file.size / 1024).toFixed(1)} KB)`;
  }

  const btn = document.getElementById('btn-execute-bulk-import');
  if (btn) btn.disabled = false;

  // If CSV, preview top rows client side
  if (file.name.toLowerCase().endsWith('.csv')) {
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target.result;
      const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
      if (lines.length > 1) {
        const previewRows = lines.slice(1, 11).map(l => {
          return l.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
        });

        const countEl = document.getElementById('bulk-preview-count');
        if (countEl) countEl.textContent = lines.length - 1;

        const tbody = document.getElementById('bulk-preview-tbody');
        if (tbody) {
          tbody.innerHTML = previewRows.map(cols => `
            <tr class="hover:bg-slate-50">
              <td class="py-1.5 px-3 font-mono font-bold text-brand-600">#${escapeHtml(cols[0] || '')}</td>
              <td class="py-1.5 px-3">${escapeHtml(cols[1] || '')}</td>
              <td class="py-1.5 px-3">${escapeHtml(cols[2] || '')}</td>
              <td class="py-1.5 px-3">${escapeHtml(cols[3] || '')}</td>
              <td class="py-1.5 px-3">${escapeHtml(cols[7] || '')}</td>
              <td class="py-1.5 px-3 font-semibold text-slate-800">${escapeHtml(cols[9] || '')}</td>
              <td class="py-1.5 px-3">${escapeHtml(cols[10] || 'Working')}</td>
            </tr>
          `).join('');
        }

        const previewContainer = document.getElementById('bulk-preview-container');
        if (previewContainer) previewContainer.classList.remove('hidden');
      }
    };
    reader.readAsText(file);
  } else {
    // Excel file
    const countEl = document.getElementById('bulk-preview-count');
    if (countEl) countEl.textContent = 'Excel Spreadsheet';
    const previewContainer = document.getElementById('bulk-preview-container');
    if (previewContainer) previewContainer.classList.remove('hidden');
    const tbody = document.getElementById('bulk-preview-tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" class="py-4 text-center text-slate-500 font-sans">Excel workbook file attached. Ready for atomic server batch insertion.</td></tr>`;
    }
  }
}

async function executeBulkImport() {
  if (!selectedBulkFile) {
    showToast('Please select a CSV or Excel file first', 'error');
    return;
  }

  const btn = document.getElementById('btn-execute-bulk-import');
  btn.disabled = true;
  btn.innerHTML = `<span class="inline-flex items-center gap-1.5"><i data-lucide="loader" class="w-4 h-4 animate-spin"></i><span>Importing...</span></span>`;
  lucide.createIcons();

  const formData = new FormData();
  formData.append('file', selectedBulkFile);

  const token = localStorage.getItem('it_app_token');

  try {
    const res = await fetch('/api/assets/bulk-import', {
      method: 'POST',
      headers: {
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
      body: formData
    });

    const data = await res.json();
    const resultsLog = document.getElementById('bulk-results-log');

    if (res.ok) {
      showToast(data.message || `Successfully imported ${data.imported_count} assets!`, 'success');

      if (resultsLog) {
        resultsLog.classList.remove('hidden');
        resultsLog.innerHTML = `
          <div class="text-emerald-700 font-bold flex items-center gap-1.5">
            <i data-lucide="check-circle" class="w-4 h-4 text-emerald-600"></i>
            <span>Import Completed Successfully</span>
          </div>
          <div class="text-slate-700 mt-1 font-medium">
            ✅ Added <strong>${data.imported_count}</strong> new IT asset records to the inventory.
          </div>
          ${data.skipped_count > 0 ? `
            <div class="text-amber-700 mt-1">
              ⚠️ Skipped ${data.skipped_count} row(s) due to duplicates or validation errors.
            </div>
          ` : ''}
        `;
        lucide.createIcons();
      }

      loadAssets();
      loadDashboard();

      setTimeout(() => {
        closeModal('modal-bulk-import');
      }, 1500);
    } else {
      showToast(data.error || 'Bulk import failed', 'error');
      if (resultsLog) {
        resultsLog.classList.remove('hidden');
        resultsLog.innerHTML = `
          <div class="text-rose-700 font-bold flex items-center gap-1.5">
            <i data-lucide="alert-circle" class="w-4 h-4 text-rose-600"></i>
            <span>Import Errors: ${escapeHtml(data.error || 'Validation failure')}</span>
          </div>
          ${data.details && Array.isArray(data.details) ? `
            <ul class="list-disc pl-4 mt-1 text-[11px] text-rose-600 space-y-0.5">
              ${data.details.slice(0, 10).map(d => `<li>${escapeHtml(d)}</li>`).join('')}
            </ul>
          ` : ''}
        `;
        lucide.createIcons();
      }
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import Assets';
  }
}

// ==========================================
// 8C. BULK ACCESSORIES INVENTORY IMPORT
// ==========================================

let selectedBulkAccFile = null;

function openBulkImportAccessoriesModal() {
  selectedBulkAccFile = null;
  const fileInput = document.getElementById('bulk-import-acc-file');
  if (fileInput) fileInput.value = '';

  const label = document.getElementById('bulk-acc-file-label');
  if (label) label.textContent = 'Click to browse file or drag and drop here';

  const previewContainer = document.getElementById('bulk-acc-preview-container');
  if (previewContainer) previewContainer.classList.add('hidden');

  const resultsLog = document.getElementById('bulk-acc-results-log');
  if (resultsLog) {
    resultsLog.innerHTML = '';
    resultsLog.classList.add('hidden');
  }

  const btn = document.getElementById('btn-execute-bulk-acc-import');
  if (btn) btn.disabled = true;

  openModal('modal-bulk-import-accessories');
}

function downloadAccessoryTemplate() {
  window.open('/api/accessories/template/csv', '_blank');
}

function handleBulkAccessoryFileSelect(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  selectedBulkAccFile = file;

  const label = document.getElementById('bulk-acc-file-label');
  if (label) {
    label.innerHTML = `<span class="text-emerald-600 font-bold">${escapeHtml(file.name)}</span> (${(file.size / 1024).toFixed(1)} KB)`;
  }

  const btn = document.getElementById('btn-execute-bulk-acc-import');
  if (btn) btn.disabled = false;

  // If CSV, preview client side
  if (file.name.toLowerCase().endsWith('.csv')) {
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target.result;
      const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
      if (lines.length > 1) {
        const previewRows = lines.slice(1, 11).map(l => {
          return l.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
        });

        const countEl = document.getElementById('bulk-acc-preview-count');
        if (countEl) countEl.textContent = lines.length - 1;

        const tbody = document.getElementById('bulk-acc-preview-tbody');
        if (tbody) {
          tbody.innerHTML = previewRows.map(cols => `
            <tr class="hover:bg-slate-50">
              <td class="py-1.5 px-3 font-mono font-bold text-emerald-600">${escapeHtml(cols[0] || 'AUTO')}</td>
              <td class="py-1.5 px-3 font-semibold text-slate-800">${escapeHtml(cols[1] || '')}</td>
              <td class="py-1.5 px-3"><span class="px-1.5 py-0.5 rounded text-[9px] bg-slate-100 font-medium">${escapeHtml(cols[2] || '')}</span></td>
              <td class="py-1.5 px-3 text-slate-600">${escapeHtml(cols[3] || '')} ${escapeHtml(cols[4] || '')}</td>
              <td class="py-1.5 px-3 font-bold text-slate-900">${escapeHtml(cols[5] || '1')}</td>
              <td class="py-1.5 px-3 text-slate-500">${escapeHtml(cols[6] || 'Store Room')}</td>
              <td class="py-1.5 px-3 text-emerald-700 font-medium">${escapeHtml(cols[7] || 'In Stock')}</td>
            </tr>
          `).join('');
        }

        const previewContainer = document.getElementById('bulk-acc-preview-container');
        if (previewContainer) previewContainer.classList.remove('hidden');
      }
    };
    reader.readAsText(file);
  } else {
    // Excel file
    const countEl = document.getElementById('bulk-acc-preview-count');
    if (countEl) countEl.textContent = 'Excel Spreadsheet';
    const previewContainer = document.getElementById('bulk-acc-preview-container');
    if (previewContainer) previewContainer.classList.remove('hidden');
    const tbody = document.getElementById('bulk-acc-preview-tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" class="py-4 text-center text-slate-500 font-sans">Excel workbook file attached. Ready for atomic server batch insertion.</td></tr>`;
    }
  }
}

async function executeBulkAccessoryImport() {
  if (!selectedBulkAccFile) {
    showToast('Please select a CSV or Excel file first', 'error');
    return;
  }

  const btn = document.getElementById('btn-execute-bulk-acc-import');
  btn.disabled = true;
  btn.innerHTML = `<span class="inline-flex items-center gap-1.5"><i data-lucide="loader" class="w-4 h-4 animate-spin"></i><span>Importing...</span></span>`;
  lucide.createIcons();

  const formData = new FormData();
  formData.append('file', selectedBulkAccFile);

  const token = localStorage.getItem('it_app_token');

  try {
    const res = await fetch('/api/accessories/bulk-import', {
      method: 'POST',
      headers: {
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      },
      body: formData
    });

    const data = await res.json();
    const resultsLog = document.getElementById('bulk-acc-results-log');

    if (res.ok) {
      showToast(data.message || `Successfully imported ${data.imported_count} accessories!`, 'success');

      if (resultsLog) {
        resultsLog.classList.remove('hidden');
        resultsLog.innerHTML = `
          <div class="text-emerald-700 font-bold flex items-center gap-1.5">
            <i data-lucide="check-circle" class="w-4 h-4 text-emerald-600"></i>
            <span>Import Completed Successfully</span>
          </div>
          <div class="text-slate-700 mt-1 font-medium">
            ✅ Added <strong>${data.imported_count}</strong> new items, updated <strong>${data.updated_count || 0}</strong> existing stock records.
          </div>
          ${data.skipped_count > 0 ? `
            <div class="text-amber-700 mt-1">
              ⚠️ Skipped ${data.skipped_count} row(s) due to duplicates or validation errors.
            </div>
          ` : ''}
        `;
        lucide.createIcons();
      }

      loadAccessories();

      setTimeout(() => {
        closeModal('modal-bulk-import-accessories');
      }, 1500);
    } else {
      showToast(data.error || 'Bulk accessory import failed', 'error');
      if (resultsLog) {
        resultsLog.classList.remove('hidden');
        resultsLog.innerHTML = `
          <div class="text-rose-700 font-bold flex items-center gap-1.5">
            <i data-lucide="alert-circle" class="w-4 h-4 text-rose-600"></i>
            <span>Import Errors: ${escapeHtml(data.error || 'Validation failure')}</span>
          </div>
          ${data.details && Array.isArray(data.details) ? `
            <ul class="list-disc pl-4 mt-1 text-[11px] text-rose-600 space-y-0.5">
              ${data.details.slice(0, 10).map(d => `<li>${escapeHtml(d)}</li>`).join('')}
            </ul>
          ` : ''}
        `;
        lucide.createIcons();
      }
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import Accessories';
  }
}

// ==========================================
// 8D. IT EXPENSES & UPKEEP LEDGER
// ==========================================

let expenseSearchTimeout = null;

function debounceExpenseSearch() {
  clearTimeout(expenseSearchTimeout);
  expenseSearchTimeout = setTimeout(() => loadExpenses(), 250);
}

function applyExpenseDatePreset(preset) {
  const fromEl = document.getElementById('exp-filter-date-from');
  const toEl = document.getElementById('exp-filter-date-to');
  const presetSelect = document.getElementById('exp-filter-date-preset');
  if (presetSelect && presetSelect.value !== preset) {
    presetSelect.value = preset;
  }
  if (!fromEl || !toEl) return;

  const now = new Date();
  const formatISO = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  if (preset === 'all') {
    fromEl.value = '';
    toEl.value = '';
  } else if (preset === 'today') {
    const t = formatISO(now);
    fromEl.value = t;
    toEl.value = t;
  } else if (preset === 'this_week') {
    const day = now.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    const monday = new Date(now);
    monday.setDate(now.getDate() + diff);
    fromEl.value = formatISO(monday);
    toEl.value = formatISO(now);
  } else if (preset === 'this_month') {
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    fromEl.value = formatISO(firstDay);
    toEl.value = formatISO(now);
  } else if (preset === 'last_30_days') {
    const past30 = new Date(now);
    past30.setDate(now.getDate() - 30);
    fromEl.value = formatISO(past30);
    toEl.value = formatISO(now);
  } else if (preset === 'this_year') {
    const firstDayYear = new Date(now.getFullYear(), 0, 1);
    fromEl.value = formatISO(firstDayYear);
    toEl.value = formatISO(now);
  }

  loadExpenses();
}

function onExpenseDateInputChange() {
  const presetSelect = document.getElementById('exp-filter-date-preset');
  if (presetSelect) presetSelect.value = 'custom';
  loadExpenses();
}

function resetExpensesFilterUI(params = {}) {
  const searchEl = document.getElementById('exp-filter-search');
  const deptEl = document.getElementById('exp-filter-dept');
  const typeEl = document.getElementById('exp-filter-type');
  const statusEl = document.getElementById('exp-filter-status');
  const datePresetEl = document.getElementById('exp-filter-date-preset');
  const dateFromEl = document.getElementById('exp-filter-date-from');
  const dateToEl = document.getElementById('exp-filter-date-to');

  if (searchEl) searchEl.value = params.search || params.q || '';
  if (deptEl) deptEl.value = params.department || '';
  if (typeEl) typeEl.value = params.repair_type || '';
  if (statusEl) statusEl.value = params.status || '';
  if (datePresetEl) datePresetEl.value = 'all';
  if (dateFromEl) dateFromEl.value = '';
  if (dateToEl) dateToEl.value = '';
}

function downloadExpenseReport() {
  const search = document.getElementById('exp-filter-search')?.value || '';
  const dept = document.getElementById('exp-filter-dept')?.value || '';
  const type = document.getElementById('exp-filter-type')?.value || '';
  const status = document.getElementById('exp-filter-status')?.value || '';
  const date_from = document.getElementById('exp-filter-date-from')?.value || '';
  const date_to = document.getElementById('exp-filter-date-to')?.value || '';

  const params = new URLSearchParams();
  if (search) params.append('search', search);
  if (dept) params.append('department', dept);
  if (type) params.append('repair_type', type);
  if (status) params.append('status', status);
  if (date_from) params.append('date_from', date_from);
  if (date_to) params.append('date_to', date_to);

  window.open(`/api/expenses/export/csv?${params.toString()}`, '_blank');
}

async function loadExpenses(filterParams = {}) {
  try {
    const search = filterParams.search !== undefined ? filterParams.search : document.getElementById('exp-filter-search')?.value || '';
    const dept = filterParams.department !== undefined ? filterParams.department : document.getElementById('exp-filter-dept')?.value || '';
    const repair_type = filterParams.repair_type !== undefined ? filterParams.repair_type : document.getElementById('exp-filter-type')?.value || '';
    const status = filterParams.status !== undefined ? filterParams.status : document.getElementById('exp-filter-status')?.value || '';
    const date_from = filterParams.date_from !== undefined ? filterParams.date_from : document.getElementById('exp-filter-date-from')?.value || '';
    const date_to = filterParams.date_to !== undefined ? filterParams.date_to : document.getElementById('exp-filter-date-to')?.value || '';

    const params = new URLSearchParams();
    if (search) params.append('search', search);
    if (dept) params.append('department', dept);
    if (repair_type) params.append('repair_type', repair_type);
    if (status) params.append('status', status);
    if (date_from) params.append('date_from', date_from);
    if (date_to) params.append('date_to', date_to);

    const res = await apiFetch(`/api/expenses?${params.toString()}`);
    if (!res.ok) return;
    const data = await res.json();

    // 1. Update KPI Cards
    const totalSpend = data.stats.total_spend || 0;
    const closedSpend = data.stats.closed_spend || 0;
    const openLiability = data.stats.open_liability || 0;
    const avgCost = Math.round(data.stats.average_ticket_cost || 0);

    const totalSpendEl = document.getElementById('exp-total-spend');
    const openLiabEl = document.getElementById('exp-open-liability');
    const avgCostEl = document.getElementById('exp-avg-cost');
    const topDeptEl = document.getElementById('exp-top-dept');
    const topAssetEl = document.getElementById('exp-top-asset');

    if (totalSpendEl) totalSpendEl.textContent = `₹${totalSpend.toLocaleString('en-IN')}`;
    if (openLiabEl) openLiabEl.textContent = `₹${openLiability.toLocaleString('en-IN')}`;
    if (avgCostEl) avgCostEl.textContent = `₹${avgCost.toLocaleString('en-IN')}`;

    if (!search && !dept && !repair_type && !status && !date_from && !date_to) {
      const expBadge = document.getElementById('sidebar-expense-total');
      if (expBadge) {
        expBadge.textContent = totalSpend >= 1000 ? `₹${(totalSpend / 1000).toFixed(1)}k` : `₹${totalSpend}`;
      }
    }

    if (topDeptEl) {
      if (data.stats.top_department) {
        topDeptEl.textContent = `${data.stats.top_department.department} (₹${data.stats.top_department.total.toLocaleString('en-IN')})`;
      } else {
        topDeptEl.textContent = '—';
      }
    }

    if (topAssetEl) {
      if (data.stats.highest_spend_asset) {
        topAssetEl.textContent = `Highest: #${data.stats.highest_spend_asset.serial} (${data.stats.highest_spend_asset.brand || 'Asset'}) - ₹${data.stats.highest_spend_asset.total.toLocaleString('en-IN')}`;
      } else {
        topAssetEl.textContent = 'Highest asset: —';
      }
    }

    // 2. Populate Department Dropdown Filter if needed
    const deptSelect = document.getElementById('exp-filter-dept');
    if (deptSelect && deptSelect.options.length <= 1) {
      const depts = new Set();
      data.department_breakdown.forEach(d => {
        if (d.department) depts.add(d.department);
      });
      depts.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        deptSelect.appendChild(opt);
      });
      if (dept) deptSelect.value = dept;
    }

    // 3. Render Department Spend Breakdown Progress Bars
    const deptBreakdownEl = document.getElementById('exp-dept-breakdown');
    if (deptBreakdownEl) {
      deptBreakdownEl.innerHTML = '';
      if (!data.department_breakdown || data.department_breakdown.length === 0) {
        deptBreakdownEl.innerHTML = `<div class="text-xs text-slate-400 py-4 text-center">No departmental spend recorded yet.</div>`;
      } else {
        const maxSpend = data.department_breakdown[0]?.total_spend || 1;
        data.department_breakdown.forEach(item => {
          const pct = Math.round((item.total_spend / maxSpend) * 100);
          const row = document.createElement('div');
          row.className = 'cursor-pointer hover:bg-slate-50 p-2 rounded-xl transition-colors';
          row.onclick = () => {
            const filterDept = document.getElementById('exp-filter-dept');
            if (filterDept) filterDept.value = item.department;
            loadExpenses({ department: item.department });
          };
          row.innerHTML = `
            <div class="flex items-center justify-between text-xs font-semibold text-slate-700 mb-1">
              <span class="flex items-center gap-1.5">
                <i data-lucide="building" class="w-3.5 h-3.5 text-slate-400"></i>
                <span>${escapeHtml(item.department)}</span>
              </span>
              <span class="text-emerald-700 font-bold font-mono">₹${item.total_spend.toLocaleString('en-IN')} <span class="text-[10px] text-slate-400 font-normal">(${item.ticket_count} tickets)</span></span>
            </div>
            <div class="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
              <div class="h-full bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full" style="width: ${pct}%"></div>
            </div>
          `;
          deptBreakdownEl.appendChild(row);
        });
      }
    }

    // 4. Render Equipment Category Spend Breakdown
    const typeBreakdownEl = document.getElementById('exp-type-breakdown');
    if (typeBreakdownEl) {
      typeBreakdownEl.innerHTML = '';
      if (!data.asset_type_breakdown || data.asset_type_breakdown.length === 0) {
        typeBreakdownEl.innerHTML = `<div class="text-xs text-slate-400 py-4 text-center">No equipment category spend recorded yet.</div>`;
      } else {
        const maxTypeSpend = data.asset_type_breakdown[0]?.total_spend || 1;
        data.asset_type_breakdown.forEach(item => {
          const pct = Math.round((item.total_spend / maxTypeSpend) * 100);
          const row = document.createElement('div');
          row.className = 'p-2 rounded-xl bg-slate-50 border border-slate-100 transition-colors';
          row.innerHTML = `
            <div class="flex items-center justify-between text-xs font-semibold text-slate-700 mb-1">
              <span class="flex items-center gap-1.5">
                <i data-lucide="cpu" class="w-3.5 h-3.5 text-indigo-500"></i>
                <span>${escapeHtml(item.asset_type)}</span>
              </span>
              <span class="text-indigo-700 font-bold font-mono">₹${item.total_spend.toLocaleString('en-IN')} <span class="text-[10px] text-slate-400 font-normal">(${item.ticket_count} repairs)</span></span>
            </div>
            <div class="w-full h-2 bg-slate-200/80 rounded-full overflow-hidden">
              <div class="h-full bg-gradient-to-r from-indigo-500 to-sky-500 rounded-full" style="width: ${pct}%"></div>
            </div>
          `;
          typeBreakdownEl.appendChild(row);
        });
      }
    }

    // 5. Render Ledger Table Rows
    const tbody = document.getElementById('expenses-table-body');
    const countBadge = document.getElementById('exp-ledger-count');
    if (countBadge) {
      countBadge.textContent = `${data.expenses.length} records (₹${totalSpend.toLocaleString('en-IN')})`;
    }

    if (!tbody) return;
    tbody.innerHTML = '';

    if (data.expenses.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="py-12 text-center text-slate-400">No expense records found matching current criteria.</td></tr>`;
      lucide.createIcons();
      return;
    }

    data.expenses.forEach(item => {
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-slate-50/80 transition-colors';

      let statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">In Progress</span>`;
      if (item.status === 'Completed') {
        statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Completed</span>`;
      } else if (item.status === 'Awaiting Parts') {
        statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-50 text-sky-700 border border-sky-200">Awaiting Parts</span>`;
      } else if (item.status === 'Beyond Repair') {
        statusBadge = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200">Beyond Repair</span>`;
      }

      tr.innerHTML = `
        <td class="py-3 px-4">
          <div class="font-mono font-bold text-brand-600 text-xs">${escapeHtml(item.ticket_number)}</div>
          <div class="text-[11px] text-slate-500 mt-0.5 flex items-center gap-1">
            <i data-lucide="calendar" class="w-3 h-3 text-slate-400"></i>
            <span>${escapeHtml(item.repair_date || '—')}</span>
          </div>
        </td>
        <td class="py-3 px-4">
          <div class="font-bold text-slate-900 flex items-center gap-1.5">
            <span>${escapeHtml(item.brand || '')} ${escapeHtml(item.model_name || '')}</span>
            <span class="px-1.5 py-0.2 rounded text-[9px] font-bold uppercase bg-slate-100 text-slate-600 border border-slate-200">${escapeHtml(item.asset_type)}</span>
          </div>
          <div class="text-[11px] text-slate-500 font-mono mt-0.5 flex items-center gap-1">
            <span class="text-brand-600 font-bold">#${escapeHtml(item.internal_serial_number)}</span>
            ${item.serial_number ? `<span class="text-slate-400">(${escapeHtml(item.serial_number)})</span>` : ''}
          </div>
        </td>
        <td class="py-3 px-4">
          <div class="font-semibold text-slate-900">${escapeHtml(item.assigned_user || 'Unassigned')}</div>
          <div class="text-[10px] text-slate-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
            <span class="px-1.5 py-0.2 rounded font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">${escapeHtml(item.department || 'General')}</span>
            <span class="text-slate-400">• ${escapeHtml(item.location || 'Head Office')}</span>
          </div>
        </td>
        <td class="py-3 px-4 max-w-xs">
          <div class="flex items-center gap-1.5 mb-0.5">
            <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">${escapeHtml(item.repair_type)}</span>
          </div>
          <div class="text-xs text-slate-700 truncate" title="${escapeHtml(item.issue_description)}">${escapeHtml(item.issue_description)}</div>
          ${item.parts_added ? `
            <div class="text-[11px] text-emerald-700 font-semibold mt-1 flex items-center gap-1">
              <i data-lucide="check" class="w-3 h-3 text-emerald-600 flex-shrink-0"></i>
              <span class="truncate" title="${escapeHtml(item.parts_added)}">Replaced: ${escapeHtml(item.parts_added)}</span>
            </div>
          ` : ''}
        </td>
        <td class="py-3 px-4">
          <div class="font-semibold text-slate-800">${escapeHtml(item.repair_vendor || 'In-House Support')}</div>
          <div class="text-[11px] text-slate-500 mt-0.5">${escapeHtml(item.technician_name || 'Standard Tech')} ${item.technician_contact ? `<span class="text-[10px] text-slate-400">(${escapeHtml(item.technician_contact)})</span>` : ''}</div>
        </td>
        <td class="py-3 px-4 text-right">
          <div class="text-sm font-black text-slate-900 font-mono">₹${(item.repair_cost || 0).toLocaleString('en-IN')}</div>
        </td>
        <td class="py-3 px-4">
          ${statusBadge}
        </td>
        <td class="py-3 px-4 text-right">
          <div class="flex items-center justify-end gap-1">
            <button onclick="viewAssetDetail(${item.asset_id})" title="View Asset Dossier" class="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors">
              <i data-lucide="eye" class="w-4 h-4"></i>
            </button>
            <button onclick="openEditRepairModal(${item.id})" title="View / Edit Ticket" class="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors">
              <i data-lucide="wrench" class="w-4 h-4"></i>
            </button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    lucide.createIcons();
  } catch (err) {
    console.error('loadExpenses error:', err);
  }
}

// ==========================================
// 9. MASTER INTELLIGENCE SEARCH
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
  }, 200);
}

let popupSearchTimeout = null;
function debouncePopupSearch() {
  clearTimeout(popupSearchTimeout);
  const q = document.getElementById('popup-search-input').value.trim();
  popupSearchTimeout = setTimeout(() => {
    executeMasterSearch(q, 'popup-search-results', true);
  }, 200);
}

function quickSearch(keyword) {
  document.getElementById('dedicated-search-input').value = keyword;
  executeMasterSearch(keyword, 'master-search-results-container');
}

async function executeMasterSearch(query, targetContainerId, isModal = false) {
  const container = document.getElementById(targetContainerId);
  if (!query) {
    container.innerHTML = `
      <div class="text-center py-12 text-slate-400">
        <p class="text-xs">Type a keyword above to search all modules.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `<div class="text-center py-6 text-xs text-brand-600 font-semibold">Searching across all 5 databases for "${escapeHtml(query)}"...</div>`;

  try {
    const res = await apiFetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) return;
    const data = await res.json();

    if (data.totalResults === 0) {
      container.innerHTML = `
        <div class="text-center py-12 text-slate-400">
          <div class="w-10 h-10 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-2 text-slate-400">
            <i data-lucide="search-x" class="w-5 h-5"></i>
          </div>
          <h4 class="text-sm font-bold text-slate-700">No matching records</h4>
          <p class="text-xs text-slate-400 mt-0.5">Nothing found matching "${escapeHtml(query)}".</p>
        </div>
      `;
      lucide.createIcons();
      return;
    }

    let html = `<div class="text-xs font-semibold text-slate-400 mb-3">Found ${data.totalResults} matching results:</div>`;

    // 1. Assets
    if (data.assets && data.assets.length > 0) {
      html += `
        <div class="space-y-2 mb-4">
          <div class="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
            <i data-lucide="laptop" class="w-3.5 h-3.5 text-sky-500"></i>
            <span>IT Assets (${data.assets.length})</span>
          </div>
          <div class="grid grid-cols-1 gap-2">
            ${data.assets.map(a => `
              <div onclick="if(${isModal}){closeModal('modal-master-search');} viewAssetDetail(${a.id})" class="p-3 bg-white hover:bg-slate-50 border border-slate-200 rounded-xl cursor-pointer flex items-center justify-between transition-colors">
                <div>
                  <span class="font-mono font-bold text-brand-600 text-xs">#${escapeHtml(a.internal_serial_number)}</span>
                  <span class="font-bold text-slate-900 text-xs ml-1">${escapeHtml(a.brand)} ${escapeHtml(a.asset_type)}</span>
                  <div class="text-[11px] text-slate-500 mt-0.5">User: <strong>${escapeHtml(a.assigned_user || 'Unassigned')}</strong> • Dept: ${escapeHtml(a.department || '—')}</div>
                </div>
                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${a.working_status === 'Working' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}">${escapeHtml(a.working_status)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // 2. Repairs
    if (data.repairs && data.repairs.length > 0) {
      html += `
        <div class="space-y-2 mb-4">
          <div class="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
            <i data-lucide="wrench" class="w-3.5 h-3.5 text-amber-500"></i>
            <span>Maintenance & Parts (${data.repairs.length})</span>
          </div>
          <div class="grid grid-cols-1 gap-2">
            ${data.repairs.map(r => `
              <div onclick="if(${isModal}){closeModal('modal-master-search');} navigate('repairs', { search: '${r.ticket_number}' })" class="p-3 bg-white hover:bg-slate-50 border border-slate-200 rounded-xl cursor-pointer flex items-center justify-between transition-colors">
                <div>
                  <div class="font-mono font-bold text-brand-600 text-xs">${escapeHtml(r.ticket_number)} • Asset #${escapeHtml(r.internal_serial_number)}</div>
                  <div class="text-xs font-medium text-slate-800 mt-0.5">${escapeHtml(r.issue_description)}</div>
                  ${r.parts_added ? `<div class="text-[11px] font-semibold text-sky-600 mt-0.5">Parts: ${escapeHtml(r.parts_added)}</div>` : ''}
                </div>
                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">${escapeHtml(r.status)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // 3. Keys
    if (data.keys && data.keys.length > 0) {
      html += `
        <div class="space-y-2 mb-4">
          <div class="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
            <i data-lucide="shield-check" class="w-3.5 h-3.5 text-purple-500"></i>
            <span>Quick Heal Antivirus Keys (${data.keys.length})</span>
          </div>
          <div class="grid grid-cols-1 gap-2">
            ${data.keys.map(k => `
              <div onclick="if(${isModal}){closeModal('modal-master-search');} navigate('keys', { search: '${k.product_key}' })" class="p-3 bg-white hover:bg-slate-50 border border-slate-200 rounded-xl cursor-pointer flex items-center justify-between transition-colors">
                <div>
                  <div class="font-mono font-bold text-purple-700 text-xs">${escapeHtml(k.product_key)}</div>
                  <div class="text-[11px] text-slate-500 mt-0.5">Valid till: ${escapeHtml(k.validity_date || '—')} • Assigned: ${escapeHtml(k.assigned_user || (k.internal_serial_number ? '#' + k.internal_serial_number : 'Available in pool'))}</div>
                </div>
                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${k.status === 'Assigned' ? 'bg-purple-50 text-purple-700' : 'bg-emerald-50 text-emerald-700'}">${escapeHtml(k.status)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // 4. Accessories
    if (data.accessories && data.accessories.length > 0) {
      html += `
        <div class="space-y-2 mb-4">
          <div class="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
            <i data-lucide="mouse" class="w-3.5 h-3.5 text-emerald-500"></i>
            <span>Accessories (${data.accessories.length})</span>
          </div>
          <div class="grid grid-cols-1 gap-2">
            ${data.accessories.map(acc => `
              <div onclick="if(${isModal}){closeModal('modal-master-search');} navigate('accessories', { search: '${acc.accessory_code}' })" class="p-3 bg-white hover:bg-slate-50 border border-slate-200 rounded-xl cursor-pointer flex items-center justify-between transition-colors">
                <div>
                  <span class="font-mono font-bold text-brand-600 text-xs">${escapeHtml(acc.accessory_code)}</span>
                  <span class="font-bold text-slate-900 text-xs ml-1">${escapeHtml(acc.name)}</span>
                  <div class="text-[11px] text-slate-500 mt-0.5">Location: ${escapeHtml(acc.location || 'Store')} • Stock: ${acc.quantity} units</div>
                </div>
                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700">${escapeHtml(acc.status)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // 5. User Master Directory (Employees & Custodians)
    if (data.employees && data.employees.length > 0) {
      html += `
        <div class="space-y-2 mb-4">
          <div class="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
            <i data-lucide="users" class="w-3.5 h-3.5 text-violet-500"></i>
            <span>User Master Directory (${data.employees.length})</span>
          </div>
          <div class="grid grid-cols-1 gap-2">
            ${data.employees.map(emp => `
              <div onclick="if(${isModal}){closeModal('modal-master-search');} navigate('employees', { search: '${escapeHtml(emp.name)}' })" class="p-3 bg-white hover:bg-slate-50 border border-slate-200 rounded-xl cursor-pointer flex items-center justify-between transition-colors">
                <div>
                  <div class="font-bold text-slate-900 text-xs flex items-center gap-1.5">
                    <span>${escapeHtml(emp.name)}</span>
                    ${emp.designation ? `<span class="text-[11px] font-normal text-slate-500">• ${escapeHtml(emp.designation)}</span>` : ''}
                  </div>
                  <div class="text-[11px] text-slate-500 mt-0.5">Dept: ${escapeHtml(emp.department || '—')} • Location: ${escapeHtml(emp.location || 'Head Office')}</div>
                </div>
                <div class="text-right">
                  <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${emp.status === 'Active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}">${escapeHtml(emp.status || 'Active')}</span>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // 6. System Users (Login Accounts)
    if (data.users && data.users.length > 0) {
      html += `
        <div class="space-y-2 mb-4">
          <div class="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
            <i data-lucide="shield" class="w-3.5 h-3.5 text-indigo-500"></i>
            <span>System Users & Admins (${data.users.length})</span>
          </div>
          <div class="grid grid-cols-1 gap-2">
            ${data.users.map(u => `
              <div class="p-3 bg-white border border-slate-200 rounded-xl flex items-center justify-between">
                <div>
                  <div class="font-bold text-slate-900 text-xs">${escapeHtml(u.full_name)} (@${escapeHtml(u.username)})</div>
                  <div class="text-[11px] text-slate-500 mt-0.5">${escapeHtml(u.email || 'No email')}</div>
                </div>
                <span class="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase bg-slate-100 text-slate-700">${escapeHtml(u.role)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    container.innerHTML = html;
    lucide.createIcons();
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
      tr.className = 'hover:bg-slate-50/80 transition-colors';
      const isSelf = currentUser && currentUser.id === u.id;

      let roleBadge = `<span class="inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 border border-rose-200">ADMIN</span>`;
      if (u.role === 'technician') roleBadge = `<span class="inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-sky-50 text-sky-700 border border-sky-200">TECHNICIAN</span>`;
      else if (u.role === 'viewer') roleBadge = `<span class="inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200">VIEWER</span>`;

      tr.innerHTML = `
        <td class="py-3 px-4 font-bold text-slate-900">@${escapeHtml(u.username)} ${isSelf ? '<span class="ml-1 px-1.5 py-0.2 rounded text-[9px] font-bold bg-brand-50 text-brand-700">You</span>' : ''}</td>
        <td class="py-3 px-4 font-semibold text-slate-800">${escapeHtml(u.full_name)}</td>
        <td class="py-3 px-4 text-slate-500">${escapeHtml(u.email || '—')}</td>
        <td class="py-3 px-4">${roleBadge}</td>
        <td class="py-3 px-4">
          <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${u.status === 'active' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}">${escapeHtml(u.status)}</span>
        </td>
        <td class="py-3 px-4 text-slate-500">${new Date(u.created_at).toLocaleDateString()}</td>
        <td class="py-3 px-4 text-right">
          <div class="flex items-center justify-end gap-1">
            <button onclick="openResetPasswordModal(${u.id}, '${escapeHtml(u.username)}')" title="Reset Password" class="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors">
              <i data-lucide="key" class="w-4 h-4"></i>
            </button>
            <button onclick="openEditUserModal(${u.id})" title="Edit User" class="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors">
              <i data-lucide="pencil" class="w-4 h-4"></i>
            </button>
            ${!isSelf ? `
              <button onclick="deleteUser(${u.id}, '${escapeHtml(u.username)}')" title="Delete User" class="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
            ` : ''}
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    lucide.createIcons();
  } catch (err) {
    console.error('Users load error:', err);
  }
}

function openUserModal() {
  document.getElementById('form-user').reset();
  document.getElementById('user-form-id').value = '';
  document.getElementById('user-form-title').textContent = 'Add System User';
  document.getElementById('user-username').readOnly = false;
  const passInput = document.getElementById('user-password');
  passInput.required = true;
  passInput.type = 'password';
  const eye = document.getElementById('user-password-eye');
  if (eye) eye.setAttribute('data-lucide', 'eye');
  document.getElementById('user-password-label').textContent = 'Password *';
  openModal('modal-user-form');
  lucide.createIcons();
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

    const passInput = document.getElementById('user-password');
    passInput.required = false;
    passInput.type = 'password';
    passInput.value = '';
    const eye = document.getElementById('user-password-eye');
    if (eye) eye.setAttribute('data-lucide', 'eye');
    document.getElementById('user-password-label').textContent = 'New Password (Leave blank to keep current)';

    openModal('modal-user-form');
    lucide.createIcons();
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

function togglePasswordVisibility(inputId, iconId) {
  const input = document.getElementById(inputId);
  const icon = document.getElementById(iconId);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    if (icon) icon.setAttribute('data-lucide', 'eye-off');
  } else {
    input.type = 'password';
    if (icon) icon.setAttribute('data-lucide', 'eye');
  }
  lucide.createIcons();
}

function openResetPasswordModal(userId, username) {
  document.getElementById('reset-password-user-id').value = userId;
  const displayEl = document.getElementById('reset-password-user-display');
  if (displayEl) displayEl.textContent = `Set new login password for @${username}`;
  const input = document.getElementById('reset-new-password');
  input.value = '';
  input.type = 'password';
  const eye = document.getElementById('reset-password-eye');
  if (eye) eye.setAttribute('data-lucide', 'eye');
  openModal('modal-reset-password');
  setTimeout(() => {
    input.focus();
    lucide.createIcons();
  }, 100);
}

async function submitResetPassword(e) {
  e.preventDefault();
  const userId = document.getElementById('reset-password-user-id').value;
  const newPassword = document.getElementById('reset-new-password').value;

  if (!newPassword || newPassword.length < 6) {
    showToast('Password must be at least 6 characters long', 'error');
    return;
  }

  const btn = document.getElementById('btn-submit-reset-password');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="inline-flex items-center gap-1.5"><i data-lucide="loader" class="w-4 h-4 animate-spin"></i><span>Updating...</span></span>`;
    lucide.createIcons();
  }

  try {
    const res = await apiFetch(`/api/users/${userId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password: newPassword })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'Password successfully updated!', 'success');
      closeModal('modal-reset-password');
    } else {
      showToast(data.error || 'Failed to update password', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Update Password';
    }
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
      tbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-slate-400">No audit events recorded yet.</td></tr>`;
      return;
    }

    logs.forEach(log => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="py-2.5 px-4 text-slate-500 font-mono text-[11px]">${new Date(log.created_at).toLocaleString()}</td>
        <td class="py-2.5 px-4 font-bold text-slate-900">@${escapeHtml(log.username)}</td>
        <td class="py-2.5 px-4 font-bold text-brand-600">${escapeHtml(log.action)}</td>
        <td class="py-2.5 px-4 text-slate-500 uppercase text-[10px] font-bold">${escapeHtml(log.entity_type)}</td>
        <td class="py-2.5 px-4 text-slate-700 max-w-sm truncate">${escapeHtml(log.details)}</td>
      `;
      tbody.appendChild(tr);
    });

    lucide.createIcons();
  } catch (err) {
    console.error('Audit logs error:', err);
  }
}

// Download Database JSON Backup
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
    showToast('Database JSON backup generated and downloaded!', 'success');
  } catch (err) {
    showToast('Failed to generate backup: ' + err.message, 'error');
  }
}

// Danger Zone: Purge All Inventory Data
async function confirmPurgeInventory() {
  const confirmation = prompt(
    'WARNING: This will permanently delete ALL IT Assets, Repairs, Quick Heal Keys, Accessories, and Expenses.\n\nYour User accounts and password logins will remain safe and active.\n\nType PURGE to confirm and proceed:'
  );

  if (confirmation !== 'PURGE') {
    if (confirmation !== null) {
      showToast('Purge aborted: confirmation phrase did not match.', 'info');
    }
    return;
  }

  try {
    const res = await apiFetch('/api/admin/clear-inventory-data', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'PURGE_ALL_DATA' })
    });
    const data = await res.json();
    if (res.ok) {
      showToast('All operational inventory data has been purged successfully!', 'success');
      // Refresh views
      loadDashboard();
      loadAuditLogs();
    } else {
      showToast(data.error || 'Purge failed', 'error');
    }
  } catch (err) {
    showToast('Purge error: ' + err.message, 'error');
  }
}

// ==========================================
// 11. VIEW: USER MASTER (EMPLOYEE & CUSTODIAN DIRECTORY)
// ==========================================

let cachedEmployeesList = [];

async function fetchUserMasterList() {
  try {
    const res = await apiFetch('/api/employees');
    if (!res.ok) return [];
    const data = await res.json();
    cachedEmployeesList = data.employees || [];

    // Update sidebar User Master badge
    const badge = document.getElementById('sidebar-user-master-count');
    if (badge && data.stats) {
      badge.textContent = data.stats.total ?? cachedEmployeesList.length;
    }

    return cachedEmployeesList;
  } catch (err) {
    console.error('Error fetching user master list:', err);
    return [];
  }
}

// Populate the Assigned User dropdown select in Asset Form
async function populateUserSelect(selectedUserName = '') {
  const select = document.getElementById('asset-user');
  if (!select) return;

  const employees = await fetchUserMasterList();

  select.innerHTML = '<option value="">-- Select Assigned User from Master --</option>';

  let found = false;
  const selNorm = (selectedUserName || '').trim().toLowerCase();

  // Sort employees alphabetically by name
  const sorted = employees.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  sorted.forEach(emp => {
    const opt = document.createElement('option');
    opt.value = emp.name;
    const parts = [];
    if (emp.department) parts.push(emp.department);
    if (emp.location) parts.push(emp.location);
    if (emp.designation) parts.push(emp.designation);
    opt.textContent = parts.length > 0 ? `${emp.name} (${parts.join(' • ')})` : emp.name;
    if (selNorm && emp.name.trim().toLowerCase() === selNorm) {
      opt.selected = true;
      found = true;
    }
    select.appendChild(opt);
  });

  // If current asset has a user that's not in the employees list yet, keep it so it's not lost!
  if (selectedUserName && !found && selectedUserName !== '__NEW_USER__') {
    const opt = document.createElement('option');
    opt.value = selectedUserName;
    opt.textContent = `${selectedUserName} (Current User)`;
    opt.selected = true;
    select.insertBefore(opt, select.children[1] || null);
  }

  // Add the Quick Add option at the bottom
  const quickAddOpt = document.createElement('option');
  quickAddOpt.value = '__NEW_USER__';
  quickAddOpt.textContent = '➕ + Quick Add New User to Master...';
  quickAddOpt.className = 'font-bold text-brand-600 bg-brand-50';
  select.appendChild(quickAddOpt);

  if (selectedUserName) {
    select.value = selectedUserName;
  }

  // Bind change handler once
  if (!select._boundUserChange) {
    select._boundUserChange = true;
    select.addEventListener('change', () => {
      if (select.value === '__NEW_USER__') {
        select.value = select._lastSelectedUser || '';
        openQuickAddUserModal();
        return;
      }
      select._lastSelectedUser = select.value;
      const val = select.value.trim().toLowerCase();
      if (!val) return;
      const matched = (cachedEmployeesList || []).find(e => (e.name || '').trim().toLowerCase() === val);
      if (matched) {
        const deptEl = document.getElementById('asset-department');
        const locEl = document.getElementById('asset-location');
        if (deptEl && matched.department) deptEl.value = matched.department;
        if (locEl && matched.location) locEl.value = matched.location;
      }
    });
  }

  select._lastSelectedUser = select.value;
}

// Populate the Assigned User dropdown select in Accessory Form
async function populateAccessoryUserSelect(selectedUser = '') {
  const select = document.getElementById('assign-acc-user');
  if (!select) return;
  const employees = await fetchUserMasterList();
  select.innerHTML = '<option value="">-- Select Personnel from Master --</option>';
  const sorted = employees.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  sorted.forEach(emp => {
    const opt = document.createElement('option');
    opt.value = emp.name;
    const parts = [emp.department, emp.location].filter(Boolean).join(' • ');
    opt.textContent = parts ? `${emp.name} (${parts})` : emp.name;
    if (selectedUser && emp.name.trim().toLowerCase() === selectedUser.trim().toLowerCase()) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
  if (selectedUser) {
    select.value = selectedUser;
  }
  if (!select._boundLocChange) {
    select._boundLocChange = true;
    select.addEventListener('change', () => {
      const val = select.value.trim().toLowerCase();
      const matched = (cachedEmployeesList || []).find(e => (e.name || '').trim().toLowerCase() === val);
      if (matched && matched.location) {
        const locInput = document.getElementById('assign-acc-location');
        if (locInput) locInput.value = matched.location;
      }
    });
  }
}

function openQuickAddUserModal() {
  const form = document.getElementById('form-quick-add-user');
  if (form) form.reset();
  const currentAssetDept = document.getElementById('asset-department')?.value;
  if (currentAssetDept) {
    const quickDept = document.getElementById('quick-user-dept');
    if (quickDept) quickDept.value = currentAssetDept;
  }
  const currentAssetLoc = document.getElementById('asset-location')?.value;
  if (currentAssetLoc) {
    const quickLoc = document.getElementById('quick-user-location');
    if (quickLoc) quickLoc.value = currentAssetLoc;
  }
  openModal('modal-quick-add-user');
  setTimeout(() => {
    document.getElementById('quick-user-name')?.focus();
    lucide.createIcons();
  }, 60);
}

async function handleQuickAddUserSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('quick-user-name').value.trim();
  const department = document.getElementById('quick-user-dept').value;
  const designation = document.getElementById('quick-user-role').value.trim();
  const location = document.getElementById('quick-user-location').value.trim();
  const email = document.getElementById('quick-user-email').value.trim();
  const phone = document.getElementById('quick-user-phone').value.trim();

  if (!name) {
    showToast('User name is required', 'error');
    return;
  }

  const btn = e.target.querySelector('button[type=submit]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Adding...';
  }

  try {
    const res = await apiFetch('/api/employees', {
      method: 'POST',
      body: JSON.stringify({
        name,
        department,
        designation,
        location,
        email,
        phone,
        status: 'Active'
      })
    });

    const data = await res.json();
    if (res.ok) {
      showToast(`User '${name}' added to Master and selected!`, 'success');
      closeModal('modal-quick-add-user');

      // Refresh master list and re-populate the dropdown with new user selected
      await fetchUserMasterList();
      await populateUserSelect(name);

      // Auto-fill department & location into asset form
      const deptInput = document.getElementById('asset-department');
      if (deptInput && department) deptInput.value = department;
      const locInput = document.getElementById('asset-location');
      if (locInput && location) locInput.value = location;

      // Also if assign-acc-user modal is open, re-populate and select
      const accSelect = document.getElementById('assign-acc-user');
      if (accSelect && accSelect.offsetParent !== null) {
        await populateAccessoryUserSelect(name);
      }
    } else {
      showToast(data.error || 'Failed to add user', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Network error', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Add to Master & Select';
    }
  }
}

let employeeSearchTimeout = null;
function debounceEmployeeSearch() {
  clearTimeout(employeeSearchTimeout);
  employeeSearchTimeout = setTimeout(() => loadEmployees(), 250);
}

function filterEmployeesByPrinter(printerStatus) {
  const filterEl = document.getElementById('employee-filter-printer');
  if (filterEl) {
    filterEl.value = printerStatus || 'all';
  }
  loadEmployees();
}

function resetEmployeeFilterUI(params = {}) {
  const searchInput = document.getElementById('employee-search-input');
  const deptFilter = document.getElementById('employee-filter-dept');
  const printerFilter = document.getElementById('employee-filter-printer');
  if (searchInput) searchInput.value = params.search || '';
  if (deptFilter) deptFilter.value = params.department || 'all';
  if (printerFilter) printerFilter.value = params.printer || params.has_printer || 'all';
}

async function loadEmployees(filterParams = {}) {
  try {
    const search = filterParams.search !== undefined ? filterParams.search : document.getElementById('employee-search-input')?.value || '';
    const dept = filterParams.department !== undefined ? filterParams.department : document.getElementById('employee-filter-dept')?.value || 'all';
    const printer = filterParams.has_printer !== undefined ? filterParams.has_printer : document.getElementById('employee-filter-printer')?.value || 'all';

    const params = new URLSearchParams();
    if (search) params.append('search', search);
    if (dept && dept !== 'all') params.append('department', dept);
    if (printer && printer !== 'all') params.append('has_printer', printer);

    const res = await apiFetch(`/api/employees?${params.toString()}`);
    if (!res.ok) return;
    const data = await res.json();

    // Update KPI metric cards
    if (data.stats) {
      const totalEl = document.getElementById('emp-stat-total');
      const withPrintersEl = document.getElementById('emp-stat-with-printers');
      const withoutPrintersEl = document.getElementById('emp-stat-without-printers');
      const workstationsEl = document.getElementById('emp-stat-workstations');
      if (totalEl) totalEl.textContent = data.stats.total ?? 0;
      if (withPrintersEl) withPrintersEl.textContent = data.stats.with_printers ?? 0;
      if (withoutPrintersEl) withoutPrintersEl.textContent = data.stats.without_printers ?? 0;
      if (workstationsEl) workstationsEl.textContent = data.stats.workstations_assigned ?? 0;

      const sidebarUserMasterEl = document.getElementById('sidebar-user-master-count');
      if (sidebarUserMasterEl) sidebarUserMasterEl.textContent = data.stats.total ?? 0;
    }

    renderEmployeesTable(data.employees || []);
  } catch (err) {
    console.error('Error loading employees:', err);
  }
}

function renderEmployeesTable(employees) {
  const tbody = document.getElementById('employees-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!employees || employees.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-12 text-center text-slate-400">No personnel found matching the filter criteria.</td></tr>`;
    return;
  }

  const isViewer = currentUser?.role === 'viewer';
  const isAdmin = currentUser?.role === 'admin';

  employees.forEach(emp => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-50/80 transition-colors';

    // Workstations list / chips
    const wsList = emp.workstations || [];
    let wsDisplay = '';
    if (emp.workstation_count > 0) {
      wsDisplay = `
        <div class="space-y-1">
          <div class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-sky-50 text-sky-700 border border-sky-200">
            <i data-lucide="monitor" class="w-3 h-3"></i>
            <span>${emp.workstation_count} Workstation${emp.workstation_count > 1 ? 's' : ''}</span>
          </div>
          <div class="flex flex-wrap gap-1 max-w-xs">
            ${wsList.map(w => `
              <span onclick="viewAssetDetail(${w.id})" class="cursor-pointer font-mono font-bold text-[11px] text-brand-600 hover:underline bg-brand-50/60 px-1.5 py-0.5 rounded border border-brand-100" title="${escapeHtml(w.brand || '')} ${escapeHtml(w.asset_type)}">
                #${escapeHtml(w.internal_serial_number)}
              </span>
            `).join('')}
          </div>
        </div>
      `;
    } else {
      wsDisplay = `<span class="text-slate-400 text-xs">— No PC —</span>`;
    }

    // Printers list / breakdown
    const prList = emp.printers || [];
    let prDisplay = '';
    if (emp.has_printer) {
      prDisplay = `
        <div class="space-y-1">
          <div class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-300">
            <i data-lucide="printer" class="w-3 h-3 text-amber-600"></i>
            <span>${emp.printer_count} Printer${emp.printer_count > 1 ? 's' : ''}</span>
          </div>
          <div class="flex flex-wrap gap-1 max-w-xs">
            ${prList.map(p => `
              <span onclick="viewAssetDetail(${p.id})" class="cursor-pointer font-medium text-[11px] text-amber-900 bg-amber-100/70 hover:bg-amber-200/80 px-1.5 py-0.5 rounded border border-amber-300/80 transition-colors" title="${escapeHtml(p.brand || '')} ${escapeHtml(p.model_name || '')}">
                #${escapeHtml(p.internal_serial_number)} (${escapeHtml(p.asset_type)})
              </span>
            `).join('')}
          </div>
        </div>
      `;
    } else {
      prDisplay = `<span class="inline-flex items-center gap-1 text-[11px] text-slate-400 font-medium"><i data-lucide="minus" class="w-3 h-3"></i>Standalone</span>`;
    }

    // Accessories
    const accCount = emp.accessories_count || 0;
    const accDisplay = accCount > 0
      ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">${accCount} Issued</span>`
      : `<span class="text-slate-400 text-xs">0</span>`;

    // Status badge
    const statusBadge = emp.status === 'Active'
      ? `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">Active</span>`
      : `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-200">Inactive</span>`;

    tr.innerHTML = `
      <td class="py-3 px-4">
        <div class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-xl bg-violet-100 text-violet-700 flex items-center justify-center font-bold text-xs flex-shrink-0">
            ${escapeHtml((emp.name || 'U').charAt(0).toUpperCase())}
          </div>
          <div>
            <div class="font-bold text-slate-900 text-xs flex items-center gap-1.5">
              <span>${escapeHtml(emp.name)}</span>
              ${emp.designation ? `<span class="text-[10px] font-semibold text-slate-500">• ${escapeHtml(emp.designation)}</span>` : ''}
            </div>
            <div class="text-[10px] text-slate-400 mt-0.5">
              ${emp.phone ? `📞 ${escapeHtml(emp.phone)}` : ''}
              ${emp.email ? `✉️ ${escapeHtml(emp.email)}` : ''}
              ${!emp.phone && !emp.email ? 'No contact recorded' : ''}
            </div>
          </div>
        </div>
      </td>
      <td class="py-3 px-4">
        <div class="font-semibold text-slate-800 text-xs">${escapeHtml(emp.department || '—')}</div>
        <div class="text-[11px] text-slate-400">${escapeHtml(emp.location || '—')}</div>
      </td>
      <td class="py-3 px-4">${wsDisplay}</td>
      <td class="py-3 px-4">${prDisplay}</td>
      <td class="py-3 px-4">${accDisplay}</td>
      <td class="py-3 px-4">${statusBadge}</td>
      <td class="py-3 px-4 text-right">
        <div class="flex items-center justify-end gap-1">
          <button onclick="viewUserAssets(${emp.id})" title="View Hardware Profile & Dossier" class="p-1.5 text-violet-600 hover:text-violet-700 hover:bg-violet-50 rounded-lg transition-colors">
            <i data-lucide="eye" class="w-4 h-4"></i>
          </button>
          ${!isViewer ? `
            <button onclick="openEmployeeModal(${emp.id})" title="Edit User Details" class="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-slate-100 rounded-lg transition-colors">
              <i data-lucide="pencil" class="w-4 h-4"></i>
            </button>
          ` : ''}
          ${isAdmin ? `
            <button onclick="deleteEmployee(${emp.id}, '${escapeHtml(emp.name)}')" title="Delete from Master" class="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          ` : ''}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  lucide.createIcons();
}

async function openEmployeeModal(empId = null) {
  const form = document.getElementById('form-employee');
  if (form) form.reset();
  document.getElementById('employee-form-id').value = '';
  document.getElementById('employee-status').value = 'Active';

  if (!empId) {
    document.getElementById('employee-form-title').textContent = 'Add User to Master';
    openModal('modal-employee-form');
    return;
  }

  try {
    const res = await apiFetch(`/api/employees/${empId}`);
    if (!res.ok) return;
    const { employee } = await res.json();

    document.getElementById('employee-form-title').textContent = `Edit User: ${employee.name}`;
    document.getElementById('employee-form-id').value = employee.id;
    document.getElementById('employee-name').value = employee.name || '';
    document.getElementById('employee-department').value = employee.department || 'Orders';
    document.getElementById('employee-designation').value = employee.designation || '';
    document.getElementById('employee-location').value = employee.location || '';
    document.getElementById('employee-status').value = employee.status || 'Active';
    document.getElementById('employee-email').value = employee.email || '';
    document.getElementById('employee-phone').value = employee.phone || '';
    document.getElementById('employee-notes').value = employee.notes || '';

    openModal('modal-employee-form');
  } catch (err) {
    console.error('Error opening employee modal:', err);
  }
}

async function handleEmployeeSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('employee-form-id').value;
  const btn = document.getElementById('btn-save-employee');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  const payload = {
    name: document.getElementById('employee-name').value.trim(),
    department: document.getElementById('employee-department').value,
    designation: document.getElementById('employee-designation').value.trim(),
    location: document.getElementById('employee-location').value.trim(),
    status: document.getElementById('employee-status').value,
    email: document.getElementById('employee-email').value.trim(),
    phone: document.getElementById('employee-phone').value.trim(),
    notes: document.getElementById('employee-notes').value.trim()
  };

  try {
    const url = id ? `/api/employees/${id}` : '/api/employees';
    const method = id ? 'PUT' : 'POST';

    const res = await apiFetch(url, {
      method,
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'User saved to Master!', 'success');
      closeModal('modal-employee-form');
      loadEmployees();
      fetchUserMasterList();
      updateGlobalSidebarCounters();
    } else {
      showToast(data.error || 'Failed to save user', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Network error', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save User Details';
  }
}

async function deleteEmployee(empId, name) {
  if (!confirm(`Are you sure you want to remove '${name}' from User Master?\n\nNote: If this user has assets assigned, you must reassign or unassign them first.`)) {
    return;
  }
  try {
    const res = await apiFetch(`/api/employees/${empId}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'User deleted from Master', 'success');
      loadEmployees();
      fetchUserMasterList();
      updateGlobalSidebarCounters();
    } else {
      showToast(data.error || 'Failed to delete user', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Network error', 'error');
  }
}

async function viewUserAssets(empId) {
  try {
    const res = await apiFetch(`/api/employees/${empId}`);
    if (!res.ok) return;
    const data = await res.json();
    const { employee: emp, assigned_workstations: ws, assigned_printers: pr, assigned_accessories: acc, assigned_keys: keys } = data;

    document.getElementById('user-assets-avatar').textContent = (emp.name || 'U').charAt(0).toUpperCase();
    document.getElementById('user-assets-name').textContent = emp.name;
    document.getElementById('user-assets-sub').textContent = `${emp.designation || 'Personnel'} • Dept: ${emp.department || 'N/A'} • Location: ${emp.location || 'Main Office'}`;

    const body = document.getElementById('user-assets-body');
    body.innerHTML = `
      <!-- User Profile Header Card -->
      <div class="p-4 rounded-2xl bg-violet-50/70 border border-violet-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="space-y-1">
          <div class="flex items-center gap-2 flex-wrap">
            <h4 class="text-sm font-bold text-violet-950">${escapeHtml(emp.name)}</h4>
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${emp.status === 'Active' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'}">${escapeHtml(emp.status)}</span>
            ${emp.designation ? `<span class="text-xs text-violet-800 font-semibold">• ${escapeHtml(emp.designation)}</span>` : ''}
          </div>
          <div class="text-xs text-violet-800 flex items-center gap-3 flex-wrap">
            <span><strong>Dept:</strong> ${escapeHtml(emp.department || '—')}</span>
            <span><strong>Location:</strong> ${escapeHtml(emp.location || '—')}</span>
            ${emp.email ? `<span><strong>Email:</strong> ${escapeHtml(emp.email)}</span>` : ''}
            ${emp.phone ? `<span><strong>Phone:</strong> ${escapeHtml(emp.phone)}</span>` : ''}
          </div>
          ${emp.notes ? `<p class="text-xs text-violet-700 italic mt-1">“${escapeHtml(emp.notes)}”</p>` : ''}
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <button onclick="closeModal('modal-user-assets'); openEmployeeModal(${emp.id})" class="px-3 py-1.5 rounded-xl text-xs font-semibold text-violet-700 bg-white hover:bg-violet-100 border border-violet-200 shadow-xs">
            Edit Profile
          </button>
          <button onclick="closeModal('modal-user-assets'); openNewAssetModalWithPrefill({ assigned_user: '${escapeHtml(emp.name)}', department: '${escapeHtml(emp.department || '')}', location: '${escapeHtml(emp.location || '')}' })" class="px-3 py-1.5 rounded-xl text-xs font-semibold text-white bg-violet-600 hover:bg-violet-500 shadow-sm">
            + Assign IT Asset
          </button>
        </div>
      </div>

      <!-- Workstations Breakdown -->
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="w-7 h-7 rounded-lg bg-sky-100 text-sky-700 flex items-center justify-center font-bold text-xs">
              <i data-lucide="monitor" class="w-4 h-4"></i>
            </div>
            <h4 class="text-xs font-bold uppercase tracking-wider text-slate-800">Assigned Workstations (${ws.length})</h4>
          </div>
          <button onclick="closeModal('modal-user-assets'); openNewAssetModalWithPrefill({ asset_type: 'Desktop', assigned_user: '${escapeHtml(emp.name)}', department: '${escapeHtml(emp.department || '')}', location: '${escapeHtml(emp.location || '')}' })" class="text-xs text-sky-600 hover:text-sky-700 font-bold hover:underline">
            + Add PC
          </button>
        </div>

        ${ws.length > 0 ? `
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${ws.map(w => `
              <div class="p-3.5 rounded-xl bg-white border border-slate-200 shadow-xs hover:border-sky-300 transition-colors flex flex-col justify-between">
                <div>
                  <div class="flex items-center justify-between">
                    <span class="font-mono font-bold text-brand-600 text-xs cursor-pointer hover:underline" onclick="closeModal('modal-user-assets'); viewAssetDetail(${w.id});">
                      #${escapeHtml(w.internal_serial_number)}
                    </span>
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold ${w.working_status === 'Working' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}">
                      ${escapeHtml(w.working_status)}
                    </span>
                  </div>
                  <div class="font-bold text-xs text-slate-900 mt-1">${escapeHtml(w.brand || '')} ${escapeHtml(w.model_name || w.asset_type)}</div>
                  <div class="text-[11px] text-slate-500 mt-0.5">${escapeHtml(w.asset_type)} • Loc: ${escapeHtml(w.location || emp.location || 'Office Floor')}</div>
                  ${w.quick_heal_key_str ? `
                    <div class="mt-2 text-[10px] font-semibold text-purple-700 bg-purple-50 px-2 py-0.5 rounded border border-purple-200 flex items-center gap-1">
                      <i data-lucide="shield-check" class="w-3 h-3 text-purple-600"></i>
                      <span>Key: ${escapeHtml(w.quick_heal_key_str)}</span>
                    </div>
                  ` : `
                    <div class="mt-2 text-[10px] font-semibold text-rose-700 bg-rose-50 px-2 py-0.5 rounded border border-rose-200 flex items-center gap-1">
                      <i data-lucide="shield-alert" class="w-3 h-3 text-rose-600"></i>
                      <span>Unprotected (No Quick Heal Key)</span>
                    </div>
                  `}
                </div>
                <div class="mt-3 pt-2 border-t border-slate-100 flex items-center justify-end">
                  <button onclick="closeModal('modal-user-assets'); viewAssetDetail(${w.id});" class="text-xs font-semibold text-sky-700 hover:text-sky-900 underline">
                    View Asset Dossier &rarr;
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
        ` : `
          <div class="p-4 bg-slate-50 border border-slate-200 rounded-xl text-center text-xs text-slate-500">
            No PC or laptop workstation currently assigned to ${escapeHtml(emp.name)}.
          </div>
        `}
      </div>

      <!-- Printers & Scanners Breakdown -->
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="w-7 h-7 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center font-bold text-xs">
              <i data-lucide="printer" class="w-4 h-4"></i>
            </div>
            <h4 class="text-xs font-bold uppercase tracking-wider text-slate-800">Assigned Printers & Scanners (${pr.length})</h4>
          </div>
          <button onclick="closeModal('modal-user-assets'); openNewAssetModalWithPrefill({ asset_type: 'Tag Printer', assigned_user: '${escapeHtml(emp.name)}', department: '${escapeHtml(emp.department || '')}', location: '${escapeHtml(emp.location || '')}' })" class="text-xs text-amber-700 hover:text-amber-800 font-bold hover:underline">
            + Add Printer
          </button>
        </div>

        ${pr.length > 0 ? `
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            ${pr.map(p => `
              <div class="p-3.5 rounded-xl bg-white border border-amber-200 shadow-xs hover:border-amber-400 transition-colors flex flex-col justify-between">
                <div>
                  <div class="flex items-center justify-between">
                    <span class="font-mono font-bold text-brand-600 text-xs cursor-pointer hover:underline" onclick="closeModal('modal-user-assets'); viewAssetDetail(${p.id});">
                      #${escapeHtml(p.internal_serial_number)}
                    </span>
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold ${p.working_status === 'Working' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}">
                      ${escapeHtml(p.working_status)}
                    </span>
                  </div>
                  <div class="flex items-center gap-2 mt-1">
                    <span class="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 font-bold text-[10px] border border-amber-300/60">${escapeHtml(p.asset_type)}</span>
                    <span class="font-bold text-xs text-slate-900">${escapeHtml(p.brand || '')} ${escapeHtml(p.model_name || '')}</span>
                  </div>
                  ${p.serial_number ? `<div class="text-[10px] font-mono text-slate-500 mt-1">S/N: ${escapeHtml(p.serial_number)}</div>` : ''}
                  ${p.remarks ? `<p class="text-[11px] text-slate-600 mt-1.5 italic line-clamp-2">“${escapeHtml(p.remarks)}”</p>` : ''}
                </div>
                <div class="mt-3 pt-2 border-t border-slate-100 flex items-center justify-between text-[11px]">
                  <span class="text-slate-400 text-[10px]">${escapeHtml(p.location || emp.location || 'Same desk')}</span>
                  <button onclick="closeModal('modal-user-assets'); viewAssetDetail(${p.id});" class="text-xs font-semibold text-amber-700 hover:text-amber-900 underline">
                    View Printer Dossier &rarr;
                  </button>
                </div>
              </div>
            `).join('')}
          </div>
        ` : `
          <div class="p-4 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between gap-3">
            <div class="text-xs text-slate-600">
              <span class="font-semibold text-slate-800">Standalone User:</span> ${escapeHtml(emp.name)} does not have any dedicated printer assigned.
            </div>
            <button onclick="closeModal('modal-user-assets'); openNewAssetModalWithPrefill({ asset_type: 'Tag Printer', assigned_user: '${escapeHtml(emp.name)}', department: '${escapeHtml(emp.department || '')}', location: '${escapeHtml(emp.location || '')}' })" class="px-3 py-1.5 rounded-xl text-xs font-semibold text-amber-800 bg-amber-100 hover:bg-amber-200 flex-shrink-0">
              + Assign Printer
            </button>
          </div>
        `}
      </div>

      <!-- Issued Accessories Breakdown -->
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="w-7 h-7 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-xs">
              <i data-lucide="mouse" class="w-4 h-4"></i>
            </div>
            <h4 class="text-xs font-bold uppercase tracking-wider text-slate-800">Issued Accessories & Peripherals (${acc.length})</h4>
          </div>
          <button onclick="closeModal('modal-user-assets'); navigate('accessories');" class="text-xs text-indigo-600 hover:text-indigo-700 font-bold hover:underline">
            Manage Accessories &rarr;
          </button>
        </div>

        ${acc.length > 0 ? `
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            ${acc.map(a => `
              <div class="p-3 rounded-xl bg-white border border-slate-200 shadow-xs flex items-center justify-between">
                <div>
                  <div class="flex items-center gap-1.5">
                    <span class="font-mono font-bold text-brand-600 text-xs">${escapeHtml(a.accessory_code || '')}</span>
                    <span class="font-bold text-xs text-slate-900">${escapeHtml(a.name)}</span>
                  </div>
                  <div class="text-[11px] text-slate-500 mt-0.5">${escapeHtml(a.category)} • Qty: <strong>${a.quantity}</strong> ${a.remarks ? '• ' + escapeHtml(a.remarks) : ''}</div>
                </div>
                <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">${escapeHtml(a.status || 'Assigned')}</span>
              </div>
            `).join('')}
          </div>
        ` : `
          <div class="p-4 bg-slate-50 border border-slate-200 rounded-xl text-center text-xs text-slate-500">
            No peripherals or accessories specifically issued to ${escapeHtml(emp.name)}.
          </div>
        `}
      </div>
    `;

    openModal('modal-user-assets');
    lucide.createIcons();
  } catch (err) {
    console.error('Error viewing user assets:', err);
  }
}

// ==========================================
// 10. VIEW: DEPARTMENT MASTER & BREAKDOWN
// ==========================================

let cachedDepartmentsList = [];

async function fetchDepartmentsList(force = false) {
  if (!force && cachedDepartmentsList && cachedDepartmentsList.length > 0) {
    return cachedDepartmentsList;
  }
  try {
    const res = await apiFetch('/api/departments');
    if (!res.ok) return [];
    const data = await res.json();
    cachedDepartmentsList = data.departments || [];
    return cachedDepartmentsList;
  } catch (err) {
    console.error('fetchDepartmentsList error:', err);
    return [];
  }
}

// Dynamically populate all department dropdowns across the application
async function populateDepartmentDropdowns(selectedDept = '') {
  try {
    const depts = await fetchDepartmentsList();
    const sorted = depts.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // 1. Form dropdowns (Asset Form, Quick Add User, Employee Form)
    const formSelectIds = ['asset-department', 'quick-user-dept', 'emp-department'];
    formSelectIds.forEach(id => {
      const select = document.getElementById(id);
      if (!select) return;

      const currentVal = selectedDept || select.value || '';
      select.innerHTML = '<option value="">-- Select Department from Master --</option>';

      let found = false;
      sorted.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.name;
        opt.textContent = d.code ? `${d.name} [${d.code}]` : d.name;
        if (currentVal && d.name.trim().toLowerCase() === currentVal.trim().toLowerCase()) {
          opt.selected = true;
          found = true;
        }
        select.appendChild(opt);
      });

      // Preserve current custom value if not yet in master
      if (currentVal && !found && currentVal !== '__NEW_DEPT__') {
        const opt = document.createElement('option');
        opt.value = currentVal;
        opt.textContent = `${currentVal} (Current)`;
        opt.selected = true;
        select.insertBefore(opt, select.children[1] || null);
      }

      // Add Quick Add option at the bottom
      const quickAddOpt = document.createElement('option');
      quickAddOpt.value = '__NEW_DEPT__';
      quickAddOpt.textContent = '➕ + Quick Add New Department to Master...';
      quickAddOpt.className = 'font-bold text-pink-600 bg-pink-50';
      select.appendChild(quickAddOpt);

      if (!select._boundDeptChange) {
        select._boundDeptChange = true;
        select.addEventListener('change', () => {
          if (select.value === '__NEW_DEPT__') {
            select.value = select._lastSelectedDept || '';
            openDepartmentModal();
            return;
          }
          select._lastSelectedDept = select.value;
        });
      }
      select._lastSelectedDept = select.value;
    });

    // 2. Filter dropdowns (Asset List filter, Employee List filter)
    const filterSelectIds = ['asset-filter-dept', 'employee-filter-dept'];
    filterSelectIds.forEach(id => {
      const select = document.getElementById(id);
      if (!select) return;

      const currentVal = select.value || 'all';
      select.innerHTML = '<option value="all">All Departments</option>';

      sorted.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.name;
        opt.textContent = d.code ? `${d.name} [${d.code}]` : d.name;
        if (currentVal && (d.name.trim().toLowerCase() === currentVal.trim().toLowerCase() || currentVal === d.name)) {
          opt.selected = true;
        }
        select.appendChild(opt);
      });
    });
  } catch (err) {
    console.error('populateDepartmentDropdowns error:', err);
  }
}

function resetDepartmentFilterUI(overrides = {}) {
  const s = document.getElementById('dept-search-input');
  if (s) s.value = overrides.search || '';
}

let deptSearchTimeout = null;
function debounceDeptSearch() {
  clearTimeout(deptSearchTimeout);
  deptSearchTimeout = setTimeout(() => {
    loadDepartments({ search: document.getElementById('dept-search-input')?.value || '' });
  }, 250);
}

// Load and render Department Master
async function loadDepartments(filterParams = {}) {
  try {
    const search = filterParams.search !== undefined ? filterParams.search : document.getElementById('dept-search-input')?.value || '';

    const params = new URLSearchParams();
    if (search) params.append('search', search);

    const res = await apiFetch(`/api/departments?${params.toString()}`);
    if (!res.ok) return;

    const data = await res.json();
    cachedDepartmentsList = data.departments || [];

    // Update KPI metric counters
    const totalEl = document.getElementById('dept-stat-total');
    if (totalEl) totalEl.textContent = data.stats?.total_departments ?? cachedDepartmentsList.length;

    const assetsEl = document.getElementById('dept-stat-assets');
    if (assetsEl) assetsEl.textContent = data.stats?.total_department_assets ?? 0;

    const personnelEl = document.getElementById('dept-stat-personnel');
    if (personnelEl) personnelEl.textContent = data.stats?.total_department_personnel ?? 0;

    const valueEl = document.getElementById('dept-stat-value');
    if (valueEl) {
      const val = data.stats?.total_department_value ?? 0;
      valueEl.textContent = `₹${val.toLocaleString('en-IN')}`;
    }

    const indicatorEl = document.getElementById('dept-count-indicator');
    if (indicatorEl) {
      indicatorEl.textContent = `Showing ${cachedDepartmentsList.length} department(s)`;
    }

    // Update sidebar badge
    const badge = document.getElementById('sidebar-dept-count');
    if (badge && data.stats) {
      badge.textContent = data.stats.total_departments ?? cachedDepartmentsList.length;
    }

    renderDepartmentsGrid(cachedDepartmentsList);
  } catch (err) {
    console.error('loadDepartments error:', err);
  }
}

// Render Department Grid Cards
function renderDepartmentsGrid(departments) {
  const container = document.getElementById('departments-grid');
  if (!container) return;

  container.innerHTML = '';

  if (!departments || departments.length === 0) {
    container.innerHTML = `
      <div class="col-span-full py-16 text-center bg-white border border-slate-200/80 rounded-2xl shadow-sm">
        <div class="w-12 h-12 rounded-2xl bg-pink-50 text-pink-600 flex items-center justify-center mx-auto mb-3">
          <i data-lucide="building-2" class="w-6 h-6"></i>
        </div>
        <h4 class="text-sm font-bold text-slate-800">No Departments Found</h4>
        <p class="text-xs text-slate-400 mt-1 max-w-sm mx-auto">Create your first department in Department Master to organize assets and personnel.</p>
        <button onclick="openDepartmentModal()" class="mt-4 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-pink-600 hover:bg-pink-500 shadow-md shadow-pink-500/20 cursor-pointer">
          + Add New Department
        </button>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  const isAdmin = currentUser?.role === 'admin';
  const isViewer = currentUser?.role === 'viewer';

  departments.forEach(d => {
    const stats = d.stats || {
      total_assets: 0,
      working: 0,
      in_repair: 0,
      not_working: 0,
      retired: 0,
      total_personnel: 0,
      active_custodians_count: 0,
      total_value: 0,
      asset_types: {}
    };

    const card = document.createElement('div');
    card.className = 'p-5 rounded-2xl bg-white border border-slate-200/80 shadow-sm hover:shadow-md hover:border-pink-300 transition-all flex flex-col justify-between space-y-4';

    // Build hardware types chips
    const typeEntries = Object.entries(stats.asset_types || {});
    let typeBadges = '';
    if (typeEntries.length > 0) {
      typeBadges = typeEntries.slice(0, 4).map(([tName, count]) => `
        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200">
          <span>${escapeHtml(tName)}:</span>
          <span class="font-mono text-brand-600">${count}</span>
        </span>
      `).join('');
      if (typeEntries.length > 4) {
        typeBadges += `<span class="text-[10px] font-bold text-slate-400 self-center">+${typeEntries.length - 4} more</span>`;
      }
    } else {
      typeBadges = `<span class="text-[11px] text-slate-400 italic">No hardware assets allocated yet</span>`;
    }

    card.innerHTML = `
      <div class="space-y-3">
        <!-- Top header row -->
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-center gap-2.5">
            <div class="w-10 h-10 rounded-xl bg-pink-50 text-pink-600 flex items-center justify-center font-bold flex-shrink-0 shadow-xs">
              <i data-lucide="building-2" class="w-5 h-5"></i>
            </div>
            <div>
              <div class="flex items-center gap-2 flex-wrap">
                <h3 class="font-bold text-sm text-slate-900 leading-tight">${escapeHtml(d.name)}</h3>
                ${d.code ? `<span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-pink-100 text-pink-800">${escapeHtml(d.code)}</span>` : ''}
              </div>
              <div class="text-[11px] text-slate-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                <span>📍 ${escapeHtml(d.location || 'Main Facility')}</span>
                ${d.head_of_department ? `<span>• 👤 Lead: <strong>${escapeHtml(d.head_of_department)}</strong></span>` : ''}
              </div>
            </div>
          </div>
          ${!isViewer ? `
            <div class="flex items-center gap-1 flex-shrink-0">
              <button onclick="openEditDepartmentModal(${d.id})" title="Edit Department" class="p-1.5 text-slate-400 hover:text-pink-600 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer">
                <i data-lucide="pencil" class="w-4 h-4"></i>
              </button>
              ${isAdmin ? `
                <button onclick="deleteDepartment(${d.id}, '${escapeHtml(d.name)}')" title="Delete Department" class="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer">
                  <i data-lucide="trash-2" class="w-4 h-4"></i>
                </button>
              ` : ''}
            </div>
          ` : ''}
        </div>

        ${d.description ? `
          <p class="text-xs text-slate-600 font-normal line-clamp-2">${escapeHtml(d.description)}</p>
        ` : ''}

        <!-- Breakdown KPI Mini Grid -->
        <div class="grid grid-cols-3 gap-2 p-2.5 rounded-xl bg-slate-50 border border-slate-200/70 text-center">
          <div>
            <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Total Assets</span>
            <span class="text-sm font-black font-mono text-slate-900">${stats.total_assets}</span>
            <div class="text-[9px] text-emerald-600 font-semibold mt-0.5">${stats.working} Working</div>
          </div>
          <div>
            <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Personnel</span>
            <span class="text-sm font-black font-mono text-violet-600">${stats.total_personnel}</span>
            <div class="text-[9px] text-slate-500 font-medium mt-0.5">${stats.active_custodians_count} Users</div>
          </div>
          <div>
            <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Asset Value</span>
            <span class="text-sm font-black font-mono text-emerald-600">₹${stats.total_value >= 1000 ? (stats.total_value / 1000).toFixed(0) + 'k' : stats.total_value}</span>
            <div class="text-[9px] text-slate-400 font-medium mt-0.5">Fleet Cost</div>
          </div>
        </div>

        <!-- Asset Types Chips -->
        <div class="space-y-1">
          <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Hardware Breakdown:</span>
          <div class="flex items-center gap-1.5 flex-wrap">
            ${typeBadges}
          </div>
        </div>
      </div>

      <!-- Action Button -->
      <div class="pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
        <button onclick="viewDepartmentDetail(${d.id})" class="w-full inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold text-pink-700 bg-pink-50 hover:bg-pink-100 border border-pink-200/80 transition-colors cursor-pointer shadow-2xs">
          <i data-lucide="bar-chart-2" class="w-3.5 h-3.5"></i>
          <span>View Department Breakdown Dossier &rarr;</span>
        </button>
      </div>
    `;

    container.appendChild(card);
  });

  lucide.createIcons();
}

// View Department Detail & Deep Breakdown Modal
async function viewDepartmentDetail(deptId) {
  try {
    const res = await apiFetch(`/api/departments/${deptId}`);
    if (!res.ok) return;

    const data = await res.json();
    const { department: dept, stats, assets, employees } = data;

    document.getElementById('dept-detail-title').textContent = dept.name;
    const codeEl = document.getElementById('dept-detail-code');
    if (codeEl) codeEl.textContent = dept.code || 'DEPT';
    document.getElementById('dept-detail-sub').textContent = `Lead: ${dept.head_of_department || 'Unassigned'} • Location: ${dept.location || 'Main Office'} • Total Value: ₹${(stats.total_value || 0).toLocaleString('en-IN')}`;

    const body = document.getElementById('dept-detail-body');
    const workingPct = stats.total_assets > 0 ? Math.round((stats.working / stats.total_assets) * 100) : 0;
    const repairPct = stats.total_assets > 0 ? Math.round((stats.in_repair / stats.total_assets) * 100) : 0;
    const notWorkingPct = stats.total_assets > 0 ? Math.round((stats.not_working / stats.total_assets) * 100) : 0;

    body.innerHTML = `
      <!-- Department Profile Overview Card -->
      <div class="p-4 rounded-2xl bg-pink-50/70 border border-pink-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="space-y-1">
          <div class="flex items-center gap-2 flex-wrap">
            <h4 class="text-base font-bold text-slate-900">${escapeHtml(dept.name)}</h4>
            ${dept.code ? `<span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-pink-200 text-pink-900">${escapeHtml(dept.code)}</span>` : ''}
          </div>
          <p class="text-xs text-slate-600 font-medium">${escapeHtml(dept.description || 'No operational description recorded.')}</p>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <button onclick="closeModal('modal-department-detail'); openNewAssetModalWithPrefill({ department: '${escapeHtml(dept.name)}', location: '${escapeHtml(dept.location || '')}' })" class="px-3 py-1.5 rounded-xl text-xs font-bold text-white bg-pink-600 hover:bg-pink-500 shadow-sm cursor-pointer">
            + Allocate Asset
          </button>
        </div>
      </div>

      <!-- 4 Summary KPI Cards -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
          <span class="text-[10px] uppercase font-bold text-slate-400 block mb-1">Total Assets</span>
          <strong class="text-base font-mono font-black text-slate-900">${stats.total_assets} Units</strong>
          <div class="text-[10px] text-slate-500 mt-0.5">Assigned to ${escapeHtml(dept.name)}</div>
        </div>
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
          <span class="text-[10px] uppercase font-bold text-slate-400 block mb-1">Working Health Rate</span>
          <strong class="text-base font-mono font-black text-emerald-600">${workingPct}% Operational</strong>
          <div class="text-[10px] text-emerald-600 mt-0.5">${stats.working} of ${stats.total_assets} working</div>
        </div>
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
          <span class="text-[10px] uppercase font-bold text-slate-400 block mb-1">Personnel / Staff</span>
          <strong class="text-base font-mono font-black text-violet-600">${stats.total_personnel} Members</strong>
          <div class="text-[10px] text-violet-600 mt-0.5">Registered in department</div>
        </div>
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200">
          <span class="text-[10px] uppercase font-bold text-slate-400 block mb-1">Total Asset Value</span>
          <strong class="text-base font-mono font-black text-emerald-600">₹${(stats.total_value || 0).toLocaleString('en-IN')}</strong>
          <div class="text-[10px] text-slate-400 mt-0.5">Total procurement cost</div>
        </div>
      </div>

      <!-- Operational Health Progress Bar -->
      <div class="p-4 rounded-2xl bg-white border border-slate-200 space-y-2">
        <div class="flex items-center justify-between text-xs font-bold text-slate-700">
          <span>Department Hardware Status Breakdown:</span>
          <span>${stats.working} Working • ${stats.in_repair} In Repair • ${stats.not_working} Defective</span>
        </div>
        <div class="w-full h-3 bg-slate-100 rounded-full overflow-hidden flex">
          <div style="width: ${workingPct}%" class="bg-emerald-500 h-full" title="${workingPct}% Working"></div>
          <div style="width: ${repairPct}%" class="bg-amber-400 h-full" title="${repairPct}% In Repair"></div>
          <div style="width: ${notWorkingPct}%" class="bg-rose-500 h-full" title="${notWorkingPct}% Defective"></div>
        </div>
      </div>

      <!-- Hardware Type Distribution Summary -->
      <div class="space-y-2">
        <h4 class="text-xs font-bold uppercase tracking-wider text-slate-800">Hardware Allocation by Type</h4>
        <div class="flex items-center gap-2 flex-wrap">
          ${Object.entries(stats.asset_types || {}).length > 0 ? Object.entries(stats.asset_types).map(([typeName, count]) => `
            <div class="px-3 py-1.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center gap-2 text-xs">
              <span class="font-semibold text-slate-700">${escapeHtml(typeName)}:</span>
              <span class="font-mono font-bold text-pink-600">${count}</span>
            </div>
          `).join('') : '<p class="text-xs text-slate-400">No assets allocated to this department.</p>'}
        </div>
      </div>

      <!-- Department Assets Table -->
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <h4 class="text-xs font-bold uppercase tracking-wider text-slate-800">Department Assets (${assets.length})</h4>
          <button onclick="closeModal('modal-department-detail'); navigate('assets', { department: '${escapeHtml(dept.name)}' })" class="text-xs text-brand-600 hover:text-brand-700 font-bold hover:underline cursor-pointer">
            View in Master Asset List &rarr;
          </button>
        </div>

        ${assets.length > 0 ? `
          <div class="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div class="overflow-x-auto max-h-60">
              <table class="w-full text-left text-xs">
                <thead class="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase font-semibold sticky top-0">
                  <tr>
                    <th class="py-2.5 px-3">Serial #</th>
                    <th class="py-2.5 px-3">Type</th>
                    <th class="py-2.5 px-3">Brand & Model</th>
                    <th class="py-2.5 px-3">Custodian</th>
                    <th class="py-2.5 px-3">Status</th>
                    <th class="py-2.5 px-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100">
                  ${assets.map(a => `
                    <tr class="hover:bg-slate-50/70">
                      <td class="py-2 px-3 font-mono font-bold text-brand-600">#${escapeHtml(a.internal_serial_number)}</td>
                      <td class="py-2 px-3 font-semibold text-slate-800">${escapeHtml(a.asset_type)}</td>
                      <td class="py-2 px-3">${escapeHtml(a.brand || '')} ${escapeHtml(a.model_name || '')}</td>
                      <td class="py-2 px-3 font-medium text-slate-700">${escapeHtml(a.assigned_user || 'Unassigned')}</td>
                      <td class="py-2 px-3">
                        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${a.working_status === 'Working' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}">
                          ${escapeHtml(a.working_status)}
                        </span>
                      </td>
                      <td class="py-2 px-3 text-right">
                        <button onclick="closeModal('modal-department-detail'); viewAssetDetail(${a.id})" class="text-xs font-semibold text-pink-600 hover:text-pink-700 underline cursor-pointer">
                          View Dossier
                        </button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        ` : `
          <div class="p-4 bg-slate-50 border border-slate-200 rounded-xl text-center text-xs text-slate-500">
            No assets currently allocated to ${escapeHtml(dept.name)}.
          </div>
        `}
      </div>

      <!-- Department Personnel Table -->
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <h4 class="text-xs font-bold uppercase tracking-wider text-slate-800">Department Personnel (${employees.length})</h4>
          <button onclick="closeModal('modal-department-detail'); navigate('employees', { department: '${escapeHtml(dept.name)}' })" class="text-xs text-violet-600 hover:text-violet-700 font-bold hover:underline cursor-pointer">
            View in User Master &rarr;
          </button>
        </div>

        ${employees.length > 0 ? `
          <div class="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div class="overflow-x-auto max-h-60">
              <table class="w-full text-left text-xs">
                <thead class="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase font-semibold sticky top-0">
                  <tr>
                    <th class="py-2.5 px-3">Staff Member</th>
                    <th class="py-2.5 px-3">Designation</th>
                    <th class="py-2.5 px-3">Location</th>
                    <th class="py-2.5 px-3">Contact</th>
                    <th class="py-2.5 px-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100">
                  ${employees.map(e => `
                    <tr class="hover:bg-slate-50/70">
                      <td class="py-2 px-3 font-bold text-slate-900">${escapeHtml(e.name)}</td>
                      <td class="py-2 px-3 text-slate-600">${escapeHtml(e.designation || 'Staff')}</td>
                      <td class="py-2 px-3 text-slate-500">${escapeHtml(e.location || 'Main Office')}</td>
                      <td class="py-2 px-3 text-slate-500">${escapeHtml(e.phone || e.email || '—')}</td>
                      <td class="py-2 px-3 text-right">
                        <button onclick="closeModal('modal-department-detail'); viewUserAssets(${e.id})" class="text-xs font-semibold text-violet-600 hover:text-violet-700 underline cursor-pointer">
                          View Hardware
                        </button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        ` : `
          <div class="p-4 bg-slate-50 border border-slate-200 rounded-xl text-center text-xs text-slate-500">
            No employees registered under ${escapeHtml(dept.name)} yet.
          </div>
        `}
      </div>
    `;

    openModal('modal-department-detail');
    lucide.createIcons();
  } catch (err) {
    console.error('viewDepartmentDetail error:', err);
  }
}

// Open Department Form Modal (Add mode)
function openDepartmentModal() {
  const form = document.getElementById('form-department');
  if (form) form.reset();

  document.getElementById('dept-id').value = '';
  document.getElementById('dept-form-title').textContent = 'Add New Department';
  openModal('modal-department-form');
  setTimeout(() => {
    document.getElementById('dept-name')?.focus();
    lucide.createIcons();
  }, 60);
}

// Open Department Form Modal (Edit mode)
async function openEditDepartmentModal(deptId) {
  try {
    const res = await apiFetch(`/api/departments/${deptId}`);
    if (!res.ok) return;
    const { department: dept } = await res.json();

    document.getElementById('dept-form-title').textContent = `Edit Department: ${dept.name}`;
    document.getElementById('dept-id').value = dept.id;
    document.getElementById('dept-name').value = dept.name;
    document.getElementById('dept-code').value = dept.code || '';
    document.getElementById('dept-hod').value = dept.head_of_department || '';
    document.getElementById('dept-location').value = dept.location || '';
    document.getElementById('dept-description').value = dept.description || '';

    openModal('modal-department-form');
    lucide.createIcons();
  } catch (err) {
    console.error('openEditDepartmentModal error:', err);
  }
}

// Handle Add / Edit Department Submit
async function handleDepartmentSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('dept-id').value;
  const btn = document.getElementById('btn-save-dept');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  const payload = {
    name: document.getElementById('dept-name').value.trim(),
    code: document.getElementById('dept-code').value.trim(),
    head_of_department: document.getElementById('dept-hod').value.trim(),
    location: document.getElementById('dept-location').value.trim(),
    description: document.getElementById('dept-description').value.trim()
  };

  try {
    const url = id ? `/api/departments/${id}` : '/api/departments';
    const method = id ? 'PUT' : 'POST';

    const res = await apiFetch(url, {
      method,
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'Department saved successfully!', 'success');
      closeModal('modal-department-form');
      await fetchDepartmentsList(true);
      await populateDepartmentDropdowns(payload.name);
      if (currentView === 'departments') {
        loadDepartments();
      }
      updateGlobalSidebarCounters();
    } else {
      showToast(data.error || 'Failed to save department', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Network error', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Department';
  }
}

// Delete Department
async function deleteDepartment(deptId, deptName) {
  if (!confirm(`Are you sure you want to delete department '${deptName}' from Department Master?\n\nNote: If this department has assets or staff assigned, you must reassign them first.`)) {
    return;
  }
  try {
    const res = await apiFetch(`/api/departments/${deptId}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'Department deleted successfully', 'success');
      await fetchDepartmentsList(true);
      await populateDepartmentDropdowns();
      loadDepartments();
      updateGlobalSidebarCounters();
    } else {
      showToast(data.error || 'Failed to delete department', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Network error', 'error');
  }
}

// Global window attachments
window.fetchUserMasterList = fetchUserMasterList;
window.openQuickAddUserModal = openQuickAddUserModal;
window.handleQuickAddUserSubmit = handleQuickAddUserSubmit;
window.openNewAssetModalWithPrefill = openNewAssetModalWithPrefill;
window.loadEmployees = loadEmployees;
window.filterEmployeesByPrinter = filterEmployeesByPrinter;
window.debounceEmployeeSearch = debounceEmployeeSearch;
window.renderEmployeesTable = renderEmployeesTable;
window.openEmployeeModal = openEmployeeModal;
window.handleEmployeeSubmit = handleEmployeeSubmit;
window.deleteEmployee = deleteEmployee;
window.viewUserAssets = viewUserAssets;
window.resetEmployeeFilterUI = resetEmployeeFilterUI;
window.populateUserSelect = populateUserSelect;
window.populateAccessoryUserSelect = populateAccessoryUserSelect;
window.updateAssetKeyFieldVisibility = updateAssetKeyFieldVisibility;
window.fetchDepartmentsList = fetchDepartmentsList;
window.populateDepartmentDropdowns = populateDepartmentDropdowns;
window.loadDepartments = loadDepartments;
window.resetDepartmentFilterUI = resetDepartmentFilterUI;
window.debounceDeptSearch = debounceDeptSearch;
window.renderDepartmentsGrid = renderDepartmentsGrid;
window.viewDepartmentDetail = viewDepartmentDetail;
window.openDepartmentModal = openDepartmentModal;
window.openEditDepartmentModal = openEditDepartmentModal;
window.handleDepartmentSubmit = handleDepartmentSubmit;
window.deleteDepartment = deleteDepartment;


