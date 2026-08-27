import { callEndpoint, esc } from '../utils.js';

let _deployHost = null;
let _deployPath = null;
// Tracking snapshot from the instance card /info — used by Pull mode.
// { pr?: number, branch?: string, repo?: string, title?: string }
let _deployTrack = null;

const DM_INPUTS = {
  branch: { label: 'Branch name',  placeholder: 'e.g. master' },
  tag:    { label: 'Tag / version', placeholder: 'e.g. v0.3.27' },
  commit: { label: 'Commit SHA',    placeholder: 'e.g. a1b2c3d' },
  pr:     { label: 'PR number',     placeholder: 'e.g. 1234' },
};

// Runner only forwards repo_url for branch/pr. Pull-of-PR is rewritten to
// a pr deploy below so auth can still be attached.
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

// Strip credentials before showing a stored/deployed repo URL in the form.
function _stripRepoCreds(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return String(url);
  }
}

function _trackSummary() {
  const t = _deployTrack;
  if (!t) return null;
  if (t.pr) {
    const repo = t.repo ? _stripRepoCreds(t.repo) : '';
    const title = t.title ? ` — ${t.title}` : '';
    return {
      kind: 'pr',
      label: `PR #${t.pr}${title}`,
      detail: repo
        ? `Will re-fetch <strong>PR #${esc(String(t.pr))}</strong>${esc(title)} from <code style="font-size:0.65rem">${esc(repo)}</code>.`
        : `Will re-fetch <strong>PR #${esc(String(t.pr))}</strong>${esc(title)} via the install's <code style="font-size:0.65rem">origin</code>. If GitHub asks for a username, expand Repo &amp; auth and add a token.`,
    };
  }
  if (t.branch) {
    return {
      kind: 'branch',
      label: t.branch,
      detail: `Will pull branch <strong>${esc(t.branch)}</strong> from the install's <code style="font-size:0.65rem">origin</code>.`,
    };
  }
  return {
    kind: 'none',
    label: null,
    detail: 'No tracked PR or branch on this instance. Use <strong>Branch</strong> or <strong>Pull Request</strong> first, or Pull will fail.',
  };
}

/**
 * @param {string} host
 * @param {string} path
 * @param {string} [instName]
 * @param {{ pr?: number|string|null, branch?: string|null, repo?: string|null, title?: string|null }} [track]
 */
export function openDeploy(host, path, instName, track = null) {
  _deployHost = host;
  _deployPath = path;
  _deployTrack = null;
  if (track && typeof track === 'object') {
    const pr = track.pr != null && track.pr !== '' ? Number(track.pr) : null;
    _deployTrack = {
      pr: Number.isFinite(pr) && pr > 0 ? pr : null,
      branch: track.branch ? String(track.branch) : null,
      repo: track.repo ? String(track.repo) : null,
      title: track.title ? String(track.title) : null,
    };
  }

  document.getElementById('dm-instance').textContent = instName || '(default)';
  document.querySelector('input[name="dm-mode"][value="latest"]').checked = true;
  document.getElementById('dm-force').checked = false;

  // Prefill repo/token from localStorage if the user opted in last time.
  // When tracking a PR with a known deployed_repo, prefer that (sans creds)
  // over a stale remembered URL unless the user already saved one.
  const remembered = _loadRemembered();
  const repoInput  = document.getElementById('dm-repo-url');
  const tokenInput = document.getElementById('dm-gh-token');
  const rememberCb = document.getElementById('dm-remember-token');
  const details    = document.getElementById('dm-repo-details');
  const trackedRepo = _stripRepoCreds(_deployTrack?.repo || '');
  if (repoInput)  repoInput.value  = remembered?.repo || trackedRepo || '';
  if (tokenInput) tokenInput.value = remembered?.token || '';
  if (rememberCb) rememberCb.checked = !!remembered;
  if (details) details.open = !!remembered || (!!trackedRepo && !!_deployTrack?.pr);

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

  const summary = _trackSummary();
  const pullHint = document.getElementById('dm-pull-hint');
  const pullBody = document.getElementById('dm-pull-hint-body');
  if (mode === 'pull' && pullHint && pullBody) {
    pullBody.innerHTML = summary
      ? summary.detail
      : 'Could not read this instance\'s tracked ref. Pull may fail if nothing is tracked.';
    pullHint.style.display = 'block';
  } else if (pullHint) {
    pullHint.style.display = 'none';
  }

  // Repo/auth: branch + pr always; pull when tracked target is a PR (so we
  // can rewrite to a credentialed pr deploy).
  const repoRow = document.getElementById('dm-repo-row');
  if (repoRow) {
    const showRepo = REPO_OVERRIDE_MODES.has(mode)
      || (mode === 'pull' && !!_deployTrack?.pr);
    repoRow.style.display = showRepo ? 'block' : 'none';
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

function _applyRepoAuth(body, { requireRepoFields = false } = {}) {
  const repoUrl = document.getElementById('dm-repo-url')?.value.trim() || '';
  const token   = document.getElementById('dm-gh-token')?.value.trim() || '';
  const remember = document.getElementById('dm-remember-token')?.checked;

  if (repoUrl) {
    body.repo = _injectToken(repoUrl, token);
  } else if (requireRepoFields && token && _deployTrack?.repo) {
    // Token alone: inject into the tracked repo URL.
    body.repo = _injectToken(_stripRepoCreds(_deployTrack.repo), token);
  }

  if (remember && (repoUrl || token)) {
    _saveRemembered(repoUrl || _stripRepoCreds(_deployTrack?.repo || ''), token);
  } else if (!remember) {
    _clearRemembered();
  }
}

export function submitDeploy() {
  const mode  = document.querySelector('input[name="dm-mode"]:checked')?.value;
  const val   = document.getElementById('dm-input-val').value.trim();
  const start = document.getElementById('dm-start').checked;
  const force = document.getElementById('dm-force').checked;

  const body = { start };
  if (force) body.force = true;

  if (mode === 'latest') {
    body.latest = true;
  } else if (mode === 'pull') {
    // Runner's {pull:true} re-fetches deployed_pr/branch but cannot take
    // repo/token. When we know the tracked PR, rewrite to an explicit pr
    // deploy so Repo & auth works (fixes HTTPS "Username" failures).
    if (_deployTrack?.pr) {
      body.pr = _deployTrack.pr;
      _applyRepoAuth(body, { requireRepoFields: true });
    } else if (_deployTrack?.branch) {
      body.pull = true;
    } else if (!_deployTrack) {
      // No card snapshot (opened from endpoint panel) — send pull and let
      // the runner decide from its install record.
      body.pull = true;
    } else {
      alert('Nothing to pull: this instance has no tracked PR or branch.\nUse Branch or Pull Request first.');
      return;
    }
  } else if (mode === 'reset') {
    body.reset = true;
  } else if (mode === 'branch') {
    body.branch = val || 'master';
    _applyRepoAuth(body);
  } else if (mode === 'tag') {
    body.tag = val;
  } else if (mode === 'commit') {
    body.commit = val;
  } else if (mode === 'pr') {
    body.pr = parseInt(val, 10) || 0;
    _applyRepoAuth(body);
  }

  closeDeploy();
  callEndpoint(_deployHost, 'POST', _deployPath, JSON.stringify(body));
}

document.getElementById('deploy-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeDeploy();
});
