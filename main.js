'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

let win;
const CONFIG_PATH = path.join(app.getPath('userData'), 'sf-service-record.json');
const EQUIP_PATH  = path.join(app.getPath('userData'), 'sf-equipment.json');
// Placeholder admin PIN. Override per deployment by editing the
// adminPin field in the userData config file (sf-service-record.json),
// or via the set-pin IPC handler. Do not ship the default to production.
const DEFAULT_PIN = '0000';
const ICON_PATH   = path.join(__dirname, 'assets', 'icon.png');

// ── Logging ──────────────────────────────────────────────────────────────────
// Rolling file log in %APPDATA%/sf-service-record/logs/. console.error in a
// packaged Electron app has nowhere visible to go on Windows; this gives techs
// a file they can attach to an email when something breaks.
const LOG_DIR       = path.join(app.getPath('userData'), 'logs');
const LOG_FILE      = path.join(LOG_DIR, 'main.log');
const LOG_MAX_BYTES = 1024 * 1024;
const LOG_KEEP      = 3;

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

function rotateLogIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    if (fs.statSync(LOG_FILE).size < LOG_MAX_BYTES) return;
    for (let i = LOG_KEEP - 1; i >= 1; i--) {
      const src = path.join(LOG_DIR, 'main.' + i + '.log');
      const dst = path.join(LOG_DIR, 'main.' + (i + 1) + '.log');
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }
    fs.renameSync(LOG_FILE, path.join(LOG_DIR, 'main.1.log'));
  } catch (_) { /* logging must never throw */ }
}

function logLine(level, where, msg) {
  const line = new Date().toISOString() + ' [' + level + '] [' + where + '] ' + msg + '\n';
  try { rotateLogIfNeeded(); fs.appendFileSync(LOG_FILE, line); } catch (_) {}
  if (level === 'ERROR') { try { console.error(line.trim()); } catch (_) {} }
}

function logError(where, err) {
  const detail = err && err.message ? err.message + (err.stack ? '\n' + err.stack : '') : String(err);
  logLine('ERROR', where, detail);
}
function logInfo(where, msg) { logLine('INFO', where, String(msg)); }

// ── Result helpers — every operation handler returns one of these shapes ────
const ok  = (extra) => Object.assign({ ok: true }, extra || {});
const err = (e)     => ({ ok: false, error: e && e.message ? e.message : String(e || 'unknown error') });
const cancelled = () => ({ ok: false, cancelled: true });

// ── Atomic JSON I/O ──────────────────────────────────────────────────────────
// Writes to <file>.tmp then renames over the target. Prevents corrupted
// JSON if the process is killed mid-write (important on OneDrive).
function readJSONSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) { logError('readJSONSafe ' + p, e); return null; }
}

function writeJSONSafe(p, data) {
  const tmp = p + '.tmp';
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    logError('writeJSONSafe ' + p, e);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    return false;
  }
}

// ── Config cache ─────────────────────────────────────────────────────────────
// Load once per process; invalidate on writes. Saves ~500 disk reads per
// renderer session (every ipc handler previously re-read the config file).
let _configCache = null;
function loadConfig() {
  if (_configCache) return _configCache;
  const loaded = readJSONSafe(CONFIG_PATH) || {};
  _configCache = {
    sharepointPath: loaded.sharepointPath || '',
    adminPin: loaded.adminPin || DEFAULT_PIN
  };
  return _configCache;
}
function saveConfig(cfg) {
  _configCache = Object.assign({}, cfg);
  return writeJSONSafe(CONFIG_PATH, _configCache);
}

// ── SharePoint-aware paths ───────────────────────────────────────────────────
function sharepointBase() {
  const cfg = loadConfig();
  const p = (cfg.sharepointPath || '').trim();
  return p || app.getPath('userData');
}
function equipmentFilePath() {
  const cfg = loadConfig();
  const p = (cfg.sharepointPath || '').trim();
  return p ? path.join(p, 'sf-equipment.json') : EQUIP_PATH;
}

function loadEquipment() {
  const shared = equipmentFilePath();
  let data = readJSONSafe(shared);
  if (data) return data;
  // Fallback to local cache if the shared file is missing/unreadable
  if (shared !== EQUIP_PATH) {
    data = readJSONSafe(EQUIP_PATH);
    if (data) return data;
  }
  return null;
}
function saveEquipment(list) {
  const shared = equipmentFilePath();
  const ok = writeJSONSafe(shared, list);
  // Always mirror to local cache for offline access
  if (shared !== EQUIP_PATH) writeJSONSafe(EQUIP_PATH, list);
  return ok;
}

