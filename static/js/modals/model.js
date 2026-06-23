import { API } from '../utils.js';

// Mirror of the model subfolders ComfyUI knows about (folder_paths.py).
// Ordered roughly by frequency of use so the common ones surface first.
// The <select> also gets a "Custom..." option that reveals a free-text
// input, so users can target any folder the runner accepts.
const MODEL_DIRS = [
  'checkpoints', 'loras', 'vae', 'controlnet', 'upscale_models',
  'clip', 'clip_vision', 'text_encoders', 'embeddings',
  'unet', 'diffusion_models', 'diffusers',
  'ipadapter', 'hypernetworks', 'style_models', 'gligen', 'photomaker',
  'audio_encoders', 'vae_approx', 'model_patches',
  'configs', 'background_removal', 'frame_interpolation', 'optical_flow',
  'latent_upscale_models',
];
const CUSTOM_DIR_VALUE = '__custom__';

let _mmHost = null;
let _mmInst = null;
let _mmFile = null;

// State for the Manage tab. Cached across tab switches so the list doesn't
// re-fetch on every flick between Download/Upload/Manage. Cleared whenever
// the modal opens on a different instance (see openModelModal).
const _mmManageState = {
  loaded: false,
  folders: [],            // ["checkpoints", "loras", ...]
  files: {},              // {checkpoints: ["sd15.safetensors", ...], ...}
  // Per-folder load state. Folders are listed eagerly (so the sidebar is
  // populated instantly) but their file lists are fetched lazily, one
  // network call per folder. This avoids fanning out 25 parallel proxied
  // requests on first open — the dashboard's proxy spawns a curl subprocess
  // per request, which is very slow when done concurrently.
  //   undefined = not requested yet
  //   'loading' = fetch in flight
  //   'loaded'  = files present in files[folder]
  //   'error'   = fetch failed
  folderStatus: {},
  filter: '',
  busy: null,             // "{dir}/{file}" while a move/copy is in flight
  selectedFolder: null,   // active folder in the left sidebar (null = first non-empty)
};

export function openModelModal(host, instName, tab = 'download') {
  // Manage cache is per-instance — reset when the modal targets a new one,
  // otherwise switching instances would show stale files from the previous.
  if (_mmHost !== host || _mmInst !== instName) {
    _mmManageState.loaded = false;
    _mmManageState.folders = [];
    _mmManageState.files = {};
    _mmManageState.folderStatus = {};
    _mmManageState.filter = '';
    _mmManageState.busy = null;
    _mmManageState.selectedFolder = null;
  }
  _mmHost = host;
  _mmInst = instName;
  _mmFile = null;

  document.getElementById('mm-instance').textContent = instName;

  ['mm-url', 'mm-dl-name', 'mm-dl-token', 'mm-ul-name',
   'mm-dl-dir-custom', 'mm-ul-dir-custom'].forEach(id => {
    document.getElementById(id).value = '';
  });

  const zone = document.getElementById('mm-drop-zone');
  zone.textContent = 'Click to select or drag & drop a model file';
  zone.className = 'drop-zone';
  document.getElementById('mm-file-input').value = '';
  document.getElementById('mm-progress-wrap').classList.remove('visible');
  document.getElementById('mm-progress-fill').style.width = '0%';

  ['mm-dl-resp', 'mm-ul-resp'].forEach(id => {
    const el = document.getElementById(id);
    el.className = 'mm-resp';
    el.textContent = '';
  });

  _renderDirSelect('mm-dl-dir-select', 'mm-dl-dir-custom');
  _renderDirSelect('mm-ul-dir-select', 'mm-ul-dir-custom');

  mmSwitchTab(tab);
  document.getElementById('model-modal').classList.add('open');
}

export function closeModelModal() {
  document.getElementById('model-modal').classList.remove('open');
}

