'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Explicit allowlist — nothing else crosses the context boundary.
contextBridge.exposeInMainWorld('electronAPI', {
  // Config
  getConfig:            ()      => ipcRenderer.invoke('get-config'),
  pickSharepointFolder: ()      => ipcRenderer.invoke('pick-sharepoint-folder'),

  // Save / print
  savePDF:              (data)  => ipcRenderer.invoke('save-pdf', data),
  uploadScan:           (data)  => ipcRenderer.invoke('upload-scan', data),

  // Equipment DB
  getEquipment:         ()      => ipcRenderer.invoke('get-equipment'),
  saveEquipment:        (list)  => ipcRenderer.invoke('save-equipment', list),

  // Admin PIN
  verifyPin:            (pin)   => ipcRenderer.invoke('verify-pin', pin),
  setPin:               (pin)   => ipcRenderer.invoke('set-pin', pin),

  // Service history
  getHistory:           ()      => ipcRenderer.invoke('get-history'),
  appendHistory:        (entry) => ipcRenderer.invoke('append-history', entry),

  // Mileage tracking
  getMileage:           ()      => ipcRenderer.invoke('get-mileage'),
  appendMileage:        (data)  => ipcRenderer.invoke('append-mileage', data),

  // Past records
  scanRecords:          ()      => ipcRenderer.invoke('scan-records'),
  openFile:             (p)     => ipcRenderer.invoke('open-file', p),
  openExternal:         (url)   => ipcRenderer.invoke('open-external', url),

  // Auto-update
  checkUpdate:          ()      => ipcRenderer.invoke('check-update'),
  applyUpdate:          (dir)   => ipcRenderer.invoke('apply-update', dir),

  // Focus restore — call after a native confirm() dialog returns control
  restoreFocus:         ()      => ipcRenderer.invoke('restore-focus'),
});
