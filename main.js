'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
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
function logError(where, err) {
  try { console.error('[' + where + ']', err && err.message ? err.message : err); } catch (_) {}
}

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

// ── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1020,
    height: 1100,
    minWidth: 840,
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
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── IPC: config ──────────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => loadConfig());

// ── IPC: equipment DB ────────────────────────────────────────────────────────
ipcMain.handle('get-equipment',  ()           => loadEquipment());
ipcMain.handle('save-equipment', (_evt, list) => {
  if (!Array.isArray(list)) return false;
  return saveEquipment(list);
});

// ── IPC: service history ─────────────────────────────────────────────────────
ipcMain.handle('get-history', () => readJSONSafe(path.join(sharepointBase(), 'sf-history.json')) || []);
ipcMain.handle('append-history', (_evt, entry) => {
  if (!entry || typeof entry !== 'object') return false;
  const p = path.join(sharepointBase(), 'sf-history.json');
  const arr = readJSONSafe(p) || [];
  arr.push(entry);
  return writeJSONSafe(p, arr);
});

// ── IPC: mileage tracking ────────────────────────────────────────────────────
ipcMain.handle('get-mileage', () => readJSONSafe(path.join(sharepointBase(), 'sf-mileage.json')) || {});
ipcMain.handle('append-mileage', (_evt, payload) => {
  if (!payload || !payload.code || !payload.entry) return false;
  const p = path.join(sharepointBase(), 'sf-mileage.json');
  const db = readJSONSafe(p) || {};
  const code = String(payload.code);
  if (!db[code]) db[code] = [];
  db[code].push(payload.entry);
  return writeJSONSafe(p, db);
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

// ── IPC: open file / external link ───────────────────────────────────────────
ipcMain.handle('open-file', async (_evt, p) => {
  if (typeof p !== 'string' || !p) return false;
  try { await shell.openPath(p); return true; }
  catch (e) { logError('open-file', e); return false; }
});
ipcMain.handle('open-external', (_evt, url) => {
  // Only allow http(s) — no file:// or javascript: schemes from the renderer
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  try { shell.openExternal(url); return true; }
  catch (e) { logError('open-external', e); return false; }
});

// ── IPC: admin PIN ───────────────────────────────────────────────────────────
ipcMain.handle('verify-pin', (_evt, pin) => {
  const cfg = loadConfig();
  return String(pin) === String(cfg.adminPin || DEFAULT_PIN);
});
ipcMain.handle('set-pin', (_evt, pin) => {
  if (typeof pin !== 'string' || !pin.trim()) return false;
  const cfg = loadConfig();
  cfg.adminPin = pin.trim();
  return saveConfig(cfg);
});

// ── IPC: pick SharePoint folder ──────────────────────────────────────────────
ipcMain.handle('pick-sharepoint-folder', async () => {
  try {
    const result = await dialog.showOpenDialog(win, {
      title: 'Select your SharePoint / OneDrive Sync Folder for Service Records',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return null;
    const cfg = loadConfig();
    cfg.sharepointPath = result.filePaths[0];
    saveConfig(cfg);
    return result.filePaths[0];
  } catch (e) { logError('pick-sharepoint-folder', e); return null; }
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
  if (pick.canceled || !pick.filePaths.length) return { ok: false, msg: 'Cancelled.' };

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
      return { ok: false, msg: 'Cannot create folder:\n' + monthDir + '\n\n' + e.message };
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
    if (savePick.canceled) return { ok: false, msg: 'Cancelled.' };
    destPath = savePick.filePath;
  }

  try {
    fs.copyFileSync(srcPath, destPath);
    shell.showItemInFolder(destPath);
    if (win && !win.isDestroyed()) {
      setTimeout(() => { try { win.focus(); } catch (_) {} }, 150);
    }
    return { ok: true, path: destPath };
  } catch (e) {
    logError('upload-scan copy', e);
    return { ok: false, msg: e.message };
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
      return { ok: false, msg: 'Cannot create folder:\n' + monthDir + '\n\n' + e.message };
    }
    destPath = path.join(monthDir, filename);
  } else {
    const pick = await dialog.showSaveDialog(win, {
      title: 'Save Service Record PDF',
      defaultPath: path.join(os.homedir(), 'Desktop', filename),
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
    });
    if (pick.canceled) return { ok: false, msg: 'Cancelled.' };
    destPath = pick.filePath.toLowerCase().endsWith('.pdf')
      ? pick.filePath
      : pick.filePath + '.pdf';
  }

  try {
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'Letter',
      landscape: false,
      marginsType: 0,
      headerFooterEnabled: false
    });
    fs.writeFileSync(destPath, pdf);
    shell.showItemInFolder(destPath);
    // Explorer steals focus; reclaim it so the confirm() dialog lands on
    // the app window and form inputs remain responsive without an alt-tab.
    if (win && !win.isDestroyed()) {
      setTimeout(() => { try { win.focus(); } catch (_) {} }, 150);
    }
    return { ok: true, path: destPath };
  } catch (e) {
    logError('save-pdf printToPDF', e);
    return { ok: false, msg: e.message };
  }
});