export function mmSwitchTab(tab) {
  const order = ['download', 'upload', 'manage'];
  document.querySelectorAll('.mm-tab').forEach((t, i) => {
    t.classList.toggle('active', order[i] === tab);
  });
  document.getElementById('mm-pane-download').classList.toggle('active', tab === 'download');
  document.getElementById('mm-pane-upload').classList.toggle('active', tab === 'upload');
  document.getElementById('mm-pane-manage').classList.toggle('active', tab === 'manage');

  // Manage needs a much wider modal — model filenames are routinely long
  // (run-id + base model + variant + .safetensors > 60 chars). The other
  // panes have short forms and stay tight at 640px.
  const box = document.getElementById('mm-modal-box');
  if (box) {
    box.style.width = tab === 'manage' ? '1080px' : '640px';
  }

  if (tab === 'manage') {
    // Lazy-load on first visit; subsequent visits keep cached list.
    if (!_mmManageState.loaded) mmManageRefresh();
  }
}

export function mmDirSelectChange(pane) {
  const sel = document.getElementById(pane === 'download' ? 'mm-dl-dir-select' : 'mm-ul-dir-select');
  const custom = document.getElementById(pane === 'download' ? 'mm-dl-dir-custom' : 'mm-ul-dir-custom');
  const isCustom = sel.value === CUSTOM_DIR_VALUE;
  custom.style.display = isCustom ? 'block' : 'none';
  if (isCustom) custom.focus();
}

// Backwards-compat: still exported because app.js wires it onto window in
// case any inline handler (or older cached HTML) references it.
export function mmSelectDir() { /* no-op — legacy pill API */ }

export function mmFileSelected(input) {
  const file = input.files[0];
  if (!file) return;
  _setFile(file);
}

function _setFile(file) {
  _mmFile = file;
  const zone = document.getElementById('mm-drop-zone');
  zone.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
  zone.className = 'drop-zone has-file';
  if (!document.getElementById('mm-ul-name').value) {
    document.getElementById('mm-ul-name').value = file.name;
  }
}

function _renderDirSelect(selectId, customId) {
  const sel = document.getElementById(selectId);
  const opts = MODEL_DIRS.map(d => `<option value="${d}">${d}</option>`).join('');
  sel.innerHTML = `${opts}<option value="${CUSTOM_DIR_VALUE}">Custom…</option>`;
  sel.value = MODEL_DIRS[0];
  document.getElementById(customId).style.display = 'none';
}

function _resolveDir(pane) {
  const sel = document.getElementById(pane === 'download' ? 'mm-dl-dir-select' : 'mm-ul-dir-select');
  if (sel.value === CUSTOM_DIR_VALUE) {
    return document.getElementById(pane === 'download' ? 'mm-dl-dir-custom' : 'mm-ul-dir-custom').value.trim();
  }
  return sel.value;
}

function _showResp(pane, text, isError) {
  const id = pane === 'download' ? 'mm-dl-resp' : 'mm-ul-resp';
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = `mm-resp visible${isError ? ' error' : ''}`;
}

// Poll /job/<id> every 2s until the job leaves the 'running' state. No
// arbitrary iteration cap — large model downloads can run for hours, and
// silently giving up while bytes are still flying makes the UI lie about
// completion. Stop conditions: terminal status (done/error/cancelled),
// hard wall-clock timeout, or transport failure.
async function _pollJob(jobId, pane) {
  const HARD_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6h — covers multi-GB pulls
  const start = Date.now();

  while (true) {
    if (Date.now() - start > HARD_TIMEOUT_MS) {
      _showResp(pane, `Job ${jobId} still running after 6h — stopped polling.\nRecover via GET /job/${jobId}.`, true);
      return;
    }
    await new Promise(r => setTimeout(r, 2000));

    let data;
    try {
      const r = await fetch(`${API}/api/proxy/${encodeURIComponent(_mmHost)}/job/${jobId}`);
      data = await r.json();
      if (!r.ok) {
        _showResp(pane, `Job poll failed (HTTP ${r.status}):\n${JSON.stringify(data, null, 2)}`, true);
        return;
      }
    } catch (e) {
      _showResp(pane, `Job poll error: ${e.message}`, true);
      return;
    }

    const status = data.status || '';
    // Server stores raw stdout chunks under 'output' (not 'output_lines'),
    // already split by line. Take the last few for tailing.
    const out = Array.isArray(data.output) ? data.output : [];
    const tail = out.slice(-5).join('').replace(/\n+$/, '');

    if (status === 'done') {
      // 'done' from the job tracker only means the worker thread didn't
      // throw — download_models() catches HTTP 4xx/5xx and stuffs them
      // into result.errors / result.failed, so we MUST inspect the
      // result payload here instead of blindly saying "Done!".
      const summary = _summarizeDownloadResult(data.result, tail);
      _showResp(pane, summary.text, summary.isError);
      return;
    }
    // Server emits 'error' for failures and 'cancelled' for user-cancels;
    // 'failed' was the wrong field name in the previous implementation.
    if (status === 'error' || status === 'cancelled') {
      _showResp(pane, `${status === 'cancelled' ? 'Cancelled' : 'Failed'}: ${data.error || ''}\n${tail}`, true);
      return;
    }
    _showResp(pane, `[${status || 'running'}]\n${tail || '(no output yet)'}`, false);
  }
}

