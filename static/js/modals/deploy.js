import { callEndpoint } from '../utils.js';

let _deployHost = null;
let _deployPath = null;

const DM_INPUTS = {
  branch: { label: 'Branch name',  placeholder: 'e.g. master' },
  tag:    { label: 'Tag / version', placeholder: 'e.g. v0.3.27' },
  commit: { label: 'Commit SHA',    placeholder: 'e.g. a1b2c3d' },
  pr:     { label: 'PR number',     placeholder: 'e.g. 1234' },
};

// Only branch/pr modes accept a repo override on the runner side
// (see execute_deploy in comfy-runner/deployments.py — tag/commit/latest/
// pull/reset all ignore repo_url and use the existing origin). Showing
// the field for unsupported modes would be misleading.
const REPO_OVERRIDE_MODES = new Set(['branch', 'pr']);

const LS_KEY = 'dashboard.deploy.repoAuth.v1';

function _loadRemembered() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function _saveRemembered(repo, token) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ repo, token }));
  } catch { /* localStorage may be disabled — silently skip */ }
}

function _clearRemembered() {
  try { localStorage.removeItem(LS_KEY); } catch {}
}

export function openDeploy(host, path, instName) {
  _deployHost = host;
  _deployPath = path;
  document.getElementById('dm-instance').textContent = instName || '(default)';
  document.querySelector('input[name="dm-mode"][value="latest"]').checked = true;
  document.getElementById('dm-force').checked = false;

  // Prefill repo/token from localStorage if the user opted in last time.
  const remembered = _loadRemembered();
  const repoInput  = document.getElementById('dm-repo-url');
  const tokenInput = document.getElementById('dm-gh-token');
  const rememberCb = document.getElementById('dm-remember-token');
  const details    = document.getElementById('dm-repo-details');
  if (repoInput)  repoInput.value  = remembered?.repo  || '';
  if (tokenInput) tokenInput.value = remembered?.token || '';
  if (rememberCb) rememberCb.checked = !!remembered;
  // Auto-expand the section when there's something prefilled, so the user
  // notices that token/repo are about to be sent.
  if (details) details.open = !!remembered;

  dmModeChange();
  document.getElementById('deploy-modal').classList.add('open');
}

export function closeDeploy() {
  document.getElementById('deploy-modal').classList.remove('open');
}

export function dmModeChange() {
  const mode = document.querySelector('input[name="dm-mode"]:checked')?.value;
  const inputRow = document.getElementById('dm-input-row');
  const cfg = DM_INPUTS[mode];
  if (cfg) {
    document.getElementById('dm-input-label').textContent = cfg.label;
    document.getElementById('dm-input-val').placeholder = cfg.placeholder;
    document.getElementById('dm-input-val').value = '';
    inputRow.style.display = 'block';
  } else {
    inputRow.style.display = 'none';
  }

  // Show the repo/auth block only for modes the runner will actually use it.
  const repoRow = document.getElementById('dm-repo-row');
  if (repoRow) {
    repoRow.style.display = REPO_OVERRIDE_MODES.has(mode) ? 'block' : 'none';
  }
}

// Inject a GitHub token into an https://github.com URL using the
// x-access-token form. Other hosts (GitLab, Gitea, self-hosted GHE) are
// passed through unchanged — we only know how to auth the canonical
// github.com endpoint.
function _injectToken(repoUrl, token) {
  if (!repoUrl || !token) return repoUrl;
  try {
    const u = new URL(repoUrl);
    if (u.hostname !== 'github.com') return repoUrl;
    // If user already pasted a credentialed URL, leave it alone.
    if (u.username || u.password) return repoUrl;
    u.username = 'x-access-token';
    u.password = token;
    return u.toString();
  } catch {
    // Malformed URL — fall back to the original; runner will reject it.
    return repoUrl;
  }
}

export function submitDeploy() {
  const mode  = document.querySelector('input[name="dm-mode"]:checked')?.value;
  const val   = document.getElementById('dm-input-val').value.trim();
  const start = document.getElementById('dm-start').checked;
  const force = document.getElementById('dm-force').checked;

  const body = { start };
  if (force) body.force = true;
  if      (mode === 'latest') body.latest = true;
  else if (mode === 'pull')   body.pull   = true;
  else if (mode === 'reset')  body.reset  = true;
  else if (mode === 'branch') body.branch = val || 'master';
  else if (mode === 'tag')    body.tag    = val;
  else if (mode === 'commit') body.commit = val;
  else if (mode === 'pr')     body.pr     = parseInt(val) || 0;

  if (REPO_OVERRIDE_MODES.has(mode)) {
    const repoUrl = document.getElementById('dm-repo-url').value.trim();
    const token   = document.getElementById('dm-gh-token').value.trim();
    const remember = document.getElementById('dm-remember-token').checked;

    if (repoUrl) {
      body.repo = _injectToken(repoUrl, token);
    }

    // Persistence: tied to the checkbox, not to whether token/repo are
    // currently filled — unchecking + submitting wipes any prior save.
    if (remember && (repoUrl || token)) {
      _saveRemembered(repoUrl, token);
    } else if (!remember) {
      _clearRemembered();
    }
  }

  closeDeploy();
  callEndpoint(_deployHost, 'POST', _deployPath, JSON.stringify(body));
}

document.getElementById('deploy-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeDeploy();
});
