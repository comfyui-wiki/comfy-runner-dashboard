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

  showResp('…', false);

  try {
    const r = await fetch(proxyPath, opts);
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    const pretty = parsed ? JSON.stringify(parsed, null, 2) : text;
    showResp(pretty, !r.ok);

    // If the synchronous response succeeded and looks like an async job
    // handle ({ job_id: "..." }), follow it to surface real success/error.
    if (r.ok && parsed && typeof parsed.job_id === 'string') {
      _jobPollAbort = new AbortController();
      await pollJob(host, parsed.job_id, _jobPollAbort.signal);
    }

    if (['start', 'stop', 'restart', 'deploy', '/config'].some(k => path.includes(k))) {
      setTimeout(() => window.refreshCurrent?.(), 2000);
    }
  } catch (e) {
    showResp(`Error: ${e.message}`, true);
  }
}

// Poll /job/<id> until the job leaves the 'running' state, surfacing
// label / status / tail of output on every tick. Stops on abort, terminal
// status, hard timeout, or transport failure.
async function pollJob(host, jobId, signal) {
  const url = `${API}/api/proxy/${encodeURIComponent(host)}/job/${encodeURIComponent(jobId)}`;
  const start = Date.now();
  const HARD_TIMEOUT_MS = 30 * 60 * 1000; // 30m — covers long deploys/builds
  const INTERVAL_MS = 1000;

  while (!signal.aborted) {
    if (Date.now() - start > HARD_TIMEOUT_MS) {
      showResp(`Job ${jobId} still running after 30m — stopped polling. Re-poll via GET /job/${jobId}.`, true);
      return;
    }
    let job;
    try {
      const r = await fetch(url, { signal });
      const text = await r.text();
      try { job = JSON.parse(text); } catch { job = null; }
      if (!r.ok || !job) {
        showResp(`Job poll failed (HTTP ${r.status}):\n${text}`, true);
        return;
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      showResp(`Job poll error: ${e.message}`, true);
      return;
    }

    showResp(formatJob(job), job.status === 'error' || job.status === 'cancelled');

    if (job.status && job.status !== 'running') return;

    try { await sleep(INTERVAL_MS, signal); }
    catch { return; } // aborted
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

export function showResp(text, isError) {
  const box = document.getElementById('ep-resp');
  if (!box) return;
  box.textContent = text;
  box.className = `ep-resp visible${isError ? ' error' : ''}`;
  box.scrollTop = box.scrollHeight;
}