// Inspect a finished /download-model job result. The runner uses the
// shape { downloaded: [...], skipped: [...], failed: [...], errors: [...] }
// (see comfy_runner/workflow_models.py:download_models). For other endpoints
// (or unknown shapes) fall back to dumping the JSON.
function _summarizeDownloadResult(result, tail) {
  if (!result || typeof result !== 'object') {
    return { text: `Done!\n${tail || '(no output)'}`, isError: false };
  }

  const downloaded = Array.isArray(result.downloaded) ? result.downloaded : null;
  const failed     = Array.isArray(result.failed)     ? result.failed     : null;
  const errors     = Array.isArray(result.errors)     ? result.errors     : [];
  const skipped    = Array.isArray(result.skipped)    ? result.skipped    : [];

  // Not a download-model shape — show the raw result.
  if (downloaded === null || failed === null) {
    return {
      text: `Done!\n${tail || ''}\n\nResult:\n${JSON.stringify(result, null, 2)}`.trim(),
      isError: false,
    };
  }

  const lines = [];
  if (failed.length > 0) {
    lines.push(downloaded.length > 0 ? '⚠ Partially failed' : '✗ Download failed');
    if (errors.length) {
      lines.push('', 'Errors:');
      for (const e of errors) lines.push(`  • ${e}`);
    } else {
      // Shouldn't happen, but be defensive.
      lines.push('', 'Failed files:');
      for (const f of failed) lines.push(`  • ${f}`);
    }
    if (downloaded.length) {
      lines.push('', 'Downloaded:');
      for (const d of downloaded) lines.push(`  • ${d}`);
    }
    if (skipped.length) {
      lines.push('', 'Skipped (already present):');
      for (const s of skipped) lines.push(`  • ${s}`);
    }
    if (tail) lines.push('', '--- output tail ---', tail);
    return { text: lines.join('\n'), isError: true };
  }

  // No failures.
  lines.push('✓ Done');
  if (downloaded.length) {
    lines.push('', 'Downloaded:');
    for (const d of downloaded) lines.push(`  • ${d}`);
  }
  if (skipped.length) {
    lines.push('', 'Skipped (already present):');
    for (const s of skipped) lines.push(`  • ${s}`);
  }
  if (!downloaded.length && !skipped.length) {
    // Empty result — odd, surface it.
    lines.push('(nothing was downloaded or skipped — unexpected, check runner logs)');
  }
  if (tail) lines.push('', '--- output tail ---', tail);
  return { text: lines.join('\n'), isError: false };
}

