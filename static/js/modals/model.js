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

export function openModelModal(host, instName, tab = 'download') {
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
  document.querySelectorAll('.mm-tab').forEach((t, i) => {
    t.classList.toggle('active', (i === 0 && tab === 'download') || (i === 1 && tab === 'upload'));
  });
  document.getElementById('mm-pane-download').classList.toggle('active', tab === 'download');
  document.getElementById('mm-pane-upload').classList.toggle('active', tab === 'upload');
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
}
