import { API, esc, fmtUptime, callEndpoint } from './utils.js';
import { openModal } from './modals/generic.js';
import { openDeploy } from './modals/deploy.js';
import { openModelModal } from './modals/model.js';

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
  // Nodes
  { section: 'Nodes', method: 'GET',  path: '/{name}/nodes', desc: 'List custom nodes' },
  { section: 'Nodes', method: 'POST', path: '/{name}/nodes', desc: 'Custom node action', hasBody: true },
  // Models
  { section: 'Models', method: 'POST', path: '/{name}/download-model',      desc: 'Download a model', hasBody: true },
  { section: 'Models', method: 'POST', path: '/{name}/move-model',          desc: 'Move/copy a model', hasBody: true },
  { section: 'Models', method: 'POST', path: '/{name}/upload-model',        desc: 'Upload model file', hasBody: true },
  { section: 'Models', method: 'GET',  path: '/{name}/upload-model/status', desc: 'Upload status' },
  // Outputs
  { section: 'Outputs', method: 'GET', path: '/{name}/outputs', desc: 'List output files' },
  // Snapshot
  { section: 'Snapshot', method: 'GET',  path: '/{name}/snapshot',         desc: 'List snapshots' },
  { section: 'Snapshot', method: 'POST', path: '/{name}/snapshot/save',    desc: 'Capture snapshot' },
  { section: 'Snapshot', method: 'POST', path: '/{name}/snapshot/restore', desc: 'Restore snapshot', hasBody: true },
  { section: 'Snapshot', method: 'POST', path: '/{name}/snapshot/import',  desc: 'Import & restore', hasBody: true },
  // Jobs
  { section: 'Jobs', method: 'GET',  path: '/job/{job_id}',        desc: 'Poll job',    pathParams: ['job_id'] },
  { section: 'Jobs', method: 'POST', path: '/job/{job_id}/cancel', desc: 'Cancel job',  pathParams: ['job_id'] },
];

export async function renderNodePage(host, status) {
  const installations = status.installations || [];

  const infos = await Promise.all(installations.map(async inst => {
    try {
      const r = await fetch(`${API}/api/proxy/${encodeURIComponent(host)}/${inst.name}/info`);
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }));

  let html = '<div class="instance-grid">';
  for (let i = 0; i < installations.length; i++) {
    html += renderInstanceCard(host, installations[i], infos[i]);
  }
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

  const versionHtml = (ref || shortCommit || branch)
    ? `<div class="inst-version">
        ${ref         ? `<span class="ver-tag">${esc(ref)}</span>` : ''}
        ${branch      ? `<span class="ver-branch"><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style="opacity:.7"><path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM4.25 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5z"/></svg>${esc(branch)}</span>` : ''}
        ${shortCommit ? `<span class="ver-commit" title="${esc(info.head_commit || '')}">${esc(shortCommit)}</span>` : ''}
      </div>`
    : `<div class="inst-version"><span style="color:#333;font-size:0.65rem">—</span></div>`;

  const toggleBtn = inst.running
    ? `<button class="btn-red btn-sm" onclick="window.callEndpoint('${host}','POST','/${inst.name}/stop')">Stop</button>`
    : `<button class="btn-green btn-sm" onclick="window.callEndpoint('${host}','POST','/${inst.name}/start')">Start</button>`;

  return `
  <div class="instance-card">
    <div class="inst-top">
      <span class="inst-status-dot ${inst.running ? 'dot-on' : 'dot-off'}"></span>
      <span class="inst-name">${esc(inst.name)}</span>
      <span class="inst-toggle">${toggleBtn}</span>
    </div>

    ${versionHtml}

    <div class="inst-meta">
      <div class="meta-item">
        <div class="meta-label">Port</div>
        <div class="meta-val">${inst.port}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Uptime</div>
        <div class="meta-val">${uptime}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">PID</div>
        <div class="meta-val">${inst.pid || '–'}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Health</div>
        <div class="meta-val">
          <span class="badge ${inst.healthy ? 'badge-healthy' : 'badge-unhealthy'}">
            ${inst.healthy ? '● healthy' : '● unhealthy'}
          </span>
        </div>
      </div>
    </div>

    <div class="inst-actions">
      <button class="btn-ghost btn-sm" onclick="window.callEndpoint('${host}','POST','/${inst.name}/restart')">↺ Restart</button>
      <button class="btn-ghost btn-sm" onclick="window.openDeploy('${host}','/${inst.name}/deploy','${inst.name}')">⬆ Deploy</button>
      <button class="btn-ghost btn-sm" onclick="window.openModelModal('${host}','${inst.name}','download')">⊞ Models</button>
    </div>

    <div id="card-resp-${esc(inst.name)}" class="card-resp"></div>
  </div>`;
}

function renderEndpointPanel(host, installations) {
  const instNames = installations.map(i => i.name);
  const sections  = [...new Set(ENDPOINTS.map(e => e.section))];

  const tabsHtml = sections.map((s, i) =>
    `<div class="tab ${i === 0 ? 'active' : ''}" onclick="window.switchTab('${s}')">${s}</div>`
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
    <div id="ep-resp" class="ep-resp"></div>
    ${contentHtml}
  </div>`;
}

function renderEpRow(host, ep, instNames) {
  const needsName = ep.path.includes('{name}');
  const needsJob  = ep.path.includes('{job_id}');
  const pathId    = `path-${esc(ep.path.replace(/\//g, '-').replace(/[{}]/g, ''))}`;

  let controlHtml = '';
  if (needsName) {
    const opts = instNames.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    controlHtml = `<select class="ep-input" id="sel-${pathId}" style="width:110px">${opts}</select>`;
  } else if (needsJob) {
    controlHtml = `<input class="ep-input" id="inp-${pathId}" placeholder="job_id" style="width:110px">`;
  }

  return `<div class="ep-row">
    <span class="method-badge m-${ep.method.toLowerCase()}">${ep.method}</span>
    <span class="ep-path">${esc(ep.path)}</span>
    <span class="ep-desc">${esc(ep.desc)}</span>
    <div class="ep-btn-group">
      ${controlHtml}
      <button class="btn-ghost btn-sm" onclick="window.runEp('${host}','${ep.method}','${ep.path}','${pathId}',${!!ep.hasBody})">Run</button>
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
  if (pathTpl.includes('{job_id}')) {
    const inp = document.getElementById(`inp-${pathId}`);
    if (inp) resolvedPath = resolvedPath.replace('{job_id}', inp.value.trim() || 'unknown');
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
