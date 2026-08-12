import { API, esc } from './utils.js';
import { loadPodsSidebar, selectPod } from './pods.js';

const DEFAULT_GPU_NAME = '5090';
const DEFAULT_VOLUME_GB = 200;
const DISK_WITH_VOLUME = 50;
const DISK_WITHOUT_VOLUME = 100;

let _gpus = [];
let _volumes = [];
let _showAllGpus = false;
let _sortBy = 'vram'; // vram | price | stock | name
let _preselectGpu = '';

export async function openStockPage(preselectGpu = '') {
  _preselectGpu = preselectGpu || '';
  document.querySelectorAll('.node-item').forEach(e => e.classList.remove('active'));
  document.getElementById('btn-update').style.display = 'none';
  document.getElementById('btn-update-force').style.display = 'none';
  const ngBtn = document.getElementById('btn-ngrok-config');
  if (ngBtn) ngBtn.style.display = 'none';
  const hw = document.getElementById('page-hw');
  if (hw) hw.innerHTML = '';

  document.getElementById('page-title').textContent = 'Launch machine';
  document.getElementById('page-sub').textContent = 'RunPod · pick GPU + place, then launch';
  document.getElementById('main-content').innerHTML =
    '<div class="empty"><span class="spinner"></span> Loading availability…</div>';

  try {
    const [stockRes, volRes] = await Promise.all([
      fetch(`${API}/api/runpod/stock`),
      fetch(`${API}/api/runpod/volumes`),
    ]);
    const stock = await stockRes.json().catch(() => ({}));
    const vols = await volRes.json().catch(() => ({}));
    if (!stockRes.ok) throw new Error(stock.detail || stock.error || `HTTP ${stockRes.status}`);
    _gpus = stock.gpus || [];
    _volumes = vols.volumes || [];
    renderLaunchPage();
  } catch (e) {
    document.getElementById('main-content').innerHTML =
      `<div class="empty" style="color:#555">Failed to load availability<br><small>${esc(e.message)}</small></div>`;
  }
}

function _fmtMoney(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `$${Number(n).toFixed(2)}`;
}

function _gpuOptions() {
  let list = _gpus.slice();
  if (!_showAllGpus) {
    // Only GPUs that currently have at least one datacenter with stock.
    list = list.filter(g => (g.available_dc_count || 0) > 0);
  }

  const stockRank = { High: 0, Medium: 1, Low: 2, Unavailable: 9 };
  const nameOf = g => (g.display_name || g.id || '').toLowerCase();
  const vramOf = g => Number(g.memory_gb) || 0;
  const priceOf = g => (g.price_usd == null || Number.isNaN(Number(g.price_usd))
    ? Number.POSITIVE_INFINITY
    : Number(g.price_usd));

  list.sort((a, b) => {
    switch (_sortBy) {
      case 'price':
        return priceOf(a) - priceOf(b) || nameOf(a).localeCompare(nameOf(b));
      case 'price_desc':
        return priceOf(b) - priceOf(a) || nameOf(a).localeCompare(nameOf(b));
      case 'vram':
        return vramOf(b) - vramOf(a) || priceOf(a) - priceOf(b) || nameOf(a).localeCompare(nameOf(b));
      case 'vram_asc':
        return vramOf(a) - vramOf(b) || priceOf(a) - priceOf(b) || nameOf(a).localeCompare(nameOf(b));
      case 'name':
        return nameOf(a).localeCompare(nameOf(b));
      case 'stock':
      default:
        return (stockRank[a.stock] ?? 5) - (stockRank[b.stock] ?? 5)
          || priceOf(a) - priceOf(b)
          || nameOf(a).localeCompare(nameOf(b));
    }
  });
  return list;
}

function _pickDefaultGpuId(options) {
  if (!options.length) return '';
  const pref = (_preselectGpu || DEFAULT_GPU_NAME).toLowerCase();
  const hit = options.find(g =>
    (g.id || '').toLowerCase().includes(pref)
    || (g.display_name || '').toLowerCase().includes(pref),
  );
  if (hit) return hit.id;
  const inStock = options.find(g => g.stock !== 'Unavailable');
  return (inStock || options[0]).id;
}

function _volumesForDc(dcId) {
  if (!dcId) return [];
  return _volumes.filter(v => v.datacenter === dcId);
}

function _volumeNameForDc(dcId) {
  const slug = String(dcId || 'vol').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `workspace-${slug}`.slice(0, 64);
}

