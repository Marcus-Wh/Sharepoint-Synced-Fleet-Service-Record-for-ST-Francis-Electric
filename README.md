# SF Service Record

A desktop application for fleet mechanics to fill out, save, and share
vehicle service records as PDFs — built for **St. Francis Electric** to
replace a paper-and-folder workflow with a touch-friendly form that
auto-files into a shared OneDrive folder.

Built with Electron, vanilla JavaScript, and zero external dependencies
in the renderer. No backend, no auth, no API. Just a local app pointed
at a folder.

> **Status:** in production with multiple field technicians.
> **Platform:** Windows 10 / 11.

---

## Why this exists

The original workflow was a Microsoft Word template that techs would
fill out, save with whatever filename they felt like, and dump into a
shared drive. The result was inconsistent naming, no way to search
past records, and PDFs that often never got saved at all.

This app replaces it with a single-screen, scrollable form that:

- **Auto-names** the PDF as `<date>_<unit#>.pdf`
- **Auto-files** it into a `YYYY-MM` subfolder of the techs's
  OneDrive-synced SharePoint folder
- **Auto-syncs** through OneDrive — no Graph API, no OAuth, no IT involvement
- **Tracks history** — every record saved is searchable later
- **Tracks mileage** per equipment unit over time
- **Lets older techs** snap a phone photo of a paper sheet and upload
  it directly to SharePoint with one button

---

## Features

### Service record form
- Year/Make/Model/VIN auto-fill from the equipment database
- 21-item inspection checklist (oil, filters, brakes, tires, etc.)
  with status dropdowns per item
- Safety devices section (fire extinguisher, warning triangles, etc.)
- CARB Smoke Test status + method
- Brake pad thickness + tire tread/PSI per wheel position
- Free-form mechanic comments + recommended follow-up
- Mouse / touchscreen signature pad
- Status flags: Ready / Lockout-Tagout / Awaiting Parts

### Workflow tools
- **Equipment Manager** (PIN-protected) — add/edit/delete the master
  equipment list; changes auto-sync to all techs via OneDrive
- **Service History** — searchable log of every record ever saved
- **Mileage Tracking** — per-unit mileage entries with auto-logging
  when records are saved
- **Past Records** — browse saved PDFs by month
- **Upload Scan** — for techs who'd rather hand-write and photograph;
  the app names + files the picture automatically
- **Dark mode** — toggle in toolbar; print output is always white-paper

### Behind the scenes
- Auto-saving drafts (debounced, 400ms) — close the app, reopen, you
  pick up where you left off
- Atomic JSON writes (`tmp` + rename) — safe against crashes mid-save,
  important for OneDrive-synced files
- HiDPI signature canvas — crisp on Retina / 4K displays
- Content-Security-Policy enforced, no remote network calls, no telemetry
- Sandbox + context-isolation enabled for the renderer

---

## Architecture

```
┌────────────────────────────────────────────────────────┐
│                Electron Main Process                   │
│  ┌──────────────────────────────────────────────────┐  │
│  │  main.js                                         │  │
│  │   • IPC handlers (PDF, history, mileage, scan)   │  │
│  │   • Atomic JSON file I/O                         │  │
│  │   • Config caching                               │  │
│  └──────────────────────────────────────────────────┘  │
│                        │                               │
│                contextBridge (preload.js)              │
│                        │                               │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Renderer (index.html + inline JS)               │  │
│  │   • Form, modals, dark mode, signature pad       │  │
│  │   • No external libs, no bundler                 │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
                         │
                         ▼
        ┌──────────────────────────────────┐
        │  OneDrive-synced shared folder   │
        │   • PDFs in YYYY-MM subfolders   │
        │   • sf-equipment.json (shared DB) │
        │   • sf-history.json              │
        │   • sf-mileage.json              │
        └──────────────────────────────────┘
                         │
                         ▼
                Other techs / office
            (read-only sync via OneDrive)
```

### Key architectural decisions

- **Electron, not a browser**: browsers can't write to arbitrary local
  paths, which is the whole point.
