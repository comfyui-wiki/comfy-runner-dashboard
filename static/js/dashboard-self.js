// Dashboard self-management (restart / self-update of THIS dashboard server)

import { API } from './utils.js';

const RESTART_NOTICE_DURATION = 6000;

function showNotice(text, isError = false) {
  let el = document.getElementById('dashboard-notice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'dashboard-notice';
    el.style.cssText = `
      position: fixed; top: 1rem; right: 1rem; z-index: 200;
      background: #161616; border: 1px solid #2a2a2a; border-radius: 8px;
      padding: 0.7rem 1rem; font-size: 0.78rem; color: #ddd;
      box-shadow: 0 6px 20px rgba(0,0,0,0.5); max-width: 360px;
      white-space: pre-wrap;
    `;
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.borderColor = isError ? '#7f1d1d' : '#15803d';
  el.style.color       = isError ? '#fca5a5' : '#86efac';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.remove(), RESTART_NOTICE_DURATION);
}

async function _waitForBackOnline() {
  // Poll the index until it responds again, then reload.
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const r = await fetch(`${API}/api/nodes`, { cache: 'no-store' });
      if (r.ok) {
        showNotice('Dashboard is back online — reloading…');
        setTimeout(() => location.reload(), 600);
        return;
      }
    } catch { /* still down, keep waiting */ }
  }
  showNotice('Dashboard did not come back within 30s. Reload manually.', true);
}

export async function restartDashboard() {
  if (!confirm('Restart the dashboard server?')) return;
  closeDashboardMenu();
  showNotice('Restarting dashboard…');
  try {
    const r = await fetch(`${API}/api/dashboard/restart`, { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    _waitForBackOnline();
  } catch (e) {
    // The reload itself can interrupt the response — assume restart triggered.
    _waitForBackOnline();
  }
}

export async function updateDashboard(force = false) {
  const msg = force
    ? 'Force-update dashboard? This will run git reset --hard, discarding any local changes.'
    : 'Update dashboard via git pull and restart?';
  if (!confirm(msg)) return;
  closeDashboardMenu();
  showNotice(force ? 'Force-updating dashboard…' : 'Updating dashboard…');
  try {
    const r = await fetch(`${API}/api/dashboard/self-update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      showNotice(`Update failed: ${data.detail || data.error || r.statusText}`, true);
      return;
    }
    if (data.updated) {
      showNotice(`Updated:\n${data.message || ''}\nRestarting…`);
    } else {
      showNotice('Already up to date — restarting anyway…');
    }
    _waitForBackOnline();
  } catch (e) {
    // Connection drop during reload is expected.
    _waitForBackOnline();
  }
}

export function dashboardMenu(event) {
  event?.stopPropagation();
  let menu = document.getElementById('dashboard-dropdown');
  if (menu) {
    menu.classList.toggle('open');
    return;
  }
  menu = document.createElement('div');
  menu.id = 'dashboard-dropdown';
  menu.className = 'dropdown open';
  menu.innerHTML = `
    <button class="dropdown-item" onclick="window.restartDashboard()">↺ Restart dashboard</button>
    <button class="dropdown-item" onclick="window.updateDashboard(false)">⬆ Update + restart (git pull)</button>
    <div class="dropdown-divider"></div>
    <button class="dropdown-item danger" onclick="window.updateDashboard(true)">⚠ Force update + restart</button>
  `;
  document.querySelector('.header-actions').appendChild(menu);

  // close on outside click
  setTimeout(() => {
    document.addEventListener('click', closeDashboardMenu, { once: true });
  }, 0);
}

export function closeDashboardMenu() {
  document.getElementById('dashboard-dropdown')?.remove();
}