function renderLaunchPage() {
  const prevGpu = document.getElementById('launch-gpu')?.value || '';
  const prevDc = document.getElementById('launch-dc')?.value || '';
  const prevStorage = document.getElementById('launch-storage')?.value || 'keep';
  const prevName = document.getElementById('launch-name')?.value || 'my-comfy';
  const showAll = document.getElementById('launch-show-all')?.checked ?? _showAllGpus;
  const sortBy = document.getElementById('launch-sort')?.value || _sortBy;
  _showAllGpus = showAll;
  _sortBy = sortBy;
  const options = _gpuOptions();

  const gpuId = options.some(g => g.id === prevGpu) ? prevGpu : _pickDefaultGpuId(options);
  const gpu = _gpus.find(g => g.id === gpuId) || null;
  const dcs = (gpu?.datacenters || [])
    .filter(d => d.available)
    .slice()
    .sort((a, b) => {
      const av = _volumesForDc(a.id).length ? 0 : 1;
      const bv = _volumesForDc(b.id).length ? 0 : 1;
      if (av !== bv) return av - bv;
      const rank = { High: 0, Medium: 1, Low: 2 };
      return (rank[a.stock] ?? 3) - (rank[b.stock] ?? 3) || a.id.localeCompare(b.id);
    });
  const dcId = dcs.some(d => d.id === prevDc) ? prevDc : (dcs[0]?.id || '');
  const sameDcVols = _volumesForDc(dcId);
  const storageHint = prevStorage === 'keep'
    ? (sameDcVols.length
      ? `Will reuse “${sameDcVols[0].name}” (${sameDcVols[0].size_gb}GB) in ${dcId || '—'}. Models survive deleting the machine.`
      : `No disk in ${dcId || 'this place'} yet — will auto-create a ${DEFAULT_VOLUME_GB}GB network volume named ${_volumeNameForDc(dcId)}.`)
    : 'Temporary only. Everything is wiped when you terminate the machine.';

  document.getElementById('main-content').innerHTML = `
    <div class="launch-panel">
      <div class="stock-banner">
        <div>
          <div class="stock-banner-title">Launch a free machine</div>
          <div class="stock-banner-sub">
            Choose a GPU and place that have stock, then launch.
            Prefer <strong>Keep my files</strong> so models stay on a network disk when you delete the machine.
            Stopped machines stay stuck on one host — if Start fails, launch a new one here instead.
          </div>
        </div>
        <button class="btn-ghost btn-sm" type="button" onclick="window.openStockPage()">↻ Refresh</button>
      </div>

      <div class="launch-card">
        <div class="form-row">
          <div class="launch-gpu-toolbar">
            <div class="launch-gpu-field">
              <label class="form-label" for="launch-gpu">GPU</label>
              <select class="ep-input launch-select" id="launch-gpu" onchange="window.renderLaunchPage()">
                ${options.length ? options.map(g => `
                  <option value="${esc(g.id)}" ${g.id === gpuId ? 'selected' : ''}>
                    ${esc(g.display_name)}${g.memory_gb ? ` · ${g.memory_gb}GB VRAM` : ''} · ${esc(g.stock)} · ${esc(_fmtMoney(g.price_usd))}/hr
                  </option>`).join('') : '<option value="">No GPUs available</option>'}
              </select>
            </div>
            <div class="launch-sort-field">
              <label class="form-label" for="launch-sort">Sort by</label>
              <select class="ep-input launch-select" id="launch-sort" onchange="window.renderLaunchPage()">
                <option value="vram" ${sortBy === 'vram' ? 'selected' : ''}>VRAM (high → low)</option>
                <option value="vram_asc" ${sortBy === 'vram_asc' ? 'selected' : ''}>VRAM (low → high)</option>
                <option value="price" ${sortBy === 'price' ? 'selected' : ''}>Price (cheap → expensive)</option>
                <option value="price_desc" ${sortBy === 'price_desc' ? 'selected' : ''}>Price (expensive → cheap)</option>
                <option value="stock" ${sortBy === 'stock' ? 'selected' : ''}>Stock (High → Low)</option>
                <option value="name" ${sortBy === 'name' ? 'selected' : ''}>Name (A → Z)</option>
              </select>
            </div>
          </div>
          <label class="stock-check launch-show-all">
            <input type="checkbox" id="launch-show-all" ${showAll ? 'checked' : ''}
                   onchange="window.renderLaunchPage()">
            Show empty GPUs too (0 places / unavailable)
          </label>
        </div>

        <div class="form-row">
          <label class="form-label" for="launch-dc">Place (datacenter)</label>
          <select class="ep-input launch-select" id="launch-dc" onchange="window.renderLaunchPage()"
                  ${dcs.length ? '' : 'disabled'}>
            ${dcs.length ? dcs.map(d => {
              const hasVol = _volumesForDc(d.id).length > 0;
              return `<option value="${esc(d.id)}" ${d.id === dcId ? 'selected' : ''}>
                ${esc(d.id)} · ${esc(d.location || '—')} · ${esc(d.stock)}${hasVol ? ' · has volume' : ''}
              </option>`;
            }).join('') : '<option value="">No place with stock for this GPU</option>'}
          </select>
        </div>

        <div class="form-row">
          <label class="form-label" for="launch-storage">Storage</label>
          <select class="ep-input launch-select" id="launch-storage" onchange="window.renderLaunchPage()">
            <option value="keep" ${prevStorage === 'keep' ? 'selected' : ''}>
              Keep my files (network volume — recommended)
            </option>
            <option value="temp" ${prevStorage === 'temp' ? 'selected' : ''}>
              Temporary (wiped when deleted)
            </option>
          </select>
          <div class="form-hint" id="launch-storage-hint">${esc(storageHint)}</div>
        </div>

        <div class="form-row">
          <label class="form-label" for="launch-name">Machine name</label>
          <input class="ep-input" id="launch-name" value="${esc(prevName)}" maxlength="64"
                 placeholder="my-comfy">
          <div class="form-hint">Display name only. If this name is already used, rename or Terminate the old machine first.</div>
        </div>

        <div class="launch-summary">
          <div><span class="launch-k">GPU</span> ${gpu ? esc(gpu.display_name) : '—'}</div>
          <div><span class="launch-k">VRAM</span> ${gpu?.memory_gb != null ? esc(String(gpu.memory_gb) + ' GB') : '—'}</div>
          <div><span class="launch-k">Place</span> ${esc(dcId || '—')}</div>
          <div><span class="launch-k">Cost</span> ${gpu ? esc(_fmtMoney(gpu.price_usd)) + '/hr' : '—'}</div>
        </div>

        <div class="stock-create-actions">
          <button class="btn-green" type="button" id="launch-btn"
                  onclick="window.createPodFromStock()"
                  ${gpu && dcId ? '' : 'disabled'}>▶ Launch machine</button>
        </div>
        <div id="stock-create-msg" class="stock-create-msg"></div>
      </div>
    </div>`;
}

