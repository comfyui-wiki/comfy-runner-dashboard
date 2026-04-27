import { API } from '../utils.js';

const MODEL_DIRS = [
  'checkpoints', 'loras', 'vae', 'controlnet', 'upscale_models',
  'clip', 'clip_vision', 'embeddings', 'hypernetworks', 'ipadapter', 'unet',
];

let _mmHost = null;
let _mmInst = null;
let _mmFile = null;

export function openModelModal(host, instName, tab = 'download') {
  _mmHost = host;
  _mmInst = instName;
  _mmFile = null;

  document.getElementById('mm-instance').textContent = instName;

  ['mm-url', 'mm-dl-dir', 'mm-dl-name', 'mm-dl-token', 'mm-ul-dir', 'mm-ul-name'].forEach(id => {
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

  _renderDirPills('mm-dl-dir-pills', 'mm-dl-dir');
  _renderDirPills('mm-ul-dir-pills', 'mm-ul-dir');

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

export function mmSelectDir(pillsId, dirInputId, dir) {
  document.getElementById(dirInputId).value = dir;
  document.querySelectorAll(`#${pillsId} .dir-pill`).forEach(p => {
    p.classList.toggle('selected', p.textContent === dir);
  });
}

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

function _renderDirPills(pillsId, dirInputId) {
  document.getElementById(pillsId).innerHTML = MODEL_DIRS.map(d =>
    `<span class="dir-pill" onclick="window.mmSelectDir('${pillsId}','${dirInputId}','${d}')">${d}</span>`
  ).join('');
}

function _showResp(pane, text, isError) {
  const id = pane === 'download' ? 'mm-dl-resp' : 'mm-ul-resp';
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = `mm-resp visible${isError ? ' error' : ''}`;
}

async function _pollJob(jobId, pane) {
  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const r = await fetch(`${API}/api/proxy/${encodeURIComponent(_mmHost)}/job/${jobId}`);
      const data = await r.json();
      const status = data.status || '';
      const lines  = (data.output_lines || []).slice(-3).join('\n');
      if (status === 'done') {
        _showResp(pane, `Done!\n${lines}`, false);
        return;
      } else if (status === 'failed') {
        _showResp(pane, `Failed: ${data.error || ''}\n${lines}`, true);
        return;
      } else {
        _showResp(pane, `[${status}] ${lines || '…'}`, false);
      }
    } catch { break; }
  }
}

export async function submitDownload() {
  const url   = document.getElementById('mm-url').value.trim();
  const dir   = document.getElementById('mm-dl-dir').value.trim();
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
      _pollJob(data.job_id, 'download');
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
  const dir  = document.getElementById('mm-ul-dir').value.trim();
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