export async function submitDownload() {
  const url   = document.getElementById('mm-url').value.trim();
  const dir   = _resolveDir('download');
  const name  = document.getElementById('mm-dl-name').value.trim();
  const token = document.getElementById('mm-dl-token').value.trim();

  if (!url) { _showResp('download', 'URL is required', true); return; }
  if (!dir) { _showResp('download', 'Directory is required', true); return; }

  const btn = document.getElementById('mm-dl-btn');
  btn.disabled = true; btn.textContent = '⏳ Starting…';
  _showResp('download', '…', false);

  const body = { url, directory: dir };
  if (name)  body.name  = name;
  if (token) body.token = token;

  try {
    const r = await fetch(`${API}/api/proxy/${encodeURIComponent(_mmHost)}/${_mmInst}/download-model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (data.skipped) {
      _showResp('download', `Already exists: ${data.name}`, false);
    } else if (data.job_id) {
      _showResp('download', `Download started (job ${data.job_id})\nPolling progress…`, false);
      btn.textContent = '⏳ Downloading…';
      // Await the poll so the button stays disabled / labelled until the
      // job actually reaches a terminal status.
      await _pollJob(data.job_id, 'download');
    } else {
      _showResp('download', JSON.stringify(data, null, 2), !r.ok);
    }
  } catch (e) {
    _showResp('download', `Error: ${e.message}`, true);
  } finally {
    btn.disabled = false; btn.textContent = '⬇ Download';
  }
}

export async function submitUpload() {
  if (!_mmFile) { _showResp('upload', 'Please select a file', true); return; }
  const dir  = _resolveDir('upload');
  const name = document.getElementById('mm-ul-name').value.trim() || _mmFile.name;
  if (!dir)  { _showResp('upload', 'Directory is required', true); return; }

  const btn = document.getElementById('mm-ul-btn');
  btn.disabled = true; btn.textContent = '⏳ Uploading…';

  const progressWrap = document.getElementById('mm-progress-wrap');
  const progressFill = document.getElementById('mm-progress-fill');
  progressWrap.classList.add('visible');
  progressFill.style.width = '0%';

  const form = new FormData();
  form.append('file', _mmFile, name);
  form.append('directory', dir);
  form.append('name', name);

  try {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API}/api/proxy/${encodeURIComponent(_mmHost)}/${_mmInst}/upload-model`);
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) {
          const pct = Math.round(e.loaded / e.total * 100);
          progressFill.style.width = `${pct}%`;
          _showResp('upload', `Uploading… ${pct}%`, false);
        }
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.ok) {
            _showResp('upload', `Upload complete: ${name}`, false);
            progressFill.style.width = '100%';
          } else {
            _showResp('upload', `Error: ${data.error || xhr.responseText}`, true);
          }
        } catch { _showResp('upload', xhr.responseText, xhr.status >= 400); }
        resolve();
      };
      xhr.onerror = () => { _showResp('upload', 'Network error', true); reject(); };
      xhr.send(form);
    });
  } finally {
    btn.disabled = false; btn.textContent = '⬆ Upload';
  }
}

// drag and drop setup (called once on init)
export function initDropZone() {
  const zone = document.getElementById('mm-drop-zone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) _setFile(file);
  });

  document.getElementById('model-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModelModal();
  });

  // Live filter as the user types in the manage pane. Search has to look
  // across every folder, so the first keystroke kicks off lazy-loading of
  // any folders we haven't fetched yet — results flow in as they arrive.
  const filter = document.getElementById('mm-mg-filter');
  if (filter) {
    filter.addEventListener('input', () => {
      const prev = _mmManageState.filter;
      _mmManageState.filter = filter.value.toLowerCase().trim();
      if (_mmManageState.filter && !prev) {
        _mmEnsureAllFoldersLoaded();
      }
      _mmRenderManage();
    });
  }
}

// ── Manage tab ──────────────────────────────────────────────────────────────
//
// Lists existing models grouped by folder (checkpoints/, loras/, …) and lets
// you Move or Copy a file between folders via POST /<inst>/move-model.
//
// Listing depends on the instance being live: we proxy through the runner's
// /<inst>/comfyui/ passthrough to ComfyUI's built-in `GET /models` +
// `GET /models/{folder}` API. When the instance is stopped, the proxy
// returns 503 and we show an actionable message instead of an opaque error.

function _escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function _comfyFetch(subpath) {
  // The runner's /<inst>/comfyui/ proxy strips the leading slash before
  // forwarding, so we hand it a relative path.
  const url = `${API}/api/proxy/${encodeURIComponent(_mmHost)}/${encodeURIComponent(_mmInst)}/comfyui/${subpath}`;
  return fetch(url, { cache: 'no-store' });
}