- **OneDrive sync, not Graph API**: zero auth complexity. The app
  writes to a local folder; OneDrive does the upload. Works in any
  Microsoft 365 environment without IT setup.
- **Shared JSON files instead of a database**: equipment list, history,
  and mileage live as JSON in the same SharePoint folder. Multi-user
  reads work freely; writes use atomic tmp-rename.
- **PIN gate in main process**: PIN check happens in `main.js`, not
  in the renderer, so the value isn't visible in DevTools.
- **No bundler**: a single inline `<script>` keeps the app trivial to
  debug and reason about. The whole renderer is one file.

---

## Project structure

```
service-record-app/
├── main.js                       # Electron main process + IPC handlers
├── preload.js                    # contextBridge (renderer ↔ main API)
├── index.html                    # The whole renderer (UI + JS)
├── package.json
├── assets/
│   ├── icon.png                  # Company logo (header + app icon)
│   └── icon.ico                  # Windows shortcut icon
├── Create Desktop Shortcut.bat   # Tech-side installer (calls .vbs)
├── Create Desktop Shortcut.vbs   # Native WSH shortcut creator
├── Launch.bat                    # Standalone launcher
├── setup.bat                     # First-time npm install
├── .gitignore
├── LICENSE
└── README.md
```

---

## Quick start

### Run from source (development)

```bash
git clone https://github.com/Marcus-Wh/sf-service-record.git
cd sf-service-record
npm install
npm start
```

Requires Node.js 18+ and npm. The app will launch with the SharePoint
folder unconfigured — click the **📁 SharePoint** button in the toolbar
to point it at any folder you'd like saved records to land in.

### Build a Windows installer

```bash
npm run build
```

Outputs to `dist/`. Note: `electron-builder` on Windows requires
**Developer Mode enabled** (Settings → Privacy & security → For
developers) to bypass symlink permission errors in `winCodeSign`.

### Distribute as a portable folder (no installer)

The `node_modules/` folder contains the Electron runtime, so the entire
app folder is portable. Drop it on any Windows PC and run
`Launch.bat` or use `Create Desktop Shortcut.bat` to install a Desktop icon.

---

## Configuration

On first run, the app stores its config at:

```
%APPDATA%\sf-service-record\sf-service-record.json
```

| Key | Purpose | Default |
|---|---|---|
| `sharepointPath` | Local folder where PDFs and shared JSONs live | `""` (prompted on save) |
| `adminPin` | PIN required to unlock the Equipment Manager | `0000` (placeholder) |

**You must override the default `adminPin`** before deploying to
techs. Either edit `sf-service-record.json` in `%APPDATA%\sf-service-record\`
to set your own PIN, or fork this repo and change `DEFAULT_PIN` in
`main.js`. The committed value (`0000`) is a placeholder.

---

## Security notes

- No external network calls. CSP locks down `connect-src` to `'self'`.
- Only `https://` URLs accepted by the `open-external` IPC; no
  `file://` or `javascript:` schemes can be opened from the renderer.
- All file paths from the renderer are validated in main before being
  passed to `shell.openPath`.
- Renderer runs sandboxed with context isolation. No direct Node access.
- Default Admin PIN is hardcoded — see Configuration above. Change it
  before any production deployment.

---

## Tech stack

- **Electron 28** — desktop runtime
- **Vanilla JavaScript** — no framework, no bundler, ~480 lines of JS
  in the renderer
- **Native HTML5 forms + CSS** — no UI library
- **Native Windows Script Host (VBScript)** — for the install-side
  shortcut creator (no PowerShell execution-policy headaches)
- **Atomic file I/O via `fs.renameSync`** — for crash-safety on
  OneDrive-synced shared JSON files
- **No backend, no database, no auth provider, no telemetry**

---

## Author

Built by **Marcus White** for St. Francis Electric's fleet shop.
[github.com/Marcus-Wh](https://github.com/Marcus-Wh)

---

## License

[MIT](LICENSE) — free to fork, adapt, and deploy in your own shop.
 
 