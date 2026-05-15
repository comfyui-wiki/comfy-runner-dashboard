export const API = '';

export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtUptime(s) {
  if (s < 60)    return `${Math.round(s)}s`;
  if (s < 3600)  return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

// ── Persistent job log console ──────────────────────────────────────────────
//
// Each logical operation (one callEndpoint call, one external action) gets
// a single entry in the bottom console. Subsequent updates within the same
// operation (poll ticks, follow-up errors) mutate that entry in place, so
// long-running deploys produce one entry that updates live rather than a
// flood. Entries persist across node switches and are only removed when the
// user clicks Clear.

let _entrySeq = 0;
let _entryCount = 0;

function _pad(n) { return String(n).padStart(2, '0'); }
function _now() {
  const d = new Date();
  return `${_pad(d.getHours())}:${_pad(d.getMinutes())}:${_pad(d.getSeconds())}`;
}

function _instFromPath(path) {
  if (!path) return null;
  // Skip leading slash; the first segment is either the instance name or
  // a global verb (/status, /deploy, /self-update, ...).
  const m = String(path).match(/^\/([^\/?#]+)/);
  if (!m) return null;
  const head = m[1];
  const GLOBAL = new Set([
    'status', 'installations', 'system-info', 'jobs', 'config', 'deploy',
    'restart', 'stop', 'self-update', 'startup-log', 'tailnet', 'pods',
    'job',
  ]);
  return GLOBAL.has(head) ? null : head;
}

function _ensureConsole() {
  const body = document.getElementById('job-console-body');
  if (!body) return null;
  return body;
}

function _bumpCount(delta) {
  _entryCount = Math.max(0, _entryCount + delta);
  const el = document.getElementById('job-console-count');
  if (el) el.textContent = String(_entryCount);
}

function _expandIfCollapsed() {
  const panel = document.getElementById('job-console');
  if (panel && panel.classList.contains('collapsed')) {
    panel.classList.remove('collapsed');
    const btn = document.getElementById('job-console-toggle-btn');
    if (btn) btn.textContent = 'Collapse';
  }
}

// Public: create a new entry, returns an id used by updateJobEntry().
export function appendJobEntry({ host = null, instance = null, tag = null, text = '', isError = false } = {}) {
  const body = _ensureConsole();
  if (!body) return null;
  const id = `je-${++_entrySeq}`;
  const el = document.createElement('div');
  el.id = id;
  el.className = `job-entry${isError ? ' error' : ''}`;

  const meta = document.createElement('div');
  meta.className = 'job-entry-meta';
  meta.innerHTML = `
    <span class="ts">${esc(_now())}</span>
    ${host     ? `<span class="host">@${esc(host)}</span>` : ''}
    ${instance ? `<span class="inst">${esc(instance)}</span>` : ''}
    ${tag      ? `<span class="tag">${esc(tag)}</span>` : ''}
  `;
  const bodyEl = document.createElement('div');
  bodyEl.className = 'job-entry-body';
  bodyEl.textContent = text;

  el.appendChild(meta);
  el.appendChild(bodyEl);
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
  _bumpCount(+1);
  _expandIfCollapsed();
  return id;
}

// Public: mutate an existing entry's body / error state in place.
export function updateJobEntry(id, text, isError = false) {
  if (!id) return;
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('error', !!isError);
  const bodyEl = el.querySelector('.job-entry-body');
  if (bodyEl) bodyEl.textContent = text;
  const body = document.getElementById('job-console-body');
  if (body) body.scrollTop = body.scrollHeight;
}

export function clearJobConsole() {
  const body = _ensureConsole();
  if (body) body.innerHTML = '';
  _entryCount = 0;
  const el = document.getElementById('job-console-count');
  if (el) el.textContent = '0';
}

export function toggleJobConsole() {
  const panel = document.getElementById('job-console');
  if (!panel) return;
  const wasCollapsed = panel.classList.toggle('collapsed');
  const btn = document.getElementById('job-console-toggle-btn');
  if (btn) btn.textContent = wasCollapsed ? 'Expand' : 'Collapse';
}

// Backwards-compatible helper for callers that previously wrote into the
// inline #ep-resp box. Appends a fresh standalone entry to the console.
export function showResp(text, isError) {
  appendJobEntry({ text: String(text), isError: !!isError });
}

// ── Endpoint dispatch ──────────────────────────────────────────────────────

// Module-level abort controller for the in-flight job poller, so a new
// callEndpoint always cancels the previous poll loop instead of racing it.
let _jobPollAbort = null;

export async function callEndpoint(host, method, path, body = null) {
  const proxyPath = `${API}/api/proxy/${encodeURIComponent(host)}${path}`;
  const opts = { method };
  if (body) {
    opts.headers = { 'content-type': 'application/json' };
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  // Cancel any prior job poll before kicking off a new request.
  if (_jobPollAbort) { _jobPollAbort.abort(); _jobPollAbort = null; }

  const entryId = appendJobEntry({
    host,
    instance: _instFromPath(path),
    tag: `${method} ${path}`,
    text: '…',
  });

  try {
    const r = await fetch(proxyPath, opts);
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    const pretty = parsed ? JSON.stringify(parsed, null, 2) : text;
    updateJobEntry(entryId, pretty, !r.ok);

    // If the synchronous response succeeded and looks like an async job
    // handle ({ job_id: "..." }), follow it to surface real success/error.
    if (r.ok && parsed && typeof parsed.job_id === 'string') {
      _jobPollAbort = new AbortController();
      await pollJob(host, parsed.job_id, _jobPollAbort.signal, entryId);
    }

    if (['start', 'stop', 'restart', 'deploy', '/config'].some(k => path.includes(k))) {
      setTimeout(() => window.refreshCurrent?.(), 2000);
    }
  } catch (e) {
    updateJobEntry(entryId, `Error: ${e.message}`, true);
  }
}

// Poll /job/<id> until the job leaves the 'running' state, surfacing
// label / status / tail of output on every tick. Stops on abort, terminal
// status, hard timeout, or transport failure. Updates the originating entry
// in place instead of spamming new ones.
async function pollJob(host, jobId, signal, entryId) {
  const url = `${API}/api/proxy/${encodeURIComponent(host)}/job/${encodeURIComponent(jobId)}`;
  const start = Date.now();
  const HARD_TIMEOUT_MS = 30 * 60 * 1000;
  const INTERVAL_MS = 1000;

  while (!signal.aborted) {
    if (Date.now() - start > HARD_TIMEOUT_MS) {
      updateJobEntry(entryId, `Job ${jobId} still running after 30m — stopped polling. Re-poll via GET /job/${jobId}.`, true);
      return;
    }
    let job;
    try {
      const r = await fetch(url, { signal });
      const text = await r.text();
      try { job = JSON.parse(text); } catch { job = null; }
      if (!r.ok || !job) {
        updateJobEntry(entryId, `Job poll failed (HTTP ${r.status}):\n${text}`, true);
        return;
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      updateJobEntry(entryId, `Job poll error: ${e.message}`, true);
      return;
    }

    updateJobEntry(entryId, formatJob(job), job.status === 'error' || job.status === 'cancelled');

    if (job.status && job.status !== 'running') return;

    try { await sleep(INTERVAL_MS, signal); }
    catch { return; }
  }
}

function formatJob(job) {
  const lines = [];
  lines.push(`Job ${job.id || '?'} — ${job.label || ''}`);
  lines.push(`Status: ${job.status}`);
  if (job.error) lines.push(`Error: ${job.error}`);
  if (job.result) lines.push(`Result: ${JSON.stringify(job.result, null, 2)}`);
  const out = Array.isArray(job.output) ? job.output : [];
  if (out.length) {
    const tail = out.slice(-30).join('').replace(/\n+$/, '');
    lines.push('', '--- output (last 30 lines) ---', tail);
  }
  return lines.join('\n');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    }
  });
}