export async function mmManageRefresh() {
  const statusEl  = document.getElementById('mm-mg-status');
  const browserEl = document.getElementById('mm-mg-browser');
  statusEl.textContent = 'Loading folder list…';
  if (browserEl) browserEl.style.display = 'none';

  // Reset per-folder caches on a manual refresh so stale "loaded" state
  // doesn't suppress a re-fetch after the user moves files outside the UI.
  _mmManageState.files = {};
  _mmManageState.folderStatus = {};

  try {
    const r = await _comfyFetch('models');
    if (r.status === 503) {
      statusEl.innerHTML = `<span style="color:var(--amber)">Instance is not running — start it first to manage models.</span>`;
      _mmManageState.loaded = false;
      return;
    }
    if (!r.ok) {
      statusEl.innerHTML = `<span style="color:var(--red)">Could not list folders (HTTP ${r.status}). The instance must be running on a ComfyUI version that exposes /models.</span>`;
      _mmManageState.loaded = false;
      return;
    }
    const folders = await r.json();
    if (!Array.isArray(folders) || !folders.length) {
      statusEl.textContent = 'No model folders reported by ComfyUI.';
      _mmManageState.loaded = true;
      _mmManageState.folders = [];
      _mmRenderManage();
      return;
    }

    // Sidebar is renderable immediately — counts will fill in as folder
    // contents trickle back. Pick a sensible default folder so something
    // useful is visible right away.
    _mmManageState.loaded = true;
    _mmManageState.folders = folders;
    if (!_mmManageState.selectedFolder
        || !folders.includes(_mmManageState.selectedFolder)) {
      _mmManageState.selectedFolder = folders[0];
    }
    statusEl.textContent = '';
    _mmRenderManage();

    // Eagerly fetch the currently-selected folder so the file pane isn't
    // empty on first paint. Everything else loads lazily on click.
    _mmLoadFolderFiles(_mmManageState.selectedFolder);
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--red)">${_escHtml(e.message)}</span>`;
    _mmManageState.loaded = false;
  }
}

// Fetch a single folder's file list. No-ops if already loaded or in flight.
// Re-renders on completion so the file pane + sidebar count update.
async function _mmLoadFolderFiles(folder) {
  if (!folder) return;
  const st = _mmManageState.folderStatus[folder];
  if (st === 'loading' || st === 'loaded') return;

  _mmManageState.folderStatus[folder] = 'loading';
  _mmRenderManage();

  try {
    const r = await _comfyFetch(`models/${encodeURIComponent(folder)}`);
    if (!r.ok) {
      _mmManageState.files[folder] = [];
      _mmManageState.folderStatus[folder] = 'error';
      _mmRenderManage();
      return;
    }
    const data = await r.json();
    const files = Array.isArray(data)
      ? data.map(item => typeof item === 'string' ? item : item?.name).filter(Boolean)
      : [];
    _mmManageState.files[folder] = files;
    _mmManageState.folderStatus[folder] = 'loaded';
  } catch {
    _mmManageState.files[folder] = [];
    _mmManageState.folderStatus[folder] = 'error';
  }
  _mmRenderManage();
}

// Pick a folder in the sidebar — clears any active search filter so the
// folder's full contents are visible.
export function mmManageSelectFolder(folder) {
  _mmManageState.selectedFolder = folder;
  // If a filter was hiding everything except this folder's matches, drop it.
  if (_mmManageState.filter) {
    _mmManageState.filter = '';
    const filterEl = document.getElementById('mm-mg-filter');
    if (filterEl) filterEl.value = '';
  }
  _mmRenderManage();
  // Lazy-fetch this folder's contents if we haven't already.
  _mmLoadFolderFiles(folder);
}

// Trigger lazy load for every not-yet-fetched folder. Called when the user
// starts searching, since search has to look across all folders.
function _mmEnsureAllFoldersLoaded() {
  for (const f of _mmManageState.folders) {
    if (!_mmManageState.folderStatus[f]) {
      _mmLoadFolderFiles(f);
    }
  }
}

