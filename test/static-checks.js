// Static checks — no Electron needed. Compiles every JS surface (a syntax
// error in the 2,000+ line inline renderer script would otherwise kill the
// whole app silently) and verifies renderer <-> main IPC channels line up.
// Run with: node test/static-checks.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let failed = 0;
function check(name, fn) {
  try { fn(); console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + e.message); }
}

const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preSrc  = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const html    = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const inline  = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || '';

check('main.js compiles',    () => new vm.Script(mainSrc, { filename: 'main.js' }));
check('preload.js compiles', () => new vm.Script(preSrc,  { filename: 'preload.js' }));
check('index.html has an inline script', () => { if (!inline.trim()) throw new Error('no <script> block found'); });
check('index.html inline script compiles', () => new vm.Script(inline, { filename: 'index.html <script>' }));

check('every preload IPC channel has a main-process handler', () => {
  const invoked = [...preSrc.matchAll(/invoke\('([^']+)'/g)].map(m => m[1]);
  const handled = new Set([...mainSrc.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]));
  if (!invoked.length) throw new Error('no channels found in preload.js');
  const missing = invoked.filter(c => !handled.has(c));
  if (missing.length) throw new Error('no ipcMain.handle for: ' + missing.join(', '));
});

console.log(failed ? failed + ' FAILURE(S)' : 'ALL PASS');
process.exitCode = failed ? 1 : 0;