// ── Filename sanitizer (shared with scan uploader) ───────────────────────────
function sanitizeFileFragment(s, fallback) {
  const cleaned = String(s || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}
function sanitizeDate(d) {
  return String(d || new Date().toISOString().slice(0, 10))
    .replace(/[^0-9\-]/g, '').slice(0, 10);
}

// ── Focus restore ────────────────────────────────────────────────────────────
// Windows steals focus from the Electron renderer in three cases:
//   1. shell.showItemInFolder() pops Explorer (after Save & Print / Upload Scan)
//   2. The native confirm() dialog from the renderer (+ New Record)
//   3. Any time another window briefly activates over us
// A single win.focus() call doesn't reliably restore typing because:
//   - It only focuses the BrowserWindow shell, not the inner webContents
//   - Explorer can grab focus AFTER our restore call returns
// Solution: focus both the window and webContents, and retry at staggered
// intervals so at least one call lands after the focus thief is done.
function restoreFocus() {
  const stamps = [120, 320, 700];
  stamps.forEach(ms => {
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.focus();
      win.webContents.focus();
    }, ms);
  });
}

// ── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1020,
    height: 1100,
    minWidth: 840,
    show: false,
    title: 'St. Francis Electric — Service Record',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.setMenu(null);
  // Open maximized (fills the screen but keeps the title bar / close button).
  // show:false above lets us maximize before first paint to avoid a window-resize flash.
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  // Allow F12 to toggle DevTools and Ctrl+R to reload — needed for debugging
  // since the menu is hidden. before-input-event fires before the renderer
  // sees the keystroke, so we don't interfere with normal typing.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') { win.webContents.toggleDevTools(); event.preventDefault(); }
    else if ((input.control || input.meta) && input.key.toLowerCase() === 'r') { win.webContents.reload(); event.preventDefault(); }
  });
}

app.whenReady().then(() => { logInfo('startup', 'v' + currentVersion()); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── IPC: config ──────────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => loadConfig());

// ── IPC: equipment DB ────────────────────────────────────────────────────────
ipcMain.handle('get-equipment',  ()           => loadEquipment());
ipcMain.handle('save-equipment', (_evt, list) => {
  if (!Array.isArray(list)) return err('save-equipment: payload must be an array');
  return saveEquipment(list) ? ok() : err('failed to write equipment file');
});

// ── IPC: service history ─────────────────────────────────────────────────────
ipcMain.handle('get-history', () => readJSONSafe(path.join(sharepointBase(), 'sf-history.json')) || []);
ipcMain.handle('append-history', (_evt, entry) => {
  if (!entry || typeof entry !== 'object') return err('append-history: invalid entry');
  const p = path.join(sharepointBase(), 'sf-history.json');
  const arr = readJSONSafe(p) || [];
  arr.push(entry);
  return writeJSONSafe(p, arr) ? ok() : err('failed to write history file');
});

// ── IPC: BIT inspections (CHP 108) ───────────────────────────────────────────
// sf-bit.json is an object keyed by "<unit>|<calendarYear>|<truck|trailer>" →
// one year-log record per unit per form type (matches the official CHP 108,
// where each 90-day inspection fills the next column on the same sheet).
// save-bit re-reads the file and sets only the given key, so two machines
// editing different units through OneDrive don't clobber each other.
ipcMain.handle('get-bit', () => readJSONSafe(path.join(sharepointBase(), 'sf-bit.json')) || {});
ipcMain.handle('save-bit', (_evt, payload) => {
  if (!payload || typeof payload.key !== 'string' || !payload.key ||
      !payload.record || typeof payload.record !== 'object') {
    return err('save-bit: invalid payload');
  }
  const p = path.join(sharepointBase(), 'sf-bit.json');
  const db = readJSONSafe(p) || {};
  db[payload.key] = payload.record;
  return writeJSONSafe(p, db) ? ok() : err('failed to write BIT file');
});

// ── IPC: mileage tracking ────────────────────────────────────────────────────
ipcMain.handle('get-mileage', () => readJSONSafe(path.join(sharepointBase(), 'sf-mileage.json')) || {});
ipcMain.handle('append-mileage', (_evt, payload) => {
  if (!payload || !payload.code || !payload.entry) return err('append-mileage: invalid payload');
  const p = path.join(sharepointBase(), 'sf-mileage.json');
  const db = readJSONSafe(p) || {};
  const code = String(payload.code);
  if (!db[code]) db[code] = [];
  db[code].push(payload.entry);
  return writeJSONSafe(p, db) ? ok() : err('failed to write mileage file');
});

// ── IPC: parts list ──────────────────────────────────────────────────────────
// sf-parts.json is an object keyed by job name → array of parts:
//   { "Brake Job": [ { part, desc, vendor, notes }, ... ], ... }
ipcMain.handle('get-parts', () => readJSONSafe(path.join(sharepointBase(), 'sf-parts.json')) || {});
ipcMain.handle('save-parts', (_evt, data) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return err('save-parts: payload must be an object');
  const p = path.join(sharepointBase(), 'sf-parts.json');
  return writeJSONSafe(p, data) ? ok() : err('failed to write parts file');
});

