# 💻 Enterprise IT Asset & Lifecycle Management Web Application

> **Designed for VB EXPORTS** — High-performance, secure, and modern IT infrastructure management system built with Node.js, Express, SQLite, and a colorful, premium UI.

---

## 🌟 Key Features

### 🖥️ 1. Complete IT Assets Registry
- **Comprehensive Lifecycle Tracking**: Track hardware specifications, brand, model, manufacturer serial, purchase date, procurement vendor, acquisition cost, assigned department, physical location, assigned user, operational status, and custom usage notes.
- **Dynamic Status & Condition Rating**: Monitor `Working`, `In Repair`, `Not Working`, and `Retired` statuses in real time.
- **Editable & Changeable**: Full CRUD capabilities to update any detail, fix legacy discrepancies, or add newly acquired hardware.
- **CSV / Excel Export**: One-click download of the complete assets register.
- **Asset Barcode / QR Label Preview**: Printable asset tag preview for workstation physical tagging.

### 🔧 2. End-to-End Repair & Lifecycle Intelligence
- **Maintenance Ledger**: Log repairs, diagnostic findings, vendor/technician details, repair cost, and warranty period.
- **Component Replacement & Upgrades Tracking**: Automatically track new parts installed (e.g. SSD additions, RAM upgrades, thermal printhead replacements).
- **Automated End-of-Life (EOL) Intelligence**: Identifies aging systems or machines exceeding maintenance thresholds (based on age, repair frequency, and total maintenance spend compared to acquisition value).

### 🔑 3. Quick Heal Antivirus License Vault
- **Pre-loaded Licenses**: All 30 Quick Heal keys from the master sheet are seeded and categorized.
- **1-Click Workstation Mapping**: Easily map or unmap licenses to workstations and laptops with a single click.
- **Validity & Expiry Countdown**: Visual indicators for active licenses, days remaining, and licenses nearing 90-day renewal deadlines.
- **Single & Bulk Key Import**: Add new individual keys or paste bulk license bundles into the vault.

### 🖱️ 4. Peripherals & Accessories Inventory
- Track stock counts of mice, keyboards, barcode scanners, thermal printheads, power adapters, and UPS units.
- Monitor assigned vs in-stock quantities to prevent procurement bottlenecks.

### 🔍 5. Master Intelligence Search
- **Universal Multi-Index Query**: Type any keyword (brand, user, department, asset serial, replaced component, ticket number, or license key) to search across all modules simultaneously.
- **Global Keyboard Shortcut**: Instant modal search with `Ctrl + K` or `/` from anywhere in the application.

### 🔐 6. Role-Based Access Control (RBAC) & Settings
- **Three Granular Access Roles**:
  - 👑 **Admin**: Full authority — user management, role assignments, system settings, database backups, and record deletion.
  - 🔧 **Technician**: Operational authority — add/edit assets, log repairs, replace parts, assign keys, and update accessories.
  - 👁️ **Viewer**: Read-only oversight — browse assets, view repair history, search, and export data.
- **Security**: Password hashing via `bcryptjs`, JWT session cookies, and full audit logging.
- **Default Accounts**:
  - Admin: `admin` / `admin123`
  - Technician: `technician` / `tech123`
  - Viewer: `viewer` / `view123`

---

## 🏗️ Architecture

```
IT-App/
├── server.js               # Express application entrypoint & SPA routing
├── database.js             # SQLite schema, indices, and auto-seeder
├── auth.js                 # JWT authentication & RBAC middleware
├── routes/
│   ├── api.js              # REST endpoints for assets, repairs, keys, search, settings
│   └── auth.js             # Authentication endpoints (login, logout, session)
├── public/
│   ├── css/
│   │   └── style.css       # Colorful, premium modern styling
│   ├── js/
│   │   └── app.js          # Client SPA controller & reactive view handlers
│   ├── index.html          # Core single-page dashboard container
│   └── login.html          # Login portal with demo credentials
├── data/                   # SQLite database storage (WAL mode)
├── Dockerfile              # Production container specification
├── package.json
└── README.md
```

---

## 🚀 Quick Start (Local)

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start the server**:
   ```bash
   npm start
   ```

3. **Open browser**:
   Navigate to `http://localhost:3000` and sign in with `admin` / `admin123`.

4. **Run integration verification**:
   ```bash
   npm test
   ```

---

## 🌐 Railway Cloud Deployment

This repository is configured for Railway deployment via Dockerfile or Nixpacks.
- Port binding: Automatically adapts to `process.env.PORT`.
- Health Check: `/health`
