// Small constant lists duplicated from src/shared/constants.js — the renderer has no
// require() (contextIsolation + no bundler), so these tiny, stable lists are just
// mirrored here rather than pulling in a build step for a handful of literals.
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'heic', 'heif'];
const WEEKDAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

let vaults = [];
let settings = null;
let pendingParentPath = null;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function minutesToTimeValue(minutes) {
  const h = Math.floor(minutes / 60).toString().padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

function timeValueToMinutes(value) {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

function showVaultError(message) {
  const el = document.getElementById('vaultError');
  el.innerHTML = message ? `<div class="error-banner">${escapeHtml(message)}</div>` : '';
}

// preload's ipcRenderer.invoke rejects with an Error whose message is prefixed with the IPC
// channel/call-site info; strip that framing so the user sees just the underlying message.
function cleanIpcErrorMessage(err) {
  const raw = err?.message || String(err);
  const marker = 'Error: ';
  const idx = raw.lastIndexOf(marker);
  return idx === -1 ? raw : raw.slice(idx + marker.length);
}

// --- Vaults -----------------------------------------------------------------

document.getElementById('browseParentBtn').addEventListener('click', async () => {
  const parentPath = await window.api.pickFolder();
  if (!parentPath) return;
  pendingParentPath = parentPath;
  document.getElementById('parentPathLabel').textContent = parentPath;
  const subfolders = await window.api.listSubfolders(parentPath);
  renderSubfolderPicker(Array.isArray(subfolders) ? subfolders : []);
});

function renderSubfolderPicker(subfolders) {
  const el = document.getElementById('subfolderPicker');
  const existingRoots = new Set(vaults.map((v) => v.root_path));
  if (!subfolders.length) {
    el.innerHTML = '<p class="muted">No subfolders found.</p>';
    return;
  }
  el.innerHTML = `
    <div class="day-picker">
      ${subfolders
        .map((name) => {
          const rootPath = `${pendingParentPath}/${name}`;
          const already = existingRoots.has(rootPath);
          return `<label><input type="checkbox" value="${escapeHtml(name)}" ${already ? 'disabled checked' : ''} /> ${escapeHtml(name)}${already ? ' (added)' : ''}</label>`;
        })
        .join('')}
    </div>
    <button id="addVaultsBtn" class="btn btn-primary" style="margin-top:12px;">Add selected vaults</button>
  `;
  document.getElementById('addVaultsBtn').addEventListener('click', async () => {
    showVaultError(null);
    const checked = [...el.querySelectorAll('input[type="checkbox"]:not(:disabled):checked')].map((cb) => cb.value);
    try {
      for (const name of checked) {
        // Import/Archive folders are picked separately below, per-vault, once it's added —
        // matching the vault first, then import/archive folder as a follow-up step.
        await window.api.saveVaultConfig({
          name,
          rootPath: `${pendingParentPath}/${name}`,
          importFolderPath: null,
          archiveFolderPath: null,
          deleteAfterImport: false,
          enabled: true,
        });
      }
    } catch (err) {
      showVaultError(cleanIpcErrorMessage(err));
    }
    await loadVaults();
    renderSubfolderPicker(subfolders);
  });
}

async function loadVaults() {
  vaults = await window.api.getVaults();
  renderVaultList();
  renderAnalyzeVaultPicker();
}

function renderVaultList() {
  const el = document.getElementById('vaultList');
  if (!vaults.length) {
    el.innerHTML = '<p class="muted">No vaults configured yet.</p>';
    return;
  }
  el.innerHTML = vaults
    .map(
      (v) => `
      <div class="vault-item" data-vault-id="${v.id}">
        <div class="vault-item-header">
          <strong>${escapeHtml(v.name)}</strong>
          <span class="badge">${v.enabled ? 'Enabled' : 'Disabled'}</span>
        </div>
        <div class="muted" style="font-size:12px; margin:4px 0 10px;">${escapeHtml(v.root_path)}</div>
        ${!v.import_folder_path ? '<div class="muted" style="font-size:12.5px; margin-bottom:8px;">Set an Import folder below to start bringing in new documents.</div>' : ''}

        <label>Import folder</label>
        <div class="field-row">
          <input type="text" class="import-folder-input" value="${escapeHtml(v.import_folder_path || '')}" readonly />
          <button class="btn btn-outline pick-import-btn" style="flex:0 0 auto;">Browse…</button>
        </div>

        <label>Archive folder</label>
        <div class="field-row">
          <input type="text" class="archive-folder-input" value="${escapeHtml(v.archive_folder_path || '')}" readonly />
          <button class="btn btn-outline pick-archive-btn" style="flex:0 0 auto;">Browse…</button>
        </div>

        <div class="checkbox-row">
          <input type="checkbox" class="delete-after-import-cb" ${v.delete_after_import ? 'checked' : ''} />
          <label style="margin:0;">Delete document after import (instead of archiving)</label>
        </div>
        <div class="checkbox-row">
          <input type="checkbox" class="enabled-cb" ${v.enabled ? 'checked' : ''} />
          <label style="margin:0;">Enabled</label>
        </div>

        <div style="margin-top:10px; display:flex; gap:8px;">
          <button class="btn btn-outline save-vault-btn">Save</button>
          <button class="btn btn-danger remove-vault-btn">Remove</button>
        </div>
      </div>`
    )
    .join('');

  el.querySelectorAll('.vault-item').forEach((item) => {
    const vaultId = Number(item.dataset.vaultId);
    const vault = vaults.find((v) => v.id === vaultId);

    item.querySelector('.pick-import-btn').addEventListener('click', async () => {
      const picked = await window.api.pickFolder();
      if (picked) item.querySelector('.import-folder-input').value = picked;
    });
    item.querySelector('.pick-archive-btn').addEventListener('click', async () => {
      const picked = await window.api.pickFolder();
      if (picked) item.querySelector('.archive-folder-input').value = picked;
    });
    item.querySelector('.save-vault-btn').addEventListener('click', async () => {
      showVaultError(null);
      try {
        await window.api.saveVaultConfig({
          id: vault.id,
          name: vault.name,
          rootPath: vault.root_path,
          importFolderPath: item.querySelector('.import-folder-input').value || null,
          archiveFolderPath: item.querySelector('.archive-folder-input').value || null,
          deleteAfterImport: item.querySelector('.delete-after-import-cb').checked,
          enabled: item.querySelector('.enabled-cb').checked,
        });
      } catch (err) {
        showVaultError(cleanIpcErrorMessage(err));
      }
      await loadVaults();
    });
    item.querySelector('.remove-vault-btn').addEventListener('click', async () => {
      await window.api.removeVault(vaultId);
      await loadVaults();
    });
  });
}

function renderAnalyzeVaultPicker() {
  const el = document.getElementById('analyzeVaultPicker');
  if (!vaults.length) {
    el.innerHTML = '<p class="muted">Add a vault first.</p>';
    return;
  }
  el.innerHTML = vaults
    .map(
      (v) => `
      <div class="stat-row">
        <span>${escapeHtml(v.name)}${v.last_analyzed_at_utc ? ` <span class="muted">(last analyzed ${escapeHtml(v.last_analyzed_at_utc)})</span>` : ''}</span>
        <button class="btn btn-outline analyze-btn" data-vault-id="${v.id}">Analyze now</button>
      </div>`
    )
    .join('');
  el.querySelectorAll('.analyze-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Queued…';
      await window.api.runAnalyzeVault(Number(btn.dataset.vaultId));
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = 'Analyze now';
      }, 2000);
    });
  });
}

