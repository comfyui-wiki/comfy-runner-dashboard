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

export async function callEndpoint(host, method, path, body = null) {
  const proxyPath = `${API}/api/proxy/${encodeURIComponent(host)}${path}`;
  const opts = { method };
  if (body) {
    opts.headers = { 'content-type': 'application/json' };
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  showResp('…', false);

  try {
    const r = await fetch(proxyPath, opts);
    const text = await r.text();
    let pretty;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { pretty = text; }
    showResp(pretty, !r.ok);
    if (['start', 'stop', 'restart', 'deploy'].some(k => path.includes(k))) {
      setTimeout(() => window.refreshCurrent?.(), 2000);
    }
  } catch (e) {
    showResp(`Error: ${e.message}`, true);
  }
}

export function showResp(text, isError) {
  const box = document.getElementById('ep-resp');
  if (!box) return;
  box.textContent = text;
  box.className = `ep-resp visible${isError ? ' error' : ''}`;
  box.scrollTop = box.scrollHeight;
}
