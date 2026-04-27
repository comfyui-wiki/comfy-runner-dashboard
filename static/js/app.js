import { callEndpoint } from './utils.js';
import { loadNodes, selectNode, refreshCurrent } from './nodes.js';
import { switchTab, runEp } from './endpoints.js';
import { closeModal, submitModal } from './modals/generic.js';
import { closeDeploy, dmModeChange, submitDeploy, openDeploy } from './modals/deploy.js';
import { closeModelModal, mmSwitchTab, mmSelectDir, mmFileSelected, submitDownload, submitUpload, openModelModal, initDropZone } from './modals/model.js';

// ── Expose to HTML onclick handlers ──────────────────────────────────────────

window.selectNode      = selectNode;
window.refreshCurrent  = refreshCurrent;
window.callEndpoint    = callEndpoint;
window.switchTab       = switchTab;
window.runEp           = runEp;

window.closeModal      = closeModal;
window.submitModal     = submitModal;

window.openDeploy      = openDeploy;
window.closeDeploy     = closeDeploy;
window.dmModeChange    = dmModeChange;
window.submitDeploy    = submitDeploy;

window.openModelModal  = openModelModal;
window.closeModelModal = closeModelModal;
window.mmSwitchTab     = mmSwitchTab;
window.mmSelectDir     = mmSelectDir;
window.mmFileSelected  = mmFileSelected;
window.submitDownload  = submitDownload;
window.submitUpload    = submitUpload;

// ── Self update ───────────────────────────────────────────────────────────────

import { getCurrentHost } from './nodes.js';

async function doSelfUpdate(force = false) {
  const host = getCurrentHost();
  if (!host) return;
  if (force && !confirm('Force-update will run git reset --hard, discarding any local changes. Continue?')) return;
  const btn = document.getElementById(force ? 'btn-update-force' : 'btn-update');
  btn.disabled = true; btn.textContent = '⏳ Updating…';
  await callEndpoint(host, 'POST', '/self-update', JSON.stringify({ force }));
  btn.disabled = false; btn.textContent = force ? '⬆ Force-update' : '⬆ Self-update';
  setTimeout(() => refreshCurrent(), 4000);
}

window.doSelfUpdate = doSelfUpdate;

// ── Init ──────────────────────────────────────────────────────────────────────

initDropZone();
loadNodes();