// ── IPC: scan saved records ──────────────────────────────────────────────────
ipcMain.handle('scan-records', () => {
  const cfg = loadConfig();
  const root = (cfg.sharepointPath || '').trim();
  if (!root) return [];
  const results = [];
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory() && /^\d{4}-\d{2}$/.test(ent.name)) {
        const monthPath = path.join(root, ent.name);
        try {
          const files = fs.readdirSync(monthPath);
          for (const f of files) {
            if (f.toLowerCase().endsWith('.pdf')) {
              results.push({ month: ent.name, file: f, path: path.join(monthPath, f) });
            }
          }
        } catch (e) { logError('scan-records month ' + monthPath, e); }
      }
    }
  } catch (e) { logError('scan-records root', e); }
  return results.sort((a, b) => (b.month + b.file).localeCompare(a.month + a.file));
});

// ── IPC: focus restore (called from renderer after native confirm() dialogs) ─
ipcMain.handle('restore-focus', () => { restoreFocus(); return ok(); });

// ── IPC: open log folder (for support — techs send us their main.log) ───────
ipcMain.handle('open-log-folder', () => {
  try { shell.openPath(LOG_DIR); return ok({ path: LOG_DIR }); }
  catch (e) { logError('open-log-folder', e); return err(e); }
});

// ── IPC: open file / external link ───────────────────────────────────────────
ipcMain.handle('open-file', async (_evt, p) => {
  if (typeof p !== 'string' || !p) return err('open-file: invalid path');
  try { await shell.openPath(p); return ok(); }
  catch (e) { logError('open-file', e); return err(e); }
});
ipcMain.handle('open-external', (_evt, url) => {
  // Only allow http(s) — no file:// or javascript: schemes from the renderer
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return err('open-external: only http(s) URLs allowed');
  try { shell.openExternal(url); return ok(); }
  catch (e) { logError('open-external', e); return err(e); }
});

// ── IPC: admin PIN ───────────────────────────────────────────────────────────
// verify-pin is a yes/no question, not an operation — keep the boolean shape.
ipcMain.handle('verify-pin', (_evt, pin) => {
  const cfg = loadConfig();
  return String(pin) === String(cfg.adminPin || DEFAULT_PIN);
});
ipcMain.handle('set-pin', (_evt, pin) => {
  if (typeof pin !== 'string' || !pin.trim()) return err('set-pin: PIN cannot be empty');
  const cfg = loadConfig();
  cfg.adminPin = pin.trim();
  return saveConfig(cfg) ? ok() : err('failed to save config');
});

