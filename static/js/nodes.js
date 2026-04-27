import { API, esc } from './utils.js';
import { renderNodePage } from './endpoints.js';

let _currentHost = null;

export function getCurrentHost() { return _currentHost; }

export async function loadNodes() {
  const res = await fetch(`${API}/api/nodes`);
  const { nodes } = await res.json();
  renderSidebar(nodes);
}

function osIcon(os) {
  if (!os) return '🖥';
  const o = os.toLowerCase();
  if (o.includes('windows')) return '⊞';
  if (o.includes('darwin') || o.includes('mac')) return '';
  return '⬡';
}

function renderSidebar(nodes) {
  const el = document.getElementById('sidebar-nodes');
  if (!nodes.length) {
    el.innerHTML = '<div style="padding:1rem;font-size:0.72rem;color:#333;text-align:center">No online nodes found</div>';
    return;
  }
  el.innerHTML = `<div class="sidebar-section-label">Nodes (${nodes.length})</div>` +
    nodes.map(n => {
      const host = n.dns_name || n.hostname;
      return `<div class="node-item" id="nav-${esc(host)}" onclick="window.selectNode('${esc(host)}','${esc(n.hostname)}')">
        <span class="node-icon">${osIcon(n.os)}</span>
        <span class="node-label">
          <div class="node-name">${esc(n.hostname)}</div>
        </span>
        <span class="dot dot-on"></span>
      </div>`;
    }).join('');
}

export async function selectNode(host, label) {
  _currentHost = host;
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