// --- Timezone -----------------------------------------------------------------

function populateTimezoneSelect(selected) {
  const select = document.getElementById('timezoneSelect');
  let zones = ['UTC'];
  if (typeof Intl.supportedValuesOf === 'function') {
    zones = Intl.supportedValuesOf('timeZone');
  }
  select.innerHTML = zones.map((z) => `<option value="${z}">${z}</option>`).join('');
  select.value = selected || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// --- Day picker -----------------------------------------------------------------

function renderDayPicker(daysMask) {
  const el = document.getElementById('dayPicker');
  el.innerHTML = WEEKDAY_LABELS.map(
    (label, i) => `<label><input type="checkbox" data-bit="${i}" ${daysMask & (1 << i) ? 'checked' : ''} /> ${label}</label>`
  ).join('');
}

function readDaysMask() {
  let mask = 0;
  document.querySelectorAll('#dayPicker input[type="checkbox"]').forEach((cb) => {
    if (cb.checked) mask |= 1 << Number(cb.dataset.bit);
  });
  return mask;
}

// --- Image types -----------------------------------------------------------------

function renderImageTypePicker(enabledList) {
  const el = document.getElementById('imageTypePicker');
  const enabled = new Set(enabledList);
  el.innerHTML = IMAGE_EXTENSIONS.map(
    (ext) => `<label class="checkbox-row"><input type="checkbox" data-ext="${ext}" ${enabled.has(ext) ? 'checked' : ''} /> ${ext}</label>`
  ).join('');
}

function readImageTypes() {
  return [...document.querySelectorAll('#imageTypePicker input[type="checkbox"]:checked')].map((cb) => cb.dataset.ext);
}

// --- Load / Save -----------------------------------------------------------------

async function loadSettings() {
  settings = await window.api.getSettings();
  populateTimezoneSelect(settings.timezone);
  renderDayPicker(settings.scheduleDaysMask);
  document.getElementById('startTime').value = minutesToTimeValue(settings.scheduleStartMinutes);
  document.getElementById('endTime').value = minutesToTimeValue(
    settings.scheduleEndMinutes >= 1440 ? 1439 : settings.scheduleEndMinutes
  );
  renderImageTypePicker(settings.imageTypesEnabled);
}

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('saveStatus');
  const endTimeValue = document.getElementById('endTime').value;
  const startTimeValue = document.getElementById('startTime').value;
  await window.api.updateSettings({
    timezone: document.getElementById('timezoneSelect').value,
    scheduleDaysMask: readDaysMask(),
    scheduleStartMinutes: timeValueToMinutes(startTimeValue),
    scheduleEndMinutes: endTimeValue === '23:59' ? 1440 : timeValueToMinutes(endTimeValue),
    imageTypesEnabled: readImageTypes(),
  });
  statusEl.textContent = 'Saved.';
  setTimeout(() => (statusEl.textContent = ''), 2000);
});

