import { API, esc } from './utils.js';
import { selectNode } from './nodes.js';

let _pods = [];
let _selectedPodId = null;

export function getSelectedPodId() { return _selectedPodId; }

export async function loadPodsSidebar() {
  const el = document.getElementById('sidebar-pods');
  if (!el) return;

  try {
    const st = await fetch(`${API}/api/runpod/status`).then(r => r.json());
    if (!st.configured) {
      el.innerHTML =
        `<div class="sidebar-section-label">RunPod</div>` +
        `<div class="sidebar-diag"><span class="sidebar-diag-title">API key missing</span>` +
        `<div class="sidebar-diag-hint">Set RUNPOD_API_KEY in <code>.env</code></div></div>`;
      return;
    }

    const billingHtml = _renderBilling(st.account, st.account_error);

    const res = await fetch(`${API}/api/pods`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      el.innerHTML =
        `<div class="sidebar-section-label">RunPod</div>${billingHtml}` +
        `<div class="sidebar-diag sidebar-diag-err"><strong>Failed to list pods</strong><br>` +
        `<span class="sidebar-diag-msg">${esc(data.detail || data.error || res.statusText)}</span></div>`;
      return;
    }

    _pods = data.pods || [];
    renderPodsSidebar(_pods, billingHtml);
  } catch (e) {
    el.innerHTML =
      `<div class="sidebar-section-label">RunPod</div>` +
      `<div class="sidebar-diag sidebar-diag-err"><strong>RunPod error</strong><br>` +
      `<span class="sidebar-diag-msg">${esc(e.message)}</span></div>`;
  }
}

function _fmtMoney(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 10) return `$${v.toFixed(1)}`;
  return `$${v.toFixed(2)}`;
}

function _renderBilling(account, err) {
  if (err) {
    return `<div class="sidebar-billing sidebar-billing-err" title="${esc(err)}">Balance unavailable</div>`;
  }
  if (!account) return '';
  const bal = _fmtMoney(account.balance_usd);
  const spend = account.spend_per_hr_usd != null
    ? `${_fmtMoney(account.spend_per_hr_usd)}/hr`
    : '—';
  const low = Number(account.balance_usd) < 10;
  return `<div class="sidebar-billing${low ? ' sidebar-billing-low' : ''}" title="RunPod account credit">
    <div class="sidebar-billing-chip">
      <span class="sidebar-billing-k">Balance</span>
      <span class="sidebar-billing-bal">${esc(bal)}</span>
    </div>
    <div class="sidebar-billing-chip">
      <span class="sidebar-billing-k">Spend</span>
      <span class="sidebar-billing-spend">${esc(spend)}</span>
    </div>
  </div>`;
}

function statusDot(status) {
  const s = (status || '').toUpperCase();
  if (s === 'RUNNING') return 'dot-on';
  if (s === 'EXITED' || s === 'STOPPED') return 'dot-off';
  return 'dot-warn';
}

function renderPodsSidebar(pods, billingHtml = '') {
  const el = document.getElementById('sidebar-pods');
  const header =
    `<div class="sidebar-section-label" style="display:flex;align-items:center;justify-content:space-between;gap:0.35rem">` +
    `<span>RunPod (${pods.length})</span>` +
    `<span style="display:flex;gap:0.25rem">` +
    `<button class="btn-ghost btn-sm" style="padding:0.1rem 0.4rem;font-size:0.65rem" ` +
    `onclick="event.stopPropagation();window.openStockPage()" title="Find a free GPU and launch">Launch</button>` +
    `<button class="btn-ghost btn-sm" style="padding:0.1rem 0.4rem;font-size:0.65rem" ` +
    `onclick="event.stopPropagation();window.loadPodsSidebar()">↻</button></span></div>` +
    billingHtml;

  if (!pods.length) {
    el.innerHTML = header +
      `<div class="sidebar-diag"><span class="sidebar-diag-title">No pods</span>` +
      `<div class="sidebar-diag-hint">Create one with comfy-runner hosted init, or the RunPod console.</div></div>`;
    return;
  }

  el.innerHTML = header + pods.map(p => {
    const idArg = esc(JSON.stringify(String(p.id)));
    const label = p.local_name || p.name || p.id;
    const gpuShort = (p.gpu_type || '').replace(/^NVIDIA /,'') || p.id.slice(0, 10);
    const vram = p.vram_gb ? `${p.vram_gb}GB VRAM` : '';
    const sub = [gpuShort, vram].filter(Boolean).join(' · ');
    return `<div class="node-item" id="nav-pod-${esc(p.id)}" onclick="window.selectPod(${idArg})">
      <span class="node-icon">☁</span>
      <span class="node-label">
        <div class="node-name">${esc(label)}</div>
        <div class="node-sub">${esc(sub)}</div>
      </span>
      <span class="dot ${statusDot(p.status)}" title="${esc(p.status)}"></span>
    </div>`;
  }).join('');
}

