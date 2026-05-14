import { API, showResp, callEndpoint } from '../utils.js';

let _laHost = null;
let _laInst = null;
let _laReady = false;

const FLAG_NO_CUSTOM = '--disable-all-custom-nodes';

function tokens(s) {
  return String(s).trim().split(/\s+/).filter(Boolean);
}

function withNoCustomFlag(s, on) {
  let t = tokens(s);
  t = t.filter(x => x !== FLAG_NO_CUSTOM);
  if (on) t.push(FLAG_NO_CUSTOM);
  return t.join(' ');
}

function syncCheckboxFromTextarea() {
  const ta = document.getElementById('la-text');
  const cb = document.getElementById('la-no-custom');
  if (!ta || !cb) return;
  cb.checked = tokens(ta.value).includes(FLAG_NO_CUSTOM);
}

export async function openLaunchArgs(host, instName) {
  _laHost = host;
  _laInst = instName;
  _laReady = false;
  document.getElementById('la-instance').textContent = instName;
  const ta = document.getElementById('la-text');
  const cb = document.getElementById('la-no-custom');
  const saveBtn = document.getElementById('la-save');
  ta.value = 'Loading…';
  ta.disabled = true;
  cb.disabled = true;
  if (saveBtn) saveBtn.disabled = true;
  document.getElementById('launch-args-modal').classList.add('open');

  try {
    const r = await fetch(`${API}/api/proxy/${encodeURIComponent(host)}/${encodeURIComponent(instName)}/info`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const raw = data.launch_args;
    ta.value = raw != null && typeof raw === 'string' ? raw : (raw != null ? String(raw) : '');
    _laReady = true;
  } catch (e) {
    ta.value = `(could not load — ${e.message})`;
    showResp(`Could not load installation info / launch_args: ${e.message}`, true);
  }
  ta.disabled = false;
  if (saveBtn) saveBtn.disabled = !_laReady;
  cb.disabled = !_laReady;
  syncCheckboxFromTextarea();

  cb.onchange = () => {
    ta.value = withNoCustomFlag(ta.value, cb.checked);
  };
  ta.oninput = syncCheckboxFromTextarea;
}

export function closeLaunchArgs() {
  document.getElementById('launch-args-modal').classList.remove('open');
}

export function submitLaunchArgs() {
  if (!_laHost || !_laInst || !_laReady) {
    if (!_laReady) {
      showResp('Launch args are still loading or failed to load — close the dialog and try again.', true);
    }
    return;
  }
  const ta = document.getElementById('la-text');
  if (ta.disabled || ta.value.startsWith('(could not load')) return;
  const launch_args = ta.value.trim();
  closeLaunchArgs();
  callEndpoint(_laHost, 'PUT', `/${_laInst}/config`, JSON.stringify({ launch_args }));
}

const _laOverlay = document.getElementById('launch-args-modal');
if (_laOverlay) {
  _laOverlay.addEventListener('click', e => {
    if (e.target === _laOverlay) closeLaunchArgs();
  });
}
