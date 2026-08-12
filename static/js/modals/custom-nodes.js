import { API, esc } from '../utils.js';

let _cnHost = null;
let _cnInst = null;
let _cnBusy = false;

export function openCustomNodes(host, instName) {
  _cnHost = host;
  _cnInst = instName;
  _cnBusy = false;

  document.getElementById('cn-instance').textContent = instName;
  document.getElementById('cn-source').value = '';
  document.getElementById('cn-version').value = '';
  _setResp('');
  _setList('<div class="cn-empty">Loading…</div>');
  document.getElementById('custom-nodes-modal').classList.add('open');
  cnRefresh();
}

export function closeCustomNodes() {
  document.getElementById('custom-nodes-modal').classList.remove('open');
}

function _setList(html) {
  document.getElementById('cn-list').innerHTML = html;
}

function _setResp(text, isError = false) {
  const el = document.getElementById('cn-resp');
  if (!text) {
    el.className = 'mm-resp';
    el.textContent = '';
    return;
  }
  el.className = `mm-resp visible${isError ? ' error' : ''}`;
  el.textContent = text;
  el.scrollTop = el.scrollHeight;
}

function _setBusy(busy) {
  _cnBusy = busy;
  const addBtn = document.getElementById('cn-add-btn');
  const refreshBtn = document.getElementById('cn-refresh-btn');
  if (addBtn) addBtn.disabled = busy;
  if (refreshBtn) refreshBtn.disabled = busy;
  document.querySelectorAll('#cn-list .cn-action').forEach(btn => {
    btn.disabled = busy;
  });
}

function _nodeMeta(node) {
  const parts = [];
  if (node.type) parts.push(node.type);
  if (node.version) parts.push(`v${node.version}`);
  if (node.commit) parts.push(String(node.commit).slice(0, 7));
  if (node.url) parts.push(node.url);
  return parts.join(' · ');
}

function _renderNodes(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) {
    _setList('<div class="cn-empty">No custom nodes installed yet.</div>');
    return;
  }

  // Enabled first, then disabled; alpha within each group.
  const sorted = [...nodes].sort((a, b) => {
    const ae = a.enabled === false ? 1 : 0;
    const be = b.enabled === false ? 1 : 0;
    if (ae !== be) return ae - be;
    return String(a.dir_name || a.id || '').localeCompare(String(b.dir_name || b.id || ''));
  });

  _setList(sorted.map(node => {
    const dirName = node.dir_name || node.id || '';
    const enabled = node.enabled !== false;
    const meta = _nodeMeta(node);
    const toggleLabel = enabled ? 'Disable' : 'Enable';
    const toggleAction = enabled ? 'disable' : 'enable';
    // JSON.stringify → JS string literal; esc() → safe inside HTML double quotes.
    const argAction = esc(JSON.stringify(toggleAction));
    const argName = esc(JSON.stringify(dirName));
    return `
      <div class="cn-row${enabled ? '' : ' is-disabled'}">
        <div class="cn-row-main">
          <div class="cn-row-title">
            <span class="cn-name">${esc(dirName)}</span>
            <span class="cn-badge ${enabled ? 'cn-badge-on' : 'cn-badge-off'}">${enabled ? 'enabled' : 'disabled'}</span>
          </div>
          ${meta ? `<div class="cn-row-meta" title="${esc(meta)}">${esc(meta)}</div>` : ''}
        </div>
        <div class="cn-row-actions">
          <button class="btn-ghost btn-sm cn-action" onclick="window.cnNodeAction(${argAction}, ${argName})">${toggleLabel}</button>
          <button class="btn-red btn-sm cn-action" onclick="window.cnNodeAction('rm', ${argName})">Remove</button>
        </div>
      </div>`;
  }).join(''));
}

export async function cnRefresh() {
  if (!_cnHost || !_cnInst) return;
  _setList('<div class="cn-empty">Loading…</div>');
  try {
    const r = await fetch(
      `${API}/api/proxy/${encodeURIComponent(_cnHost)}/${encodeURIComponent(_cnInst)}/nodes`,
    );
    const data = await r.json();
    if (!r.ok) {
      _setList(`<div class="cn-empty cn-empty-err">${esc(data.error || JSON.stringify(data))}</div>`);
      return;
    }
    _renderNodes(data.nodes || []);
  } catch (e) {
    _setList(`<div class="cn-empty cn-empty-err">${esc(e.message)}</div>`);
  }
}

