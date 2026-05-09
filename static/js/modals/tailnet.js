import { API, esc } from '../utils.js';
import { getCurrentHost } from '../nodes.js';

// ── Tailnet runners modal ────────────────────────────────────────────────────

export async function loadTailnetRunners() {
  const host = getCurrentHost();
  if (!host) return;

  const modal = document.getElementById('tailnet-modal');
  const body  = document.getElementById('tailnet-body');
  body.innerHTML = '<div style="padding:1.5rem;text-align:center;color:#666"><span class="spinner"></span> Discovering runners on tailnet…</div>';
  modal.classList.add('open');

  try {
    const r = await fetch(`${API}/api/proxy/${encodeURIComponent(host)}/tailnet/runners`);
    if (r.status === 404) {
      body.innerHTML = '<div style="padding:1.5rem;text-align:center;color:#888;font-size:0.78rem">This node does not support tailnet auto-discovery (older comfy-runner version).</div>';
      return;
    }
    const data = await r.json();
    body.innerHTML = renderTailnetRunners(data);
  } catch (e) {
    body.innerHTML = `<div style="padding:1.5rem;text-align:center;color:#f87171;font-size:0.78rem">Error: ${esc(e.message)}</div>`;
  }
}

function renderTailnetRunners(data) {
  if (!data.tailnet_configured) {
    return `<div style="padding:1.5rem;text-align:center;color:#888;font-size:0.78rem">
      Tailnet not configured on this server.<br>
      <small style="color:#555">Set tailscale_api_key + tailnet in config to enable auto-discovery.</small>
    </div>`;
  }
  if (data.error) {
    return `<div style="padding:1rem 1.5rem;color:#f87171;font-size:0.78rem">
      <strong>Tailnet discovery failed:</strong><br>${esc(data.error)}
    </div>`;
  }

  const runners = data.runners || [];
  const stats = `
    <div style="padding:0.6rem 1rem;font-size:0.7rem;color:#666;border-bottom:1px solid #1e1e1e;display:flex;gap:1rem">
      <span><b style="color:#aaa">${runners.length}</b> runners</span>
      <span><b style="color:#aaa">${data.online_count}</b> online</span>
      <span><b style="color:#aaa">${data.device_count}</b> total devices</span>
      <button class="btn-ghost btn-sm" style="margin-left:auto" onclick="window.loadTailnetRunners(true)">↻ Refresh</button>
    </div>`;

  if (!runners.length) {
    return stats + `<div style="padding:1.5rem;text-align:center;color:#666;font-size:0.78rem">No comfy-runners detected on tailnet.</div>`;
  }

  const rows = runners.map(r => {
    const purposeBadge = r.purpose
      ? `<span class="ver-tag" style="background:#1a1a3a;color:#a5b4fc">${esc(r.purpose)}${r.pr_number ? ' #' + r.pr_number : ''}</span>`
      : '';
    const providerBadge = r.provider
      ? `<span style="font-size:0.62rem;color:#888;background:#1c1c1c;padding:0.1rem 0.4rem;border-radius:3px">${esc(r.provider)}</span>`
      : '';
    return `<div class="tn-row">
      <div class="tn-name">
        <div style="display:flex;align-items:center;gap:0.4rem">
          <span class="dot dot-on"></span>
          <span style="font-weight:500;color:#ddd;font-size:0.78rem">${esc(r.hostname)}</span>
          ${providerBadge}
          ${purposeBadge}
        </div>
        <div style="font-size:0.65rem;color:#555;font-family:'SF Mono',monospace;margin-top:0.2rem">${esc(r.fqdn || r.host || '')}</div>
      </div>
      <div class="tn-hw">
        ${r.gpu  ? `<div title="GPU">🖥 ${esc(r.gpu)}</div>` : ''}
        ${r.ram_gb ? `<div title="RAM">⊟ ${esc(r.ram_gb)} GB</div>` : ''}
      </div>
      <div class="tn-actions">
        ${r.server_url ? `<a href="${esc(r.server_url)}" target="_blank" class="btn-ghost btn-sm" style="text-decoration:none">↗ Open</a>` : ''}
      </div>
    </div>`;
  }).join('');

  return stats + `<div class="tn-list">${rows}</div>`;
}

export function closeTailnetModal() {
  document.getElementById('tailnet-modal').classList.remove('open');
}

// ── Fanout (POST /pods/self-update) modal ────────────────────────────────────

export function openFanoutModal() {
  document.getElementById('fanout-names').value = '';
  document.getElementById('fanout-force').checked = false;
  document.getElementById('fanout-resp').textContent = '';
  document.getElementById('fanout-resp').className = 'mm-resp';
  document.getElementById('fanout-modal').classList.add('open');
}

export function closeFanoutModal() {
  document.getElementById('fanout-modal').classList.remove('open');
}

export async function submitFanout() {
  const host = getCurrentHost();
  if (!host) return;

  const namesRaw = document.getElementById('fanout-names').value.trim();
  const force    = document.getElementById('fanout-force').checked;
  const names    = namesRaw ? namesRaw.split(/[\s,]+/).filter(Boolean) : [];

  const targetMsg = names.length ? `${names.length} pod(s)` : 'ALL online pods';
  if (!confirm(`Fan out self-update${force ? ' (--force)' : ''} to ${targetMsg}?`)) return;

  const btn = document.getElementById('fanout-btn');
  btn.disabled = true; btn.textContent = '⏳ Running…';

  const respEl = document.getElementById('fanout-resp');
  respEl.textContent = 'Running…';
  respEl.className = 'mm-resp visible';

  const body = { force };
  if (names.length) body.names = names;

  try {
    const r = await fetch(`${API}/api/proxy/${encodeURIComponent(host)}/pods/self-update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      respEl.textContent = `Error: ${data.error || JSON.stringify(data)}`;
      respEl.className = 'mm-resp visible error';
      return;
    }
    const lines = [
      `Total: ${data.total ?? '?'}  ✓ ${data.ok_count ?? 0}  ⬆ updated ${data.updated_count ?? 0}  ✗ ${data.failed_count ?? 0}`,
      data.skipped_self ? `Skipped self: ${data.skipped_self}` : '',
      '',
      ...(data.results || []).map(res => {
        const tag = res.ok ? '✓' : '✗';
        const upd = res.updated ? ' [updated]' : '';
        const err = res.error ? ` — ${res.error}` : '';
        const msg = res.message ? ` — ${res.message}` : '';
        return `${tag} ${res.name || res.host}${upd}${msg || err}`;
      }),
    ].filter(Boolean);
    respEl.textContent = lines.join('\n');
    respEl.className = data.failed_count ? 'mm-resp visible error' : 'mm-resp visible';
  } catch (e) {
    respEl.textContent = `Error: ${e.message}`;
    respEl.className = 'mm-resp visible error';
  } finally {
    btn.disabled = false; btn.textContent = '⚡ Run fanout';
  }
}

// init: close on overlay click
export function initTailnetModals() {
  document.getElementById('tailnet-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeTailnetModal();
  });
  document.getElementById('fanout-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeFanoutModal();
  });
}