export async function selectPod(podId) {
  _selectedPodId = podId;
  document.querySelectorAll('.node-item').forEach(e => e.classList.remove('active'));
  document.getElementById(`nav-pod-${CSS.escape ? CSS.escape(podId) : podId}`)?.classList.add('active')
    || document.getElementById(`nav-pod-${podId}`)?.classList.add('active');

  document.getElementById('btn-update').style.display = 'none';
  document.getElementById('btn-update-force').style.display = 'none';
  const ngBtn = document.getElementById('btn-ngrok-config');
  if (ngBtn) ngBtn.style.display = 'none';
  const hw = document.getElementById('page-hw');
  if (hw) hw.innerHTML = '';

  document.getElementById('main-content').innerHTML =
    '<div class="empty"><span class="spinner"></span> Loading pod…</div>';

  try {
    const res = await fetch(`${API}/api/pods/${encodeURIComponent(podId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
    renderPodPage(data.pod);
  } catch (e) {
    document.getElementById('main-content').innerHTML =
      `<div class="empty" style="color:#555">Failed to load pod<br><small>${esc(e.message)}</small></div>`;
  }
}

function renderPodPage(pod) {
  const label = pod.local_name || pod.name || pod.id;
  document.getElementById('page-title').textContent = label;
  document.getElementById('page-sub').textContent = `RunPod · ${pod.id}`;

  const status = (pod.status || '?').toUpperCase();
  const running = status === 'RUNNING';
  const statusCls = running ? 'badge-healthy' : (status === 'EXITED' || status === 'STOPPED' ? 'badge-stopped' : 'badge-unhealthy');
  const gpuShort = (pod.gpu_type || 'GPU').replace(/^NVIDIA\s+/i, '');
  const vramLabel = pod.vram_gb != null ? `${pod.vram_gb} GB VRAM` : 'VRAM unknown';
  const cost = Number(pod.cost_per_hr || 0).toFixed(2);
  const idArg = esc(JSON.stringify(pod.id));
  const hostArg = esc(JSON.stringify(pod.server_host));
  const labelArg = esc(JSON.stringify(label));
  const comfyArg = esc(JSON.stringify(pod.comfy_url || ''));
  const apiArg = esc(JSON.stringify(pod.server_url || ''));

  const hw = document.getElementById('page-hw');
  if (hw) {
    hw.innerHTML =
      `<span class="hw-chip hw-chip-gpu" title="${esc(pod.gpu_type || gpuShort)}">🖥 ${esc(gpuShort)}</span>` +
      `<span class="hw-chip hw-chip-vram" title="GPU memory">${esc(vramLabel)}</span>` +
      (pod.datacenter ? `<span class="hw-chip" title="Datacenter">${esc(pod.datacenter)}</span>` : '');
  }

  document.getElementById('main-content').innerHTML = `
    <div class="pod-panel">
      <div class="pod-hero ${running ? 'is-running' : 'is-stopped'}">
        <div class="pod-hero-main">
          <div class="pod-hero-kicker">RunPod machine</div>
          <div class="pod-hero-title">${esc(label)}</div>
          <div class="pod-hero-sub">${esc(gpuShort)} · <strong>${esc(vramLabel)}</strong></div>
        </div>
        <div class="pod-hero-side">
          <span class="badge ${statusCls} pod-status-badge">${esc(status)}</span>
          <div class="pod-vram-badge" title="GPU memory">${esc(pod.vram_gb != null ? `${pod.vram_gb} GB` : '—')}</div>
          <div class="pod-price">$${esc(cost)}<span>/hr</span></div>
        </div>
      </div>

      <div class="pod-stats">
        <div class="pod-stat pod-stat-vram">
          <div class="pod-stat-k">VRAM</div>
          <div class="pod-stat-v">${esc(pod.vram_gb != null ? `${pod.vram_gb} GB` : '—')}</div>
        </div>
        <div class="pod-stat">
          <div class="pod-stat-k">GPU</div>
          <div class="pod-stat-v">${esc(gpuShort)}</div>
        </div>
        <div class="pod-stat">
          <div class="pod-stat-k">Datacenter</div>
          <div class="pod-stat-v">${esc(pod.datacenter || '—')}</div>
        </div>
        <div class="pod-stat">
          <div class="pod-stat-k">State</div>
          <div class="pod-stat-v">${running ? 'Billing GPU' : 'GPU paused'}</div>
        </div>
      </div>

      ${!running ? `<div class="pod-pin-note">
        This stopped machine is pinned to host <code>${esc(pod.machine_id || 'unknown')}</code>.
        Start only works if that host still has a free GPU.
        If Start fails, use
        <button type="button" class="btn-link" onclick="window.openStockPage(${esc(JSON.stringify(gpuShort))})">Find a free machine</button>
        to launch a new one (keep files with a network volume in the same place).
      </div>` : ''}

      <div class="pod-card">
        <div class="pod-section-title">Endpoints</div>
        <div class="pod-urls">
          <div class="pod-url-card">
            <div class="pod-url-top">
              <span class="pod-url-label">ComfyUI</span>
              <span class="pod-url-port">:8188</span>
            </div>
            <div class="pod-url-row">
              <input class="ep-input pod-url-input" readonly value="${esc(pod.comfy_url || '')}">
              <button class="btn-ghost btn-sm" type="button" onclick="navigator.clipboard.writeText(${comfyArg})">Copy</button>
              <a class="btn-primary btn-sm ${running ? '' : 'is-disabled'}" href="${esc(pod.comfy_url || '#')}"
                 target="_blank" rel="noopener" ${running ? '' : 'aria-disabled="true" tabindex="-1"'}>Open</a>
            </div>
          </div>
          <div class="pod-url-card">
            <div class="pod-url-top">
              <span class="pod-url-label">Runner API</span>
              <span class="pod-url-port">:9189</span>
            </div>
            <div class="pod-url-row">
              <input class="ep-input pod-url-input" readonly value="${esc(pod.server_url || '')}">
              <button class="btn-ghost btn-sm" type="button" onclick="navigator.clipboard.writeText(${apiArg})">Copy</button>
            </div>
          </div>
        </div>

        <div class="pod-actions">
          ${running
            ? `<button class="btn-ghost" onclick="window.podStop(${idArg})">⏹ Stop machine</button>`
            : `<button class="btn-green" onclick="window.podStart(${idArg})">▶ Start machine</button>`}
          ${running
            ? `<button class="btn-primary" onclick="window.podManage(${hostArg},${labelArg})">⚙ Manage instances</button>`
            : ''}
          <div class="pod-actions-spacer"></div>
          <button class="btn-ghost" onclick="window.selectPod(${idArg})">↻ Refresh</button>
          <button class="btn-subtle btn-subtle-danger" onclick="window.podTerminate(${idArg},${labelArg})">Terminate…</button>
        </div>

        <div class="pod-hint-row">
          <div class="pod-hint-item"><strong>Stop</strong> pauses GPU billing; you can start again later.</div>
          <div class="pod-hint-item"><strong>Manage</strong> deploys branches, starts ComfyUI, and installs models.</div>
          <div class="pod-hint-item"><strong>Terminate</strong> permanently deletes this pod (volumes kept).</div>
        </div>
      </div>
    </div>`;
}

async function _podAction(podId, method, path, okMsg) {
  const res = await fetch(`${API}/api/pods/${encodeURIComponent(podId)}${path}`, { method });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail || data.error || `HTTP ${res.status}`;
    const shortage = /not enough free GPUs/i.test(String(detail));
    if (shortage) {
      const go = confirm(
        `${detail}\n\nThis stopped machine is stuck on one host that has no free GPU right now.\n\n`
        + `Open Launch to pick a place that has stock and start a new machine?`,
      );
      if (go) {
        window.openStockPage();
        return 'stock';
      }
    } else {
      alert(detail);
    }
    return false;
  }
  if (okMsg) console.log(okMsg);
  await loadPodsSidebar();
  await selectPod(podId);
  return true;
}

export async function podStart(podId) {
  document.getElementById('main-content').innerHTML =
    '<div class="empty"><span class="spinner"></span> Starting pod…</div>';
  const ok = await _podAction(podId, 'POST', '/start', 'started');
  if (ok === false) await selectPod(podId);
}

export async function podStop(podId) {
  if (!confirm('Stop this pod? GPU billing pauses; you can start it again later.')) return;
  document.getElementById('main-content').innerHTML =
    '<div class="empty"><span class="spinner"></span> Stopping pod…</div>';
  await _podAction(podId, 'POST', '/stop', 'stopped');
}

export async function podTerminate(podId, label) {
  const typed = prompt(
    `Permanently terminate "${label}"?\nThis deletes the GPU pod (network volumes are kept).\n\nType the pod name to confirm:`,
  );
  if (typed !== label) {
    if (typed != null) alert('Name did not match — cancelled.');
    return;
  }
  const res = await fetch(`${API}/api/pods/${encodeURIComponent(podId)}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.detail || data.error || `HTTP ${res.status}`);
    return;
  }
  _selectedPodId = null;
  document.getElementById('page-title').textContent = 'Select a node';
  document.getElementById('page-sub').textContent = '–';
  document.getElementById('main-content').innerHTML =
    '<div class="empty">Pod terminated. Select another node or pod.</div>';
  await loadPodsSidebar();
}

export function podManage(serverHost, label) {
  // Reuse the existing Tailscale node UI against the RunPod proxy hostname.
  selectNode(serverHost, label || serverHost);
}