function _mmRenderManage() {
  const browserEl = document.getElementById('mm-mg-browser');
  const foldersEl = document.getElementById('mm-mg-folders');
  const filesEl   = document.getElementById('mm-mg-files');
  const { folders, files, filter, busy, selectedFolder } = _mmManageState;

  // ── Folder sidebar — always rendered, always visible. Counts include all
  // files in the folder regardless of the active search filter so users
  // can still see the "real" inventory while searching.
  if (!folders.length) {
    browserEl.style.display = 'none';
    return;
  }
  browserEl.style.display = '';
  const { folderStatus } = _mmManageState;
  foldersEl.innerHTML = folders.map(folder => {
    const status = folderStatus[folder];
    const count = (files[folder] || []).length;
    const active = folder === selectedFolder && !filter;
    const isEmpty = status === 'loaded' && count === 0;
    // Counter: a real number when loaded, a tiny spinner when fetching,
    // a dash when we haven't asked yet, "!" on error.
    let counterHtml;
    if (status === 'loading')     counterHtml = `<span class="mm-mg-folder-spin"></span>`;
    else if (status === 'error')  counterHtml = `<span class="mm-mg-folder-count" title="Failed to load">!</span>`;
    else if (status === 'loaded') counterHtml = `<span class="mm-mg-folder-count">${count}</span>`;
    else                          counterHtml = `<span class="mm-mg-folder-count mm-mg-folder-count-unknown">·</span>`;
    return `
      <div class="mm-mg-folder-item${active ? ' active' : ''}${isEmpty ? ' is-empty' : ''}"
           data-folder="${_escHtml(folder)}"
           onclick="window.mmManageSelectFolder(${JSON.stringify(folder).replace(/"/g, '&quot;')})">
        <span class="mm-mg-folder-icon">▸</span>
        <span class="mm-mg-folder-name">${_escHtml(folder)}</span>
        ${counterHtml}
      </div>`;
  }).join('');

  // ── File pane ──
  // Two modes:
  //   - filter active: search across all folders, show "[folder] filename" hits
  //   - no filter: just the contents of the currently-selected folder
  if (filter) {
    _renderFilterResults(filesEl);
  } else {
    _renderFolderContents(filesEl, selectedFolder);
  }
}

function _renderFilterResults(filesEl) {
  const { folders, files, filter, busy } = _mmManageState;
  const destOptions = folders
    .map(d => `<option value="${_escHtml(d)}">${_escHtml(d)}</option>`)
    .join('');

  const hits = [];
  for (const folder of folders) {
    for (const file of files[folder] || []) {
      if (!file.toLowerCase().includes(filter)) continue;
      hits.push({ folder, file });
    }
  }

  // Tell the user we're still loading some folders, so an empty result
  // during the initial fan-out doesn't look final.
  const { folderStatus } = _mmManageState;
  const stillLoading = _mmManageState.folders.filter(
    f => folderStatus[f] === 'loading' || folderStatus[f] === undefined,
  );
  const progressLabel = stillLoading.length
    ? ` <span style="color:var(--text-3)">(${_mmManageState.folders.length - stillLoading.length}/${_mmManageState.folders.length} folders loaded…)</span>`
    : '';

  if (!hits.length) {
    filesEl.innerHTML = `
      <div class="mm-mg-files-header">
        <span class="mm-mg-files-title">Search results</span>
        <span class="mm-mg-files-meta">0 matches for "${_escHtml(filter)}"${progressLabel}</span>
      </div>
      <div class="mm-mg-empty">${stillLoading.length
        ? `<span class="spinner"></span> Searching… ${stillLoading.length} folder${stillLoading.length === 1 ? '' : 's'} left to load.`
        : 'No files match. Clear the search to browse by folder.'}</div>`;
    return;
  }

  const rows = hits.map(({ folder, file }) => {
    const fileKey = `${folder}/${file}`;
    const isBusy = busy === fileKey;
    const defaultDest = folders.find(d => d !== folder) || folder;
    const destSelect = destOptions
      .replace(`value="${_escHtml(defaultDest)}"`, `value="${_escHtml(defaultDest)}" selected`);
    const actions = isBusy
      ? `<span class="mm-mg-row-spinner"><span class="spinner"></span> Working…</span>`
      : `<span class="mm-mg-arrow">→</span>
         <select class="ep-input mm-mg-dest" data-from="${_escHtml(folder)}" data-file="${_escHtml(file)}">${destSelect}</select>
         <button class="btn-ghost btn-sm" onclick="window.mmManageDo(this, false)">Move</button>
         <button class="btn-ghost btn-sm" onclick="window.mmManageDo(this, true)">Copy</button>`;
    return `
      <div class="mm-mg-row${isBusy ? ' is-busy' : ''}">
        <span class="mm-mg-row-loc" title="${_escHtml(folder)}">${_escHtml(folder)}/</span>
        <span class="mm-mg-filename" title="${_escHtml(fileKey)}">${_escHtml(file)}</span>
        <span class="mm-mg-actions">${actions}</span>
      </div>`;
  }).join('');

  filesEl.innerHTML = `
    <div class="mm-mg-files-header">
      <span class="mm-mg-files-title">Search results</span>
      <span class="mm-mg-files-meta">${hits.length} match${hits.length === 1 ? '' : 'es'} for "${_escHtml(filter)}"${progressLabel}</span>
    </div>
    <div class="mm-mg-rows">${rows}</div>`;
}