// --- Backup & migration -----------------------------------------------------------

function showMigrationStatus(message, isError) {
  const el = document.getElementById('migrationStatus');
  el.textContent = message || '';
  el.style.color = isError ? 'var(--ember)' : '';
}

document.getElementById('exportDbBtn').addEventListener('click', async () => {
  const destPath = await window.api.pickExportDestination();
  if (!destPath) return;
  showMigrationStatus('Exporting…');
  try {
    await window.api.exportDatabase(destPath);
    showMigrationStatus(`Exported to ${destPath}`);
  } catch (err) {
    showMigrationStatus(cleanIpcErrorMessage(err), true);
  }
});

let pendingImportFilePath = null;
let pendingImportVaults = [];
let importResolutions = {}; // vaultId -> { action: 'reroute', newPath } | { action: 'remove' }

document.getElementById('importDbBtn').addEventListener('click', async () => {
  const filePath = await window.api.pickImportFile();
  if (!filePath) return;
  pendingImportFilePath = filePath;
  importResolutions = {};
  document.getElementById('importResolution').innerHTML = '';
  showMigrationStatus('Analyzing…');
  try {
    pendingImportVaults = await window.api.analyzeImportDatabase(filePath);
  } catch (err) {
    showMigrationStatus(cleanIpcErrorMessage(err), true);
    return;
  }
  showMigrationStatus('');
  renderImportResolution();
});

function renderImportResolution() {
  const el = document.getElementById('importResolution');
  const mismatched = pendingImportVaults.filter((v) => !v.pathExists);
  const matchedCount = pendingImportVaults.length - mismatched.length;

  const mismatchRows = mismatched
    .map(
      (v) => `
      <div class="vault-item" data-import-vault-id="${v.id}">
        <div class="vault-item-header">
          <strong>${escapeHtml(v.name)}</strong>
          <span class="badge" style="background:var(--ember); color:#fff;">Folder not found</span>
        </div>
        <div class="muted" style="font-size:12px; margin:4px 0 10px;">${escapeHtml(v.rootPath)}</div>
        <div class="field-row">
          <input type="text" class="new-path-input" placeholder="Pick the new folder location…" readonly />
          <button class="btn btn-outline pick-new-path-btn" style="flex:0 0 auto;">Browse…</button>
        </div>
        <div class="checkbox-row">
          <input type="checkbox" class="remove-vault-cb" />
          <label style="margin:0;">Remove this vault instead (don't import it)</label>
        </div>
      </div>`
    )
    .join('');

  el.innerHTML = `
    <p class="muted">${matchedCount} of ${pendingImportVaults.length} vault folder(s) found as-is on this machine.</p>
    ${mismatched.length
      ? `<p class="muted">${mismatched.length} folder(s) weren't found here — pick their new location, or remove them from the import:</p>${mismatchRows}`
      : ''}
    <button id="confirmImportBtn" class="btn btn-primary" style="margin-top:12px;">Import now</button>
  `;

  el.querySelectorAll('[data-import-vault-id]').forEach((item) => {
    const vaultId = Number(item.dataset.importVaultId);
    const pathInput = item.querySelector('.new-path-input');
    const removeCb = item.querySelector('.remove-vault-cb');

    item.querySelector('.pick-new-path-btn').addEventListener('click', async () => {
      const picked = await window.api.pickFolder();
      if (!picked) return;
      pathInput.value = picked;
      removeCb.checked = false;
      importResolutions[vaultId] = { action: 'reroute', newPath: picked };
    });
    removeCb.addEventListener('change', () => {
      if (removeCb.checked) {
        pathInput.value = '';
        importResolutions[vaultId] = { action: 'remove' };
      } else {
        delete importResolutions[vaultId];
      }
    });
  });

  document.getElementById('confirmImportBtn').addEventListener('click', async () => {
    const stillUnresolved = mismatched.filter((v) => !importResolutions[v.id]);
    if (stillUnresolved.length) {
      showMigrationStatus(
        `Resolve all ${mismatched.length} missing folder(s) first (pick a new location or remove the vault).`,
        true
      );
      return;
    }
    showMigrationStatus('Importing… the background worker will restart.');
    try {
      await window.api.applyImportDatabase(pendingImportFilePath, importResolutions);
      showMigrationStatus('Import complete.');
      document.getElementById('importResolution').innerHTML = '';
      pendingImportFilePath = null;
      pendingImportVaults = [];
      importResolutions = {};
      await loadVaults();
      await loadSettings();
    } catch (err) {
      showMigrationStatus(cleanIpcErrorMessage(err), true);
    }
  });
}

(async function init() {
  await loadVaults();
  await loadSettings();
})();