// ── Auto-update ──────────────────────────────────────────────────────────────
// Update channel is the same OneDrive folder used for equipment + PDFs.
// Publishing a new build (for NSIS-installed clients):
//   1. Drop the new "SF Service Record Setup <version>.exe" into
//      <SharePoint>/installers/
//   2. Edit <SharePoint>/app-version.json:
//        { "version": "1.2.1",
//          "installer": "installers/SF Service Record Setup 1.2.1.exe",
//          "notes": "...", "mandatory": false }
// On launch the app reads its own package.json version, compares against the
// manifest, and (if newer) prompts via a modal. Install Now copies the
// installer to %TEMP%, spawns updater.bat (which waits for the app to quit,
// then runs the installer), and quits. The NSIS assisted installer upgrades
// in place and relaunches the app (runAfterFinish). User data lives in
// %APPDATA%, so upgrades preserve config/equipment/history.
function currentVersion() {
  try { return require('./package.json').version || '0.0.0'; }
  catch (_) { return '0.0.0'; }
}
function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
// check-update returns ok() with an `available` field. Reasons like
// 'no-sharepoint' / 'no-manifest' are not errors — they're normal states.
ipcMain.handle('check-update', () => {
  try {
    const cfg = loadConfig();
    const root = (cfg.sharepointPath || '').trim();
    const current = currentVersion();
    if (!root) return ok({ available: false, current, reason: 'no-sharepoint' });
    const manifest = readJSONSafe(path.join(root, 'app-version.json'));
    if (!manifest || !manifest.version || !manifest.installer) {
      return ok({ available: false, current, reason: 'no-manifest' });
    }
    const installerPath = path.join(root, manifest.installer);
    if (!fs.existsSync(installerPath)) {
      return ok({ available: false, current, reason: 'installer-missing' });
    }
    const newer = compareVersions(manifest.version, current) > 0;
    return ok({
      available: newer,
      current,
      latest: manifest.version,
      notes: manifest.notes || '',
      mandatory: !!manifest.mandatory,
      installerPath
    });
  } catch (e) { logError('check-update', e); return err(e); }
});
ipcMain.handle('apply-update', (_evt, installerPath) => {
  try {
    if (typeof installerPath !== 'string' || !installerPath || !fs.existsSync(installerPath)) {
      return err('apply-update: installer missing or invalid');
    }
    // Copy the installer locally first — on the shared folder it may be a
    // cloud-only OneDrive placeholder, and running it from there can stall or
    // fail. copyFileSync forces hydration into %TEMP%.
    const tmpInstaller = path.join(os.tmpdir(), 'sf-service-record-setup.exe');
    fs.copyFileSync(installerPath, tmpInstaller);
    const srcUpdater = path.join(__dirname, 'updater.bat');
    const tmpUpdater = path.join(os.tmpdir(), 'sf-service-record-updater.bat');
    fs.copyFileSync(srcUpdater, tmpUpdater);
    const child = spawn('cmd.exe', ['/c', 'start', '""', '/min', tmpUpdater, tmpInstaller], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    logInfo('apply-update', 'spawned installer ' + tmpInstaller);
    setTimeout(() => app.quit(), 250);
    return ok();
  } catch (e) { logError('apply-update', e); return err(e); }
});

// ── IPC: pick SharePoint folder ──────────────────────────────────────────────
ipcMain.handle('pick-sharepoint-folder', async () => {
  try {
    const result = await dialog.showOpenDialog(win, {
      title: 'Select your SharePoint / OneDrive Sync Folder for Service Records',
      properties: ['openDirectory', 'createDirectory']
    });
    restoreFocus();
    if (result.canceled || !result.filePaths.length) return cancelled();
    const cfg = loadConfig();
    cfg.sharepointPath = result.filePaths[0];
    if (!saveConfig(cfg)) return err('failed to save config');
    logInfo('pick-sharepoint-folder', result.filePaths[0]);
    return ok({ path: result.filePaths[0] });
  } catch (e) { logError('pick-sharepoint-folder', e); return err(e); }
});

// ── IPC: upload scan ─────────────────────────────────────────────────────────
// Older techs upload a phone photo or scan of a paper service record.
// One dialog (pick the source file), then auto-named + auto-placed in the
// SharePoint YYYY-MM subfolder. No second "where do you want to save?"
// prompt — that confuses non-technical users.
ipcMain.handle('upload-scan', async (_evt, payload) => {
  const { equipment, date } = payload || {};
  const cfg = loadConfig();

  const pick = await dialog.showOpenDialog(win, {
    title: 'Select Picture or PDF of Service Record',
    properties: ['openFile'],
    filters: [
      { name: 'Pictures & PDFs', extensions: ['jpg','jpeg','png','gif','bmp','webp','heic','heif','tiff','pdf'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  restoreFocus();
  if (pick.canceled || !pick.filePaths.length) return cancelled();

  const srcPath  = pick.filePaths[0];
  const ext      = path.extname(srcPath).toLowerCase() || '.jpg';
  const safeDate = sanitizeDate(date);
  const safeEq   = sanitizeFileFragment(equipment, 'scan');
  const baseName = safeDate + '_' + safeEq + '_scan';

  let destPath;

  if (cfg.sharepointPath && cfg.sharepointPath.trim()) {
    // Auto-save into SharePoint monthly folder, no second dialog
    const monthDir = path.join(cfg.sharepointPath.trim(), safeDate.slice(0, 7));
    try {
      fs.mkdirSync(monthDir, { recursive: true });
    } catch (e) {
      logError('upload-scan mkdir', e);
      return err('Cannot create folder:\n' + monthDir + '\n\n' + e.message);
    }
    // Auto-increment if a file with this name already exists this day
    destPath = path.join(monthDir, baseName + ext);
    let n = 2;
    while (fs.existsSync(destPath) && n <= 99) {
      destPath = path.join(monthDir, baseName + '_' + n + ext);
      n++;
    }
  } else {
    // SharePoint not yet configured — fall back to save dialog
    const savePick = await dialog.showSaveDialog(win, {
      title: 'Save Picture (set up SharePoint to skip this step)',
      defaultPath: path.join(os.homedir(), 'Desktop', baseName + ext),
      filters: [
        { name: 'Same type as source', extensions: [ext.replace('.', '')] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    restoreFocus();
    if (savePick.canceled) return cancelled();
    destPath = savePick.filePath;
  }

  try {
    fs.copyFileSync(srcPath, destPath);
    // Intentionally do NOT call shell.showItemInFolder — Explorer steals
    // focus from the renderer on Windows, leaving text fields unresponsive.
    // Techs can browse uploaded scans via the Records button in the toolbar.
    logInfo('upload-scan', destPath);
    return ok({ path: destPath });
  } catch (e) {
    logError('upload-scan copy', e);
    return err(e);
  }
});

// ── IPC: save PDF ────────────────────────────────────────────────────────────
ipcMain.handle('save-pdf', async (_evt, payload) => {
  const { equipment, date } = payload || {};
  const cfg = loadConfig();

  const safeDate = sanitizeDate(date);
  const safeEq   = sanitizeFileFragment(equipment, 'service-record');
  const filename = safeDate + '_' + safeEq + '.pdf';

  let destPath;
  if (cfg.sharepointPath && cfg.sharepointPath.trim()) {
    const monthDir = path.join(cfg.sharepointPath.trim(), safeDate.slice(0, 7));
    try {
      fs.mkdirSync(monthDir, { recursive: true });
    } catch (e) {
      logError('save-pdf mkdir', e);
      return err('Cannot create folder:\n' + monthDir + '\n\n' + e.message);
    }
    destPath = path.join(monthDir, filename);
  } else {
    const pick = await dialog.showSaveDialog(win, {
      title: 'Save Service Record PDF',
      defaultPath: path.join(os.homedir(), 'Desktop', filename),
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
    });
    restoreFocus();
    if (pick.canceled) return cancelled();
    destPath = pick.filePath.toLowerCase().endsWith('.pdf')
      ? pick.filePath
      : pick.filePath + '.pdf';
  }

  try {
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'Letter',
      landscape: !!(payload && payload.landscape),
      marginsType: 0,
      headerFooterEnabled: false
    });
    fs.writeFileSync(destPath, pdf);
    // Intentionally do NOT call shell.showItemInFolder — Explorer steals
    // focus from the renderer on Windows, leaving text fields unresponsive.
    // Techs can browse saved PDFs via the Records button in the toolbar.
    logInfo('save-pdf', destPath);
    return ok({ path: destPath });
  } catch (e) {
    logError('save-pdf printToPDF', e);
    return err(e);
  }
});

// Open the native print dialog for the current page. The renderer keeps its
// print view active while this runs so the printout matches the saved PDF.
// success is false if the tech cancels the dialog or has no printer — not an error.
ipcMain.handle('print-page', (_evt, opts) => {
  const landscape = !!(opts && opts.landscape);
  return new Promise(resolve => {
    win.webContents.print({ silent: false, printBackground: true, pageSize: 'Letter', landscape }, (success, failureReason) => {
      restoreFocus();
      if (!success && failureReason && failureReason !== 'cancelled') logError('print-page', failureReason);
      resolve({ ok: success });
    });
  });
});
