import { API, esc, showResp } from '../utils.js';
import { getCurrentHost } from '../nodes.js';

let _domains = [];

function _renderDomains() {
  const el = document.getElementById('ng-domains-list');
  if (!el) return;
  if (!_domains.length) {
    el.innerHTML = '<div style="font-size:0.72rem;color:#666;padding:0.35rem 0">No domains in pool — ngrok will assign random URLs.</div>';
    return;
  }
  el.innerHTML = _domains.map((d, i) => `
    <div class="ng-domain-row">
      <span class="ng-domain-name">${esc(d)}</span>
      <button type="button" class="btn-ghost btn-sm" onclick="window.ngRemoveDomain(${i})">Remove</button>
    </div>`).join('');
}

export async function openNgrokConfig() {
  const host = getCurrentHost();
  if (!host) return;

  document.getElementById('ng-host').textContent = host;
  document.getElementById('ng-authtoken').value = '';
  document.getElementById('ng-region').value = '';
  document.getElementById('ng-add-domain').value = '';
  document.getElementById('ng-token-hint').textContent = 'Loading…';
  _domains = [];
  _renderDomains();
  document.getElementById('ngrok-config-modal').classList.add('open');

  try {
    const r = await fetch(`${API}/api/proxy/${encodeURIComponent(host)}/tunnel/config?provider=ngrok`);
    if (r.status === 404) {
      document.getElementById('ng-token-hint').innerHTML =
        'Tunnel config API not available on this runner. Use CLI: ' +
        '<code style="font-size:0.65rem">comfy_runner.py tunnel config --provider ngrok --authtoken …</code>';
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const cfg = data.config || {};
    document.getElementById('ng-region').value = cfg.region || '';
    _domains = Array.isArray(cfg.domains) ? [...cfg.domains] : [];
    _renderDomains();
    if (cfg.authtoken_set) {
      document.getElementById('ng-token-hint').textContent =
        `Current token: ${cfg.authtoken_masked || '(set)'} — leave blank to keep`;
    } else {
      document.getElementById('ng-token-hint').textContent = 'No authtoken set';
    }
  } catch (e) {
    document.getElementById('ng-token-hint').textContent = `Could not load: ${e.message}`;
  }
}

export function closeNgrokConfig() {
  document.getElementById('ngrok-config-modal').classList.remove('open');
}

export function ngAddDomain() {
  const inp = document.getElementById('ng-add-domain');
  const d = inp.value.trim();
  if (!d) return;
  if (!_domains.includes(d)) _domains.push(d);
  inp.value = '';
  _renderDomains();
}

export function ngRemoveDomain(idx) {
  _domains.splice(idx, 1);
  _renderDomains();
}

export async function submitNgrokConfig() {
  const host = getCurrentHost();
  if (!host) return;

  const body = {
    provider: 'ngrok',
    region: document.getElementById('ng-region').value.trim(),
    domains: _domains,
  };
  const token = document.getElementById('ng-authtoken').value.trim();
  if (token) body.authtoken = token;

  const saveBtn = document.getElementById('ng-save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const r = await fetch(`${API}/api/proxy/${encodeURIComponent(host)}/tunnel/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!r.ok) {
      const msg = data?.error || text || `HTTP ${r.status}`;
      showResp(`ngrok config save failed: ${msg}`, true);
      return;
    }
    showResp(`ngrok config saved.\n${JSON.stringify(data, null, 2)}`);
    closeNgrokConfig();
  } catch (e) {
    showResp(`ngrok config save error: ${e.message}`, true);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}

const _ngOverlay = document.getElementById('ngrok-config-modal');
if (_ngOverlay) {
  _ngOverlay.addEventListener('click', e => {
    if (e.target === _ngOverlay) closeNgrokConfig();
  });
}
