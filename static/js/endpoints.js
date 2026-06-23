import { API, esc, fmtUptime, callEndpoint } from './utils.js';
import { openModal } from './modals/generic.js';
import { openDeploy } from './modals/deploy.js';
import { openModelModal } from './modals/model.js';

// Safely embed an arbitrary string as a JS argument inside an HTML on* attribute.
// JSON.stringify gives us a valid JS string literal; esc() then makes it safe
// for the surrounding double-quoted HTML attribute. Without this, an instance
// name containing a quote, slash, or HTML special char silently corrupts the
// onclick handler — clicks then fire against the wrong instance.
function jsArg(s) {
  return esc(JSON.stringify(String(s ?? '')));
}

// Normalise a deployed_repo value to a short ``owner/repo`` slug for
// display. Accepts bare slugs, plain https URLs, and credentialed URLs
// (``https://x-access-token:TOKEN@github.com/owner/repo.git``).
// Returns null when the value isn't a recognisable GitHub repo, so the
// caller can fall back to a generic "#N" label instead of leaking the
// full string into the UI.
function _extractRepoSlug(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^[^\/\s]+\/[^\/\s]+$/.test(s)) return s.replace(/\.git$/, '');
  try {
    const u = new URL(s);
    if (u.hostname !== 'github.com') return null;
    const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1].replace(/\.git$/, '')}`;
  } catch {
    return null;
  }
}

const ENDPOINTS = [
  // Global
  { section: 'Global', method: 'GET',    path: '/status',        desc: 'Aggregate status' },
  { section: 'Global', method: 'GET',    path: '/installations', desc: 'List installations' },
  { section: 'Global', method: 'GET',    path: '/system-info',   desc: 'System & hardware info' },
  { section: 'Global', method: 'GET',    path: '/jobs',          desc: 'List background jobs' },
  { section: 'Global', method: 'GET',    path: '/config',        desc: 'View global config' },
  { section: 'Global', method: 'PUT',    path: '/config',        desc: 'Update global config', hasBody: true },
  { section: 'Global', method: 'POST',   path: '/deploy',        desc: 'Deploy (default instance)', hasBody: true },
  { section: 'Global', method: 'POST',   path: '/restart',       desc: 'Restart default instance' },
  { section: 'Global', method: 'POST',   path: '/stop',          desc: 'Stop default instance' },
  { section: 'Global', method: 'POST',   path: '/self-update',   desc: 'Update server & restart', hasBody: true },
  { section: 'Global', method: 'GET',    path: '/startup-log',   desc: 'Tail server startup log (?lines=N)' },
  { section: 'Global', method: 'GET',    path: '/tailnet/runners', desc: 'Auto-discover comfy-runners on tailnet' },
  { section: 'Global', method: 'POST',   path: '/pods/self-update', desc: 'Fan out self-update across tailnet', hasBody: true },
  { section: 'Global', method: 'GET',    path: '/openapi.json', desc: 'OpenAPI schema of this runner' },
  // Instance
  { section: 'Instance', method: 'GET',    path: '/{name}/status',        desc: 'Instance status' },
  { section: 'Instance', method: 'GET',    path: '/{name}/info',          desc: 'Installation info' },
  { section: 'Instance', method: 'GET',    path: '/{name}/logs',          desc: 'Get logs' },
  { section: 'Instance', method: 'GET',    path: '/{name}/logs/sessions', desc: 'List log sessions' },
  { section: 'Instance', method: 'POST',   path: '/{name}/start',         desc: 'Start', hasBody: true },
  { section: 'Instance', method: 'POST',   path: '/{name}/stop',          desc: 'Stop' },
  { section: 'Instance', method: 'POST',   path: '/{name}/restart',       desc: 'Restart', hasBody: true },
  { section: 'Instance', method: 'POST',   path: '/{name}/deploy',        desc: 'Deploy branch/tag/commit', hasBody: true },
  { section: 'Instance', method: 'GET',    path: '/{name}/config',        desc: 'View config' },
  { section: 'Instance', method: 'PUT',    path: '/{name}/config',        desc: 'Update instance config', hasBody: true },
  { section: 'Instance', method: 'POST',   path: '/{name}/rename',        desc: 'Rename installation', hasBody: true },
  { section: 'Instance', method: 'POST',   path: '/{name}/unlock',        desc: 'Force-release stuck lock' },
  { section: 'Instance', method: 'DELETE', path: '/{name}',               desc: 'Remove installation' },
  { section: 'Instance', method: 'POST',   path: '/{name}/tunnel/start',  desc: 'Start Tailscale tunnel for instance', hasBody: true },
  { section: 'Instance', method: 'POST',   path: '/{name}/tunnel/stop',   desc: 'Stop Tailscale tunnel for instance' },
  // Nodes
  { section: 'Nodes', method: 'GET',  path: '/{name}/nodes', desc: 'List custom nodes' },
  { section: 'Nodes', method: 'POST', path: '/{name}/nodes', desc: 'Custom node action', hasBody: true },
  // Models
  { section: 'Models', method: 'POST', path: '/{name}/download-model',      desc: 'Download a model', hasBody: true },
  { section: 'Models', method: 'POST', path: '/{name}/move-model',          desc: 'Move/copy a model', hasBody: true },
  { section: 'Models', method: 'POST',   path: '/{name}/upload-model',        desc: 'Upload model file', hasBody: true },
  { section: 'Models', method: 'GET',    path: '/{name}/upload-model/status', desc: 'Upload status' },
  { section: 'Models', method: 'DELETE', path: '/{name}/upload-model/status', desc: 'Cancel current upload' },
  { section: 'Models', method: 'POST',   path: '/{name}/workflow-models',     desc: 'Extract & download models from a workflow JSON', hasBody: true },
  // Outputs
  { section: 'Outputs', method: 'GET', path: '/{name}/outputs', desc: 'List output files (?prefix=&limit=&after=)' },
  { section: 'Outputs', method: 'GET', path: '/{name}/outputs/{filepath}', desc: 'Download a single output file', pathParams: ['filepath'] },
  // ComfyUI proxy — direct passthrough to the instance's running ComfyUI server.
  // Useful when the instance has no Tailscale serve URL / ngrok tunnel and you
  // still want to poke /system_stats, /queue, etc., from the dashboard host.
  { section: 'ComfyUI', method: 'GET',  path: '/{name}/comfyui/{subpath}', desc: 'Proxy GET to ComfyUI', pathParams: ['subpath'] },
  { section: 'ComfyUI', method: 'POST', path: '/{name}/comfyui/{subpath}', desc: 'Proxy POST to ComfyUI', hasBody: true, pathParams: ['subpath'] },
  // Snapshot
  { section: 'Snapshot', method: 'GET',  path: '/{name}/snapshot',                          desc: 'List snapshots' },
  { section: 'Snapshot', method: 'POST', path: '/{name}/snapshot/save',                     desc: 'Capture snapshot' },
  { section: 'Snapshot', method: 'POST', path: '/{name}/snapshot/restore',                  desc: 'Restore snapshot', hasBody: true },
  { section: 'Snapshot', method: 'POST', path: '/{name}/snapshot/import',                   desc: 'Import & restore', hasBody: true },
  { section: 'Snapshot', method: 'GET',  path: '/{name}/snapshot/{snapshot_id}',            desc: 'Show snapshot details', pathParams: ['snapshot_id'] },
  { section: 'Snapshot', method: 'GET',  path: '/{name}/snapshot/{snapshot_id}/diff',       desc: 'Diff snapshot vs current', pathParams: ['snapshot_id'] },
  { section: 'Snapshot', method: 'GET',  path: '/{name}/snapshot/{snapshot_id}/diff/{other_id}', desc: 'Diff two snapshots', pathParams: ['snapshot_id', 'other_id'] },
  { section: 'Snapshot', method: 'GET',  path: '/{name}/snapshot/{snapshot_id}/export',     desc: 'Export snapshot to JSON', pathParams: ['snapshot_id'] },
  // Reviews — prepare an installation for reviewing a PR (extra models / workflows pulled from the PR head).
  { section: 'Reviews', method: 'POST', path: '/reviews/local',  desc: 'Prepare PR review on a named install', hasBody: true },
  { section: 'Reviews', method: 'POST', path: '/reviews/cleanup', desc: 'Tear down review artifacts', hasBody: true },
  // Jobs
  { section: 'Jobs', method: 'GET',  path: '/job/{job_id}',        desc: 'Poll job',    pathParams: ['job_id'] },
  { section: 'Jobs', method: 'POST', path: '/job/{job_id}/cancel', desc: 'Cancel job',  pathParams: ['job_id'] },
];

export async function renderNodePage(host, status) {
  const installations = status.installations || [];

  const infos = await Promise.all(installations.map(async inst => {
    try {
      const r = await fetch(`${API}/api/proxy/${encodeURIComponent(host)}/${encodeURIComponent(inst.name)}/info`);
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }));

  let html = '<div class="instance-grid">';
  for (let i = 0; i < installations.length; i++) {
    html += renderInstanceCard(host, installations[i], infos[i]);
  }
  html += renderAddInstanceCard(host);
  html += '</div>';

  if (installations.length) {
    html += renderEndpointPanel(host, installations);
  }

  document.getElementById('main-content').innerHTML = html;
}

function renderInstanceCard(host, inst, info) {
  const uptime      = fmtUptime(inst.uptime_s || 0);
  const shortCommit = info?.head_commit ? info.head_commit.slice(0, 7) : null;
  const ref         = info?.comfyui_ref || null;
  const branch      = info?.deployed_branch || null;
  const serveUrl    = info?.serve_url  || null;   // Tailscale-served HTTPS URL
  const tunnelUrl   = info?.tunnel_url || null;   // ngrok / public tunnel URL
  const prNumber    = info?.deployed_pr || null;
  const prRepo      = info?.deployed_repo || null;
  const prTitle     = info?.deployed_title || null;

  // Open buttons — only shown when the instance is running and the URL exists.
  const openLinks = inst.running
    ? `${serveUrl  ? `<a class="btn-link btn-sm" href="${esc(serveUrl)}"  target="_blank" rel="noopener" title="${esc(serveUrl)}">↗ Open</a>`  : ''}
       ${tunnelUrl ? `<a class="btn-link btn-sm btn-link-ngrok" href="${esc(tunnelUrl)}" target="_blank" rel="noopener" title="${esc(tunnelUrl)}">↗ ngrok</a>` : ''}`
    : '';

  // PR badge — when this install is checked out at a PR head, surface it
  // prominently so it's obvious the instance is running review code rather
  // than a release/branch. We accept ``deployed_repo`` in several shapes
  // (bare "owner/repo", full https URL, token-laced URL) and normalise
  // to a short "owner/repo" label; otherwise the badge balloons across the
  // card and leaks credentials in the UI.
  let prBadge = '';
  if (prNumber) {
    const repoSlug = _extractRepoSlug(prRepo);
    const shortLabel = repoSlug ? `${repoSlug}#${prNumber}` : `#${prNumber}`;
    const tipParts = [];
    if (prTitle) tipParts.push(prTitle);
    if (repoSlug) tipParts.push(`${repoSlug}#${prNumber}`);
    else tipParts.push(`PR #${prNumber}`);
    const tip = tipParts.join(' — ');
    if (repoSlug) {
      const href = `https://github.com/${repoSlug}/pull/${prNumber}`;
      prBadge = `<a class="ver-pr" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(tip)}">PR ${esc(shortLabel)}</a>`;
    } else {
      prBadge = `<span class="ver-pr" title="${esc(tip)}">PR ${esc(shortLabel)}</span>`;
    }
  }

  const versionHtml = (ref || shortCommit || branch || prBadge)
    ? `<div class="inst-version">
        ${prBadge}
        ${ref         ? `<span class="ver-tag">${esc(ref)}</span>` : ''}
        ${branch      ? `<span class="ver-branch"><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style="opacity:.7"><path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM4.25 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z"/></svg>${esc(branch)}</span>` : ''}
        ${shortCommit ? `<span class="ver-commit" title="${esc(info.head_commit || '')}">${esc(shortCommit)}</span>` : ''}
      </div>`
    : `<div class="inst-version"><span style="color:#333;font-size:0.65rem">—</span></div>`;

  const toggleBtn = inst.running
    ? `<button class="btn-red btn-sm" onclick="window.callEndpoint(${jsArg(host)},'POST','/'+${jsArg(inst.name)}+'/stop')">Stop</button>`
    : `<button class="btn-green btn-sm" onclick="window.callEndpoint(${jsArg(host)},'POST','/'+${jsArg(inst.name)}+'/start')">Start</button>`;

  // Three-state health signal lives on the top-row dot now:
  //   - stopped:   grey
  //   - running + healthy:   green (with halo)
  //   - running + unhealthy: amber (with halo) — process alive but the
  //     HTTP health probe failed, usually means ComfyUI is still booting
  //     or hung. The actionable case; surface in the tooltip.
  let healthState, healthTip;
  if (!inst.running) {
    healthState = 'stopped';
    healthTip = 'Stopped';
  } else if (inst.healthy) {
    healthState = 'healthy';
    healthTip = 'Running — healthy';
  } else {
    healthState = 'unhealthy';
    healthTip = 'Running — health probe failed (still booting or hung)';
  }

  return `
  <div class="instance-card is-${healthState}">
    <div class="inst-top">
      <span class="inst-status-dot dot-${healthState}" title="${esc(healthTip)}"></span>
      <span class="inst-name">${esc(inst.name)}</span>
      <span class="inst-open-links">${openLinks}</span>
      <span class="inst-toggle">${toggleBtn}</span>
    </div>

    ${versionHtml}

    <div class="inst-meta">
      <div class="meta-item">
        <div class="meta-label">Port</div>
        <div class="meta-val">${inst.port != null && inst.port !== 'undefined' ? esc(String(inst.port)) : '–'}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Uptime</div>
        <div class="meta-val">${inst.running ? uptime : '–'}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">PID</div>
        <div class="meta-val">${inst.pid || '–'}</div>
      </div>
    </div>

    <div class="inst-actions">
      <button class="btn-ghost btn-sm" onclick="window.callEndpoint(${jsArg(host)},'POST','/'+${jsArg(inst.name)}+'/restart')">↺ Restart</button>
      <button class="btn-ghost btn-sm" onclick="window.openDeploy(${jsArg(host)},'/'+${jsArg(inst.name)}+'/deploy',${jsArg(inst.name)})">⬆ Deploy</button>
      <button class="btn-ghost btn-sm" onclick="window.openLaunchArgs(${jsArg(host)},${jsArg(inst.name)})">⚙ Launch args</button>
      <button class="btn-ghost btn-sm" onclick="window.openModelModal(${jsArg(host)},${jsArg(inst.name)},'download')">⊞ Models</button>
      <button class="btn-ghost btn-sm inst-more-btn" onclick="window.toggleInstMenu(event, ${jsArg(inst.name)})" title="More actions">⋮</button>
      <div class="inst-more-menu" id="inst-more-menu-${esc(inst.name)}">
        <button class="inst-more-item" onclick="window.callEndpoint(${jsArg(host)},'POST','/'+${jsArg(inst.name)}+'/unlock'); window.closeInstMenus()">
          <span>🔓 Force unlock</span>
          <span class="inst-more-hint">Release stuck lock (use when ops report "is busy")</span>
        </button>
        <button class="inst-more-item" onclick="window.callEndpoint(${jsArg(host)},'GET','/'+${jsArg(inst.name)}+'/logs'); window.closeInstMenus()">
          <span>📜 View logs</span>
          <span class="inst-more-hint">Tail recent stdout/stderr</span>
        </button>
        <button class="inst-more-item inst-more-item-danger" onclick="window.confirmDeleteInstance(${jsArg(host)}, ${jsArg(inst.name)})">
          <span>🗑 Delete instance</span>
          <span class="inst-more-hint">Remove install record (irreversible)</span>
        </button>
      </div>
    </div>

    <div id="card-resp-${esc(inst.name)}" class="card-resp"></div>
  </div>`;
}

// "+ New instance" placeholder tile rendered at the end of the grid.
// Initialising a fresh install on the remote runner is just a deploy call
// with the instance name set to something new — comfy-runner auto-inits
// when no record exists, then proceeds with the deploy mode (we use
// `latest`, which downloads the standalone env + latest stable ComfyUI).
function renderAddInstanceCard(host) {
  return `
  <div class="instance-card instance-card-add" onclick="window.openNewInstance(${jsArg(host)})" role="button" tabindex="0">
    <div class="add-plus">+</div>
    <div class="add-label">New instance</div>
    <div class="add-sub">Initialise a fresh ComfyUI install on this node</div>
  </div>`;
}

function renderEndpointPanel(host, installations) {
  const instNames = installations.map(i => i.name);
  const sections  = [...new Set(ENDPOINTS.map(e => e.section))];

  const tabsHtml = sections.map((s, i) =>
    `<div class="tab ${i === 0 ? 'active' : ''}" onclick="window.switchTab(${jsArg(s)})">${esc(s)}</div>`
  ).join('');

  const contentHtml = sections.map((s, i) => `
    <div class="tab-content ${i === 0 ? 'active' : ''}" id="tab-${s}">
      ${ENDPOINTS.filter(e => e.section === s).map(ep => renderEpRow(host, ep, instNames)).join('')}
    </div>`
  ).join('');

  return `
  <div class="ep-panel">
    <div class="ep-panel-header">
      <span class="ep-panel-title">API Endpoints</span>
    </div>
    <div class="tabs">${tabsHtml}</div>
    ${contentHtml}
  </div>`;
}

function renderEpRow(host, ep, instNames) {
  const needsName = ep.path.includes('{name}');
  const pathId    = `path-${esc(ep.path.replace(/\//g, '-').replace(/[{}]/g, ''))}`;

  // Free-text params: anything in {curlies} that isn't {name}.
  const freeParams = (ep.path.match(/\{[^}]+\}/g) || [])
    .map(p => p.slice(1, -1))
    .filter(p => p !== 'name');

  let controlHtml = '';
  if (needsName) {
    const opts = instNames.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    controlHtml += `<select class="ep-input" id="sel-${pathId}" style="width:110px">${opts}</select>`;
  }
  for (const p of freeParams) {
    controlHtml += `<input class="ep-input" id="inp-${pathId}-${esc(p)}" placeholder="${esc(p)}" style="width:110px">`;
  }

  return `<div class="ep-row">
    <span class="method-badge m-${ep.method.toLowerCase()}">${ep.method}</span>
    <span class="ep-path">${esc(ep.path)}</span>
    <span class="ep-desc">${esc(ep.desc)}</span>
    <div class="ep-btn-group">
      ${controlHtml}
      <button class="btn-ghost btn-sm" onclick="window.runEp(${jsArg(host)},${jsArg(ep.method)},${jsArg(ep.path)},${jsArg(pathId)},${!!ep.hasBody})">Run</button>
    </div>
  </div>`;
}

export function switchTab(section) {
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.textContent === section));
  document.querySelectorAll('.tab-content').forEach(t =>
    t.classList.toggle('active', t.id === `tab-${section}`));
}

