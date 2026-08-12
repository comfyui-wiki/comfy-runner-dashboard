import { esc, callEndpoint } from '../utils.js';

let _tnHost = null;
let _tnInst = null;

export function openTunnel(host, instName, tunnelUrl = '') {
  _tnHost = host;
  _tnInst = instName;
  document.getElementById('tn-instance').textContent = instName;
  const statusEl = document.getElementById('tn-status');
  if (tunnelUrl) {
    statusEl.innerHTML = `Active tunnel: <a href="${esc(tunnelUrl)}" target="_blank" rel="noopener" style="color:#a5b4fc">${esc(tunnelUrl)}</a>`;
  } else {
    statusEl.textContent = 'No active tunnel';
  }
  document.querySelector('input[name="tn-provider"][value="ngrok"]').checked = true;
  document.getElementById('tn-domain').value = '';
  document.getElementById('tunnel-modal').classList.add('open');
}

export function closeTunnel() {
  document.getElementById('tunnel-modal').classList.remove('open');
}

// ngrok --url expects a bare hostname; runner builds https://{domain} itself.
function _normalizeNgrokDomain(raw) {
  let d = String(raw || '').trim();
  if (!d) return '';
  d = d.replace(/^https?:\/\//i, '');
  d = d.replace(/\/+$/, '');
  d = d.split('/')[0]; // drop any path after hostname
  return d;
}

export function submitTunnelStart() {
  if (!_tnHost || !_tnInst) return;
  const provider = document.querySelector('input[name="tn-provider"]:checked')?.value || 'ngrok';
  const domain = _normalizeNgrokDomain(document.getElementById('tn-domain').value);
  const body = { provider };
  if (domain) body.domain = domain;
  closeTunnel();
  callEndpoint(_tnHost, 'POST', `/${_tnInst}/tunnel/start`, JSON.stringify(body));
}

export function submitTunnelStop() {
  if (!_tnHost || !_tnInst) return;
  closeTunnel();
  callEndpoint(_tnHost, 'POST', `/${_tnInst}/tunnel/stop`);
}

const _tnOverlay = document.getElementById('tunnel-modal');
if (_tnOverlay) {
  _tnOverlay.addEventListener('click', e => {
    if (e.target === _tnOverlay) closeTunnel();
  });
}