function _renderFolderContents(filesEl, folder) {
  const { folders, files, busy, folderStatus } = _mmManageState;
  const list = files[folder] || [];
  const status = folderStatus[folder];

  const destOptions = folders
    .map(d => `<option value="${_escHtml(d)}">${_escHtml(d)}</option>`)
    .join('');

  // Folder hasn't been fetched yet or is fetching — show an inline loader
  // instead of "empty folder". This prevents flashing "empty" before the
  // real content arrives.
  if (status === 'loading' || status === undefined) {
    filesEl.innerHTML = `
      <div class="mm-mg-files-header">
        <span class="mm-mg-files-title">${_escHtml(folder)}/</span>
        <span class="mm-mg-files-meta">loading…</span>
      </div>
      <div class="mm-mg-empty"><span class="spinner"></span> Listing files…</div>`;
    return;
  }

  if (status === 'error') {
    filesEl.innerHTML = `
      <div class="mm-mg-files-header">
        <span class="mm-mg-files-title">${_escHtml(folder)}/</span>
        <span class="mm-mg-files-meta" style="color:var(--red)">load failed</span>
      </div>
      <div class="mm-mg-empty" style="color:var(--red)">Could not list files in this folder. Try Refresh.</div>`;
    return;
  }

  if (!list.length) {
    filesEl.innerHTML = `
      <div class="mm-mg-files-header">
        <span class="mm-mg-files-title">${_escHtml(folder)}/</span>
        <span class="mm-mg-files-meta">empty</span>
      </div>
      <div class="mm-mg-empty">This folder is empty. Use the Download or Upload tab to add models.</div>`;
    return;
  }

  const rows = list.map(file => {
    const fileKey = `${folder}/${file}`;
    const isBusy = busy === fileKey;
    const defaultDest = folders.find(d => d !== folder) || folder;
    const destSelect = destOptions
      .replace(`value="${_escHtml(defaultDest)}"`, `value="${_escHtml(defaultDest)}" selected`);
    const actions = isBusy
      ? `<span class="mm-mg-row-spinner"><span class="spinner"></span> Working…</span>`
      : `<span class="mm-mg-arrow">→</span>
         <select class="ep-input mm-mg-dest" data-from="${_escHtml(folder)}" data-file="${_escHtml(file)}">${destSelect}</select>
         <button class="btn-ghost btn-sm" onclick="window.mmManageDo(this, false)">Move</button>
         <button class="btn-ghost btn-sm" onclick="window.mmManageDo(this, true)">Copy</button>`;
    return `
      <div class="mm-mg-row${isBusy ? ' is-busy' : ''}">
        <span class="mm-mg-filename" title="${_escHtml(fileKey)}">${_escHtml(file)}</span>
        <span class="mm-mg-actions">${actions}</span>
      </div>`;
  }).join('');

  filesEl.innerHTML = `
    <div class="mm-mg-files-header">
      <span class="mm-mg-files-title">${_escHtml(folder)}/</span>
      <span class="mm-mg-files-meta">${list.length} file${list.length === 1 ? '' : 's'}</span>
    </div>
    <div class="mm-mg-rows">${rows}</div>`;
}