export function runEp(host, method, pathTpl, pathId, hasBody) {
  let resolvedPath = pathTpl;

  if (pathTpl.includes('{name}')) {
    const sel = document.getElementById(`sel-${pathId}`);
    if (sel) resolvedPath = resolvedPath.replace('{name}', sel.value);
  }
  // Resolve any other {placeholder} from free-text inputs.
  const freeParams = (pathTpl.match(/\{[^}]+\}/g) || [])
    .map(p => p.slice(1, -1))
    .filter(p => p !== 'name');
  for (const p of freeParams) {
    const inp = document.getElementById(`inp-${pathId}-${p}`);
    const val = inp ? inp.value.trim() : '';
    resolvedPath = resolvedPath.replace(`{${p}}`, val || `unknown_${p}`);
  }

  if (hasBody && resolvedPath.endsWith('/deploy')) {
    const instName = resolvedPath.split('/')[1] || '';
    openDeploy(host, resolvedPath, instName);
  } else if (hasBody && (resolvedPath.endsWith('/download-model') || resolvedPath.endsWith('/upload-model'))) {
    const instName = resolvedPath.split('/')[1] || '';
    const tab = resolvedPath.endsWith('/upload-model') ? 'upload' : 'download';
    openModelModal(host, instName, tab);
  } else if (hasBody && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    openModal(host, method, resolvedPath);
  } else {
    callEndpoint(host, method, resolvedPath);
  }
}
