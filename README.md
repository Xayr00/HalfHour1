# HalfHour

A private, offline-capable daily planner built around **48 consecutive half-hour slots**. This is a plain HTML/CSS/JavaScript Progressive Web App (PWA); it has no framework, account system, backend, analytics, or external runtime dependencies.

## Included

- A 24-hour horizontal timeline with two vertically stacked half-hour slots in each hourly group.
- Date-specific schedules and a configurable starting hour from midnight through 11 PM.
- Both starting-time change modes: shift the whole schedule, or preserve actual clock times.
- Reusable Actions with editable names, slot labels, colours, and safe deletion.
- Independent slot labels, colours, and manual `None`, `Done`, `Skipped`, and `Moved` statuses.
- Editable, duplicable Templates, including four clearly marked starter examples. Applying a template copies it into the selected date; later changes are independent.
- Light/dark appearance, local IndexedDB storage, JSON export/import with validation, and a reset confirmation.
- A web app manifest, icons, and a service worker for caching the app shell.

## Technology and data

- **UI:** semantic HTML, CSS, vanilla JavaScript.
- **Persistence:** IndexedDB stores settings, Actions, Templates, and date schedules locally in the browser.
- **Offline shell:** a service worker caches the HTML, CSS, JavaScript, manifest, and icons after the first successful online load.
- **No backend:** schedule content stays in the browser's local storage. It is not synchronized to other devices.

This is a web app, not a native iOS app. Browser/site data can be removed by device settings, the browser, or app removal. Export a JSON backup regularly and keep it outside the app.

## Run locally on Windows

A PWA's install and service-worker features require HTTPS, except when developing on `localhost`. Do not open `index.html` as a `file://` URL.

1. Extract this folder to your PC.
2. Install Python 3 if it is not already installed.
3. Open Command Prompt in this folder and run:

   ```bat
   python -m http.server 8000
   ```

4. On that PC, open `http://localhost:8000/`.

This is useful for local development and testing. It does **not** make the app accessible to your iPhone unless the iPhone can reach the PC's server on the same network, and a LAN HTTP address will not provide the same install/offline behavior as a properly hosted HTTPS origin.

## Free HTTPS hosting (GitHub Pages)

GitHub Pages is a free static host for public repositories. A GitHub account is needed to host the files there; HalfHour itself never needs a login.

1. Sign in to GitHub and create a repository, for example `halfhour`.
2. Upload the **contents** of this folder to the repository's main branch. Make sure `index.html` is at the repository root and keep the `icons` folder.
3. In the repository, open **Settings → Pages**.
4. Under the build/deployment source, choose **Deploy from a branch**, select the `main` branch and `/(root)`, then save.
5. Open the URL GitHub Pages displays for your repository. It will resemble `https://YOUR-USERNAME.github.io/halfhour/`; use the actual URL shown by GitHub, not this example.
6. Keep the same site URL and path for future updates. IndexedDB data is associated with that browser origin.

Any static HTTPS host that serves these files unchanged can also work. No server-side functions, database, API keys, or paid infrastructure are needed.

## Install on iPhone

Use **Safari** on your iPhone and the real hosted HTTPS URL:

1. Open the hosted HalfHour page while online.
2. Leave the app open until it has finished loading. Open **Settings** inside HalfHour and look for the offline-shell status; the app only marks it checked after verifying its local shell files in the cache.
3. In Safari, tap **Share**.
4. Choose **Add to Home Screen**. If iOS shows an **Open as Web App** option, enable it.
5. Tap **Add**, then open HalfHour from the new Home Screen icon.
6. Verify that the Day timeline, Actions, Templates, and Settings screens open. Create a test slot, leave and reopen the app, and confirm the slot remains.
7. After the cache is verified, turn on Airplane Mode and launch HalfHour from its Home Screen icon to test offline launch. Turn connectivity back on afterward. Offline use should be tested on the actual iPhone; this project has not been pre-installed on your device.
8. In HalfHour → Settings → Backup & restore, tap **Export JSON** and save/share the downloaded backup to Files or another safe location.

## Back up and restore

- **Export:** Settings → Export JSON. The generated filename includes the local export date, for example `halfhour-backup-2026-10-25.json`.
- **Restore:** Settings → Choose file, select a prior HalfHour JSON backup, review the validation summary, then confirm the replacement. The import validates the supported schema, Actions, Template IDs, date keys, slot count, colours, and statuses before any existing records are replaced. A malformed or unsupported file is rejected.
- **Reset:** Settings → Reset data. This is separate from import and asks for confirmation; it resets to the editable starter examples.

## Updating without losing local data

1. Keep the deployed URL and path unchanged. Moving to a different hostname or path may create a different browser storage origin.
2. Upload the updated source files to the same hosted location.
3. When changing the app shell files, increment `CACHE_NAME` in `sw.js` (for example, from `halfhour-shell-v1` to `halfhour-shell-v2`). The new service worker will cache the new shell and remove the old HalfHour shell cache on activation.
4. Reopen the app online so the updated service worker can install. If the old UI remains, close and reopen the Home Screen app or reload the site after the update completes.
5. Keep a recent JSON backup before major changes. The IndexedDB schema version is explicitly defined in `app.js`; future schema changes should include a deliberate migration before increasing `DB_VERSION`.

## Limitations

- iOS controls how PWAs are installed, updated, kept in memory, and how website storage is retained. The app cannot guarantee that browser data will never be cleared.
- No notifications, cloud sync, accounts, collaborative scheduling, or native iOS integrations are implemented.
- The local development server is for testing. A stable HTTPS host is needed for ordinary PWA installation and service workers.
- Offline behavior must be confirmed on the target iPhone after the app has loaded and caching has completed.
- Only backup schema version 1 is currently accepted. Unsupported versions are rejected rather than guessed at or partially imported.

## Test notes

The detailed automated test report is in [`TEST-REPORT.md`](./TEST-REPORT.md). The current project passed 27 browser checks in headless Chromium, including timeline geometry, save/reload persistence, date isolation, both start-time modes, midnight/11 PM boundaries, Action and Template independence, offline reload after caching, backup export/import, invalid-file rejection, and reset confirmation. This is not a physical iPhone/Safari test; follow the iPhone installation steps above to verify Home Screen installation and offline behavior on the actual device.
