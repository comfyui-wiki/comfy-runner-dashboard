import { API, esc } from './utils.js';
import { renderNodePage } from './endpoints.js';

const LS_LAST_HOST = 'dashboard.lastNode.v1';

let _currentHost = null;
// Snapshot of last sidebar fetch — used to re-select after async restore.
let _lastNodes = [];

export function getCurrentHost() { return _currentHost; }

export async function loadNodes() {
  const el = document.getElementById('sidebar-nodes');
  try {
    const res = await fetch(`${API}/api/nodes`);
    if (!res.ok) {
      const raw = (await res.text()).trim().slice(0, 600);
      el.innerHTML =
        `<div class="sidebar-diag sidebar-diag-err"><strong>HTTP ${res.status}</strong><br><span class="sidebar-diag-msg">${esc(raw || res.statusText)}</span></div>`;
      return;
    }
    const data = await res.json();
    _lastNodes = data.nodes ?? [];
    renderSidebar(_lastNodes, data.error ?? null, data.meta ?? null);
    _restoreLastNode();
  } catch (e) {
    el.innerHTML =
      `<div class="sidebar-diag sidebar-diag-err"><strong>Could not load /api/nodes</strong><br><span class="sidebar-diag-msg">${esc(e.message)}</span></div>`;
  }
}

// Restore the previously-selected node from localStorage on page load.
// Only fires if (a) we have a saved host, (b) it's still in the current
// sidebar list, and (c) the user hasn't already clicked something during
// the fetch.
function _restoreLastNode() {
  if (_currentHost) return;
  let saved = null;
  try { saved = localStorage.getItem(LS_LAST_HOST); } catch {}
  if (!saved) return;
  const match = _lastNodes.find(n => (n.dns_name || n.hostname) === saved);
  if (!match) return;
  selectNode(saved, match.hostname, { skipPersist: true });
}

function osIcon(os) {
  if (!os) return '🖥';
  const o = os.toLowerCase();
  if (o.includes('windows')) return '⊞';
  if (o.includes('darwin') || o.includes('mac')) return '';
  return '⬡';
}

function renderSidebar(nodes, discoveryError, meta) {
  const el = document.getElementById('sidebar-nodes');
  if (discoveryError) {
    el.innerHTML =
      `<div class="sidebar-diag sidebar-diag-err"><strong>Tailscale discovery failed</strong><br><span class="sidebar-diag-msg">${esc(discoveryError)}</span></div>`;
    return;
  }
  if (!nodes.length) {
    let sub = '';
    if (meta && typeof meta.total_peers === 'number' && meta.total_peers > 0) {
      sub = `<div class="sidebar-diag-hint">${esc(String(meta.online_peers) + '/' + String(meta.total_peers))} peers online — other devices may be shut down or not on Tailscale.</div>`;
    }
    el.innerHTML =
      `<div class="sidebar-diag"><span class="sidebar-diag-title">No online nodes</span>${sub}</div>`;
    return;
  }
  el.innerHTML = `<div class="sidebar-section-label">Nodes (${nodes.length})</div>` +
    nodes.map(n => {
      const host = n.dns_name || n.hostname;
      const hostArg = esc(JSON.stringify(String(host)));
      const labelArg = esc(JSON.stringify(String(n.hostname)));
      return `<div class="node-item" id="nav-${esc(host)}" onclick="window.selectNode(${hostArg},${labelArg})">
        <span class="node-icon">${osIcon(n.os)}</span>
        <span class="node-label">
          <div class="node-name">${esc(n.hostname)}</div>
        </span>
        <span class="dot dot-on"></span>
      </div>`;
    }).join('');
}

export async function selectNode(host, label, opts = {}) {
  _currentHost = host;
  if (!opts.skipPersist) {
    try { localStorage.setItem(LS_LAST_HOST, host); } catch {}
  }
  document.querySelectorAll('.node-item').forEach(e => e.classList.remove('active'));
  document.getElementById(`nav-${esc(host)}`)?.classList.add('active');

  document.getElementById('page-title').textContent = label;
  document.getElementById('page-sub').textContent = host;
  document.getElementById('btn-update').style.display = 'inline-block';
  document.getElementById('btn-update-force').style.display = 'inline-block';
  document.getElementById('main-content').innerHTML =
    '<div class="empty"><span class="spinner"></span> Loading status…</div>';

  await loadNodeContent(host);
}

export async function refreshCurrent() {
  if (_currentHost) await loadNodeContent(_currentHost);
}

async function loadNodeContent(host) {
  try {
    const r = await fetch(`${API}/api/nodes/${encodeURIComponent(host)}/status`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const status = await r.json();
    renderNodePage(host, status);
  } catch (e) {
    document.getElementById('main-content').innerHTML =
      `<div class="empty" style="color:#555">No comfy-runner on this node<br><small>${e.message}</small></div>`;
  }
}
