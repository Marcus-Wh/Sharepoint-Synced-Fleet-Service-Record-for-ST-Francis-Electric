// Headless smoke test — boots the real renderer in Electron (no preload, so
// all electronAPI calls fall back to their guards) and exercises the app's
// core behaviors: both tabs render, the CHP 108 prints on ONE landscape page,
// tracker due logic, defect auto-capture from both forms, and the unit file.
// Run with: npx electron test/smoke.js
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'index.html').replace(/\\/g, '/');

app.whenReady().then(async () => {
  let fails = 0;
  try {
    const w = new BrowserWindow({ show: false, width: 1280, height: 1000 });
    await w.loadURL('file:///' + INDEX);

    const results = await w.webContents.executeJavaScript(`(async () => {
      const out = [];
      const assert = (name, cond) => out.push((cond ? 'PASS ' : 'FAIL ') + name);
      const iso = d => d.toISOString().slice(0, 10);
      const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

      // ── Service record tab boots ──
      assert('equipment DB loaded', equipmentDB.length > 100);
      assert('date defaulted', !!document.getElementById('date').value);

      // ── BIT tab ──
      showTab('bit');
      assert('BIT truck grid has 40 rows', document.querySelectorAll('#bit-table tbody tr').length === 40);
      assert('BIT cells offer N/A', document.querySelector('#bit-table tbody select').innerHTML.includes('N/A'));
      setBitType('trailer');
      assert('BIT trailer grid has 21 rows', document.querySelectorAll('#bit-table tbody tr').length === 21);
      setBitType('truck');

      // ── Tracker due logic (dates computed relative to today) ──
      mileageData['99999'] = [{ date: daysAgo(1), in: '', out: '124000', tech: 'T' }];
      let s = trackerStatus({ unit: '99999 TEST', name: 'Oil', intervalDays: '90', lastDate: daysAgo(200), intervalMiles: '', lastMiles: '' });
      assert('tracker 200 days ago @ 90-day interval → over', s.level === 'over');
      s = trackerStatus({ unit: '99999 TEST', name: 'Oil', intervalDays: '365', lastDate: iso(new Date()), intervalMiles: '', lastMiles: '' });
      assert('tracker done today @ 365 days → ok', s.level === 'ok');
      s = trackerStatus({ unit: '99999 TEST', name: 'Oil', intervalDays: '', lastDate: '', intervalMiles: '3000', lastMiles: '120000' });
      assert('tracker 1000 mi past → over', s.level === 'over');
      s = trackerStatus({ unit: '99999 TEST', name: 'Oil', intervalDays: '', lastDate: '', intervalMiles: '5000', lastMiles: '120000' });
      assert('tracker 1000 mi left → ok', s.level === 'ok');

      // ── Fleet badges ──
      trackersData = [{ id: 't1', unit: '99999 TEST', name: 'Oil', intervalDays: '90', lastDate: daysAgo(200), intervalMiles: '', lastMiles: '' }];
      defectsData = [{ id: 'd1', unit: '99999 TEST', status: 'open', item: 'Horn', date: daysAgo(1) }];
      refreshFleetBadges();
      assert('fleet badge counts overdue + open', document.getElementById('fleet-badge').textContent === '2');

      // ── Defect auto-capture: service form ──
      const sel = document.querySelector('#sr-wrap .check-item select');
      sel.value = 'Leaking';
      assert('service capture flags Leaking', collectServiceDefects().some(f => f.desc === 'Leaking'));
      sel.value = 'OK';
      assert('service capture ignores clean form', collectServiceDefects().length === 0);

      // ── Defect auto-capture: BIT form (with dedup) ──
      document.getElementById('bit-c0-i29').value = 'DEF';
      document.getElementById('bit-c3-i29').value = 'DEF';
      const bd = collectBitDefects();
      assert('BIT capture dedupes same item across columns', bd.length === 1);
      const n1 = await logDefects('99999 TEST', 'BIT', bd, 'T');
      const n2 = await logDefects('99999 TEST', 'BIT', bd, 'T');
      assert('logDefects skips already-open duplicates', n1 === 1 && n2 === 0);

      // ── Unit file ──
      historyData = [{ date: daysAgo(1), equipment: '99999 TEST', job: 'J1', technician: 'T', status: 'Ready for Service', notes: '', path: '' }];
      ufBitDB = { '99999|2026|truck': { cols: [{ m: '123', v: { 1: 'OK' } }], updated: '' } };
      ufRecords = [{ month: '2026-07', file: daysAgo(1) + '_99999-BIT-CHP108.pdf', path: 'x' }];
      document.getElementById('uf-unit').value = '99999';
      renderUnitFile();
      const uf = document.getElementById('unitfile-content').innerHTML;
      assert('unit file aggregates defects/trackers/history/BIT/PDFs',
        /Horn/.test(uf) && /Oil/.test(uf) && /J1/.test(uf) && /1 of 12/.test(uf) && /BIT-CHP108/.test(uf));

      // ── Prepare BIT print view for the page-count check ──
      document.getElementById('bit-mil-0').value = '123456';
      for (let i = 1; i <= 40; i++) { const el = document.getElementById('bit-c0-i' + i); if (el && !el.value) el.value = 'OK'; }
      document.getElementById('bit-rep-date-0').value = daysAgo(0);
      document.getElementById('bit-rep-note-0').value = 'Smoke test entry.';
      preparePrintView();
      return out;
    })()`);
    results.forEach(r => console.log(r));
    fails += results.filter(r => r.startsWith('FAIL')).length;

    // ── CHP 108 must print on ONE landscape page ──
    const pdf = await w.webContents.printToPDF({
      printBackground: true, pageSize: 'Letter', landscape: true,
      marginsType: 0, headerFooterEnabled: false
    });
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    if (pages === 1) console.log('PASS CHP 108 prints on 1 landscape page');
    else { console.log('FAIL CHP 108 prints on ' + pages + ' pages (expected 1)'); fails++; }
  } catch (e) {
    console.error('TEST ERROR: ' + (e && e.message));
    fails++;
  }
  console.log(fails ? fails + ' FAILURE(S)' : 'ALL PASS');
  process.exitCode = fails ? 1 : 0;
  app.quit();
});