async function _pollJob(jobId) {
  const HARD_TIMEOUT_MS = 30 * 60 * 1000; // 30m — git clone + pip install
  const start = Date.now();

  while (true) {
    if (Date.now() - start > HARD_TIMEOUT_MS) {
      _setResp(`Job ${jobId} still running after 30m — stopped polling.\nRecover via GET /job/${jobId}.`, true);
      return false;
    }
    await new Promise(r => setTimeout(r, 1500));

    let data;
    try {
      const r = await fetch(
        `${API}/api/proxy/${encodeURIComponent(_cnHost)}/job/${encodeURIComponent(jobId)}`,
      );
      data = await r.json();
      if (!r.ok) {
        _setResp(`Job poll failed (HTTP ${r.status}):\n${JSON.stringify(data, null, 2)}`, true);
        return false;
      }
    } catch (e) {
      _setResp(`Job poll error: ${e.message}`, true);
      return false;
    }

    const status = data.status || '';
    const out = Array.isArray(data.output) ? data.output : [];
    const tail = out.slice(-8).join('').replace(/\n+$/, '');

    if (status === 'done') {
      _setResp(`✓ Done\n${tail || '(no output)'}`, false);
      return true;
    }
    if (status === 'error' || status === 'cancelled') {
      _setResp(`${status === 'cancelled' ? 'Cancelled' : 'Failed'}: ${data.error || ''}\n${tail}`, true);
      return false;
    }
    _setResp(`[${status || 'running'}]\n${tail || '(no output yet)'}`, false);
  }
}

async function _postAction(body) {
  const r = await fetch(
    `${API}/api/proxy/${encodeURIComponent(_cnHost)}/${encodeURIComponent(_cnInst)}/nodes`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

export async function submitCustomNodeAdd() {
  if (_cnBusy || !_cnHost || !_cnInst) return;

  const source = document.getElementById('cn-source').value.trim();
  const version = document.getElementById('cn-version').value.trim();
  if (!source) {
    _setResp('Enter a git URL (https://… / git@…) or a CNR node id.', true);
    return;
  }

  const body = { action: 'add', source };
  if (version) body.version = version;

  _setBusy(true);
  document.getElementById('cn-add-btn').textContent = '⏳ Installing…';
  _setResp(`Adding ${source}…`, false);

  try {
    const { ok, data } = await _postAction(body);
    if (!ok) {
      _setResp(data.error || JSON.stringify(data, null, 2), true);
      return;
    }
    if (data.job_id) {
      _setResp(`Queued (job ${data.job_id})…`, false);
      const success = await _pollJob(data.job_id);
      if (success) {
        document.getElementById('cn-source').value = '';
        document.getElementById('cn-version').value = '';
        await cnRefresh();
      }
    } else {
      _setResp(JSON.stringify(data, null, 2), false);
      await cnRefresh();
    }
  } catch (e) {
    _setResp(e.message, true);
  } finally {
    document.getElementById('cn-add-btn').textContent = '+ Install';
    _setBusy(false);
  }
}

export async function cnNodeAction(action, nodeName) {
  if (_cnBusy || !_cnHost || !_cnInst || !nodeName) return;

  if (action === 'rm') {
    const ok = confirm(`Remove custom node "${nodeName}"?\n\nThis deletes the directory on the remote machine.`);
    if (!ok) return;
  }

  _setBusy(true);
  _setResp(`${action} ${nodeName}…`, false);

  try {
    const { ok, data } = await _postAction({ action, node_name: nodeName });
    if (!ok) {
      _setResp(data.error || JSON.stringify(data, null, 2), true);
      return;
    }

    // add/rm are async; enable/disable are sync.
    if (data.job_id) {
      _setResp(`Queued (job ${data.job_id})…`, false);
      await _pollJob(data.job_id);
    } else {
      const out = Array.isArray(data.output) ? data.output.join('') : '';
      _setResp(out.trim() || `✓ ${action} ${nodeName}`, false);
    }
    await cnRefresh();
  } catch (e) {
    _setResp(e.message, true);
  } finally {
    _setBusy(false);
  }
}

document.getElementById('custom-nodes-modal')?.addEventListener('click', e => {
  if (e.target === e.currentTarget) closeCustomNodes();
});