// Move or Copy handler invoked from the per-row buttons. `btn` is the
// clicked <button>, we walk up to the row to read the from/file dataset.
//
// move-model is synchronous on the runner (it's a shutil.move/copy2) so
// there's nothing to poll — we show a "pending" toast while the request
// is in flight and replace it with success / error when it returns.
export async function mmManageDo(btn, copy) {
  const row = btn.closest('.mm-mg-row');
  if (!row) return;
  const sel = row.querySelector('.mm-mg-dest');
  const from = sel.dataset.from;
  const file = sel.dataset.file;
  const to   = sel.value;
  if (!from || !to || !file) return;
  if (from === to) {
    _toast(`Source and destination are the same.`, 'error');
    return;
  }

  const verb = copy ? 'Copy' : 'Move';
  const verbing = copy ? 'Copying' : 'Moving';
  const pastVerb = copy ? 'Copied' : 'Moved';

  const fileKey = `${from}/${file}`;
  _mmManageState.busy = fileKey;
  _mmRenderManage();

  // Pending toast — stays visible until we explicitly replace/dismiss it.
  const toastId = _toast(
    `${verbing} <strong>${_escHtml(file)}</strong> → ${_escHtml(to)}/`,
    'pending',
  );

  try {
    const r = await fetch(
      `${API}/api/proxy/${encodeURIComponent(_mmHost)}/${encodeURIComponent(_mmInst)}/move-model`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          from_directory: from,
          to_directory: to,
          name: file,
          copy: !!copy,
        }),
      },
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      _toastReplace(
        toastId,
        `${verb} failed: ${_escHtml(data.error || `HTTP ${r.status}`)}`,
        'error',
      );
      return;
    }

    // In-memory list update so the row jumps to its new home immediately.
    if (!copy) {
      _mmManageState.files[from] = (_mmManageState.files[from] || []).filter(f => f !== file);
    }
    if (!(_mmManageState.files[to] || []).includes(file)) {
      _mmManageState.files[to] = [...(_mmManageState.files[to] || []), file].sort();
    }
    _toastReplace(
      toastId,
      `✓ ${pastVerb} <strong>${_escHtml(file)}</strong> to ${_escHtml(to)}/`,
      'success',
    );
  } catch (e) {
    _toastReplace(toastId, `${verb} failed: ${_escHtml(e.message)}`, 'error');
  } finally {
    _mmManageState.busy = null;
    _mmRenderManage();
  }
}

// ── Toast notifications ─────────────────────────────────────────────────────
//
// Lightweight floating notifications used by Manage's move/copy flow. They
// live in a fixed-position stack at the bottom-right, independent of the
// modal's DOM so a Manage re-render can't blow them away mid-operation.
//
// Variants:
//   - 'pending': spinner, no auto-dismiss (replaced by success/error when
//     the request resolves)
//   - 'success': green check, 2.5s auto-dismiss
//   - 'error':   red, manual dismiss only (× button)

let _toastSeq = 0;

function _toastContainer() {
  let c = document.getElementById('mm-toast-container');
  if (!c) {
    c = document.createElement('div');
    c.id = 'mm-toast-container';
    c.className = 'mm-toast-container';
    document.body.appendChild(c);
  }
  return c;
}

function _toast(html, kind = 'pending') {
  const id = `mm-toast-${++_toastSeq}`;
  const el = document.createElement('div');
  el.id = id;
  el.className = `mm-toast mm-toast-${kind}`;
  el.innerHTML = _toastInner(html, kind);
  _bindToastClose(el);
  _toastContainer().appendChild(el);
  if (kind === 'success') _toastAutoDismiss(el, 2500);
  return id;
}

function _toastReplace(id, html, kind) {
  const el = document.getElementById(id);
  if (!el) { _toast(html, kind); return; }
  el.className = `mm-toast mm-toast-${kind}`;
  el.innerHTML = _toastInner(html, kind);
  _bindToastClose(el);
  if (kind === 'success') _toastAutoDismiss(el, 2500);
}

function _toastInner(html, kind) {
  const icon =
    kind === 'pending' ? `<span class="mm-toast-spinner"></span>`
    : kind === 'success' ? `<span class="mm-toast-icon">✓</span>`
    : `<span class="mm-toast-icon">✗</span>`;
  const close = kind === 'pending'
    ? ''
    : `<button class="mm-toast-close" type="button" aria-label="Dismiss">×</button>`;
  return `${icon}<span class="mm-toast-msg">${html}</span>${close}`;
}

function _bindToastClose(el) {
  const btn = el.querySelector('.mm-toast-close');
  if (btn) btn.addEventListener('click', () => el.remove());
}

function _toastAutoDismiss(el, ms) {
  setTimeout(() => {
    el.classList.add('mm-toast-leaving');
    setTimeout(() => el.remove(), 200);
  }, ms);
}