export function renderStockPage() {
  renderLaunchPage();
}

export function selectStockGpu() { /* kept for older onclick safety */ renderLaunchPage(); }
export function selectStockDc() { /* kept for older onclick safety */ renderLaunchPage(); }

export async function createPodFromStock() {
  const gpuId = document.getElementById('launch-gpu')?.value || '';
  const dcId = document.getElementById('launch-dc')?.value || '';
  const storage = document.getElementById('launch-storage')?.value || 'keep';
  const name = document.getElementById('launch-name')?.value.trim() || '';
  const msg = document.getElementById('stock-create-msg');
  const btn = document.getElementById('launch-btn');
  const gpu = _gpus.find(g => g.id === gpuId);

  if (!gpu || !dcId) {
    if (msg) msg.textContent = 'Pick a GPU and a place with stock first.';
    return;
  }
  if (!name) {
    if (msg) msg.textContent = 'Machine name is required.';
    return;
  }

  const keep = storage === 'keep';
  const summary = keep
    ? `Launch “${name}” on ${gpu.display_name} in ${dcId}?\nFiles will be kept on a network volume (~${DEFAULT_VOLUME_GB}GB if a new one is needed).\n~${_fmtMoney(gpu.price_usd)}/hr`
    : `Launch “${name}” on ${gpu.display_name} in ${dcId}?\nTemporary disk — everything is wiped if you terminate.\n~${_fmtMoney(gpu.price_usd)}/hr`;
  if (!confirm(summary)) return;

  if (btn) btn.disabled = true;
  if (msg) msg.innerHTML = '<span class="spinner"></span> Working…';

  try {
    let volumeId = null;
    if (keep) {
      const existing = _volumesForDc(dcId)[0];
      if (existing) {
        volumeId = existing.id;
        if (msg) msg.innerHTML = `<span class="spinner"></span> Using volume “${esc(existing.name)}”…`;
      } else {
        const volName = _volumeNameForDc(dcId);
        if (msg) msg.innerHTML = `<span class="spinner"></span> Creating ${DEFAULT_VOLUME_GB}GB volume in ${esc(dcId)}…`;
        const volRes = await fetch(`${API}/api/runpod/volumes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: volName,
            datacenter: dcId,
            size_gb: DEFAULT_VOLUME_GB,
          }),
        });
        const volData = await volRes.json().catch(() => ({}));
        if (!volRes.ok) {
          throw new Error(volData.detail || volData.error || `Volume create failed (${volRes.status})`);
        }
        volumeId = volData.volume?.id;
        if (!volumeId) throw new Error('Volume created but no id returned');
        _volumes.push(volData.volume);
      }
    }

    if (msg) msg.innerHTML = '<span class="spinner"></span> Creating machine…';
    const res = await fetch(`${API}/api/pods`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        gpu_type: gpu.id,
        datacenter: dcId,
        cloud_type: 'COMMUNITY',
        network_volume_id: volumeId,
        container_disk_gb: keep ? DISK_WITH_VOLUME : DISK_WITHOUT_VOLUME,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data.detail || data.error || `HTTP ${res.status}`;
      if (/already|exists|name/i.test(String(detail))) {
        throw new Error(`${detail}\n\nTry another machine name, or Terminate the old machine first.`);
      }
      throw new Error(detail);
    }
    await loadPodsSidebar();
    if (data.pod?.id) {
      await selectPod(data.pod.id);
    } else {
      if (msg) msg.textContent = 'Launched. Select the machine in the sidebar.';
    }
  } catch (e) {
    if (msg) msg.textContent = e.message;
    else alert(e.message);
    if (btn) btn.disabled = false;
  }
}

window.renderLaunchPage = renderLaunchPage;
window.renderStockPage = renderLaunchPage;
