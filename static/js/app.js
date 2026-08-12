import { callEndpoint, toggleJobConsole, clearJobConsole } from './utils.js';
import { loadNodes, selectNode, refreshCurrent, setRunnersOnlyFilter } from './nodes.js';
import { switchTab, runEp } from './endpoints.js';
import { closeModal, submitModal } from './modals/generic.js';
import { closeDeploy, dmModeChange, submitDeploy, openDeploy } from './modals/deploy.js';
import { closeModelModal, mmSwitchTab, mmSelectDir, mmDirSelectChange, mmFileSelected, submitDownload, submitUpload, openModelModal, initDropZone, mmManageRefresh, mmManageDo, mmManageSelectFolder, mmDlAddEntry, mmDlRemoveEntry, mmDlDirChange } from './modals/model.js';
import { openLaunchArgs, closeLaunchArgs, submitLaunchArgs } from './modals/launch-args.js';
import { openNewInstance, closeNewInstance, submitNewInstance, niVariantChange } from './modals/new-instance.js';
import { openTunnel, closeTunnel, submitTunnelStart, submitTunnelStop } from './modals/tunnel.js';
import { openNgrokConfig, closeNgrokConfig, ngAddDomain, ngRemoveDomain, submitNgrokConfig } from './modals/ngrok-config.js';
import {
  openCustomNodes, closeCustomNodes, submitCustomNodeAdd, cnRefresh, cnNodeAction,
} from './modals/custom-nodes.js';
import {
  loadPodsSidebar, selectPod, podStart, podStop, podTerminate, podManage,
} from './pods.js';
import {
  openStockPage, selectStockGpu, selectStockDc, createPodFromStock,
} from './stock.js';

// ── Expose to HTML onclick handlers ──────────────────────────────────────────

window.selectNode      = selectNode;
window.refreshCurrent  = refreshCurrent;
window.setRunnersOnlyFilter = setRunnersOnlyFilter;
window.callEndpoint    = callEndpoint;
window.switchTab       = switchTab;
window.runEp           = runEp;

window.loadPodsSidebar = loadPodsSidebar;
window.selectPod       = selectPod;
window.podStart        = podStart;
window.podStop         = podStop;
window.podTerminate    = podTerminate;
window.podManage       = podManage;
window.openStockPage   = openStockPage;
window.selectStockGpu  = selectStockGpu;
window.selectStockDc   = selectStockDc;
window.createPodFromStock = createPodFromStock;

window.closeModal      = closeModal;
window.submitModal     = submitModal;

window.openDeploy      = openDeploy;
window.closeDeploy     = closeDeploy;
window.dmModeChange    = dmModeChange;
window.submitDeploy    = submitDeploy;

window.openModelModal  = openModelModal;
window.closeModelModal = closeModelModal;
window.mmSwitchTab        = mmSwitchTab;
window.mmSelectDir        = mmSelectDir;
window.mmDirSelectChange  = mmDirSelectChange;
window.mmFileSelected     = mmFileSelected;
window.submitDownload  = submitDownload;
window.submitUpload    = submitUpload;
window.mmDlAddEntry    = mmDlAddEntry;
window.mmDlRemoveEntry = mmDlRemoveEntry;
window.mmDlDirChange   = mmDlDirChange;
window.mmManageRefresh      = mmManageRefresh;
window.mmManageDo           = mmManageDo;
window.mmManageSelectFolder = mmManageSelectFolder;

window.openLaunchArgs  = openLaunchArgs;
window.closeLaunchArgs = closeLaunchArgs;
window.submitLaunchArgs = submitLaunchArgs;

window.openNewInstance    = openNewInstance;
window.closeNewInstance   = closeNewInstance;
window.submitNewInstance  = submitNewInstance;
window.niVariantChange    = niVariantChange;

window.openTunnel         = openTunnel;
window.closeTunnel        = closeTunnel;
window.submitTunnelStart  = submitTunnelStart;
window.submitTunnelStop   = submitTunnelStop;

window.openNgrokConfig    = openNgrokConfig;
window.closeNgrokConfig   = closeNgrokConfig;
window.ngAddDomain        = ngAddDomain;
window.ngRemoveDomain     = ngRemoveDomain;
window.submitNgrokConfig  = submitNgrokConfig;

window.openCustomNodes     = openCustomNodes;
window.closeCustomNodes    = closeCustomNodes;
window.submitCustomNodeAdd = submitCustomNodeAdd;
window.cnRefresh           = cnRefresh;
window.cnNodeAction        = cnNodeAction;

window.toggleJobConsole = toggleJobConsole;
window.clearJobConsole  = clearJobConsole;

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

// ── Instance card ⋮ menu ────────────────────────────────────────────────────

function closeInstMenus() {
  document.querySelectorAll('.inst-more-menu.open').forEach(m => m.classList.remove('open'));
  // Drop the z-index lift on every card so a closed menu can't keep its
  // host card hovering above its neighbours.
  document.querySelectorAll('.instance-card.has-menu-open').forEach(c => c.classList.remove('has-menu-open'));
}

function toggleInstMenu(event, instName) {
  event.stopPropagation();
  const id = `inst-more-menu-${instName}`;
  const menu = document.getElementById(id);
  if (!menu) return;
  // Close any other open menus first so only one is visible at a time.
  document.querySelectorAll('.inst-more-menu.open').forEach(m => {
    if (m !== menu) m.classList.remove('open');
  });
  document.querySelectorAll('.instance-card.has-menu-open').forEach(c => {
    if (!c.contains(menu)) c.classList.remove('has-menu-open');
  });
  const opened = menu.classList.toggle('open');
  // Mark the host card so its stacking context lifts above sibling cards;
  // otherwise the next card in DOM order would clip the popover.
  const card = menu.closest('.instance-card');
  if (card) card.classList.toggle('has-menu-open', opened);
}

// Two-step confirmation for destructive delete — calls DELETE /<name> which
// removes the install record + on-disk files on the runner. Irreversible.
function confirmDeleteInstance(host, name) {
  closeInstMenus();
  const typed = prompt(
    `This will permanently delete the "${name}" instance and all its files on the runner.\n\n` +
    `Type the instance name to confirm:`,
  );
  if (typed !== name) {
    if (typed != null) alert('Name did not match — delete cancelled.');
    return;
  }
  callEndpoint(host, 'DELETE', `/${name}`);
  // Refresh shortly after; the DELETE is sync but we let the runner settle.
  setTimeout(() => refreshCurrent(), 1500);
}

window.toggleInstMenu        = toggleInstMenu;
window.closeInstMenus        = closeInstMenus;
window.confirmDeleteInstance = confirmDeleteInstance;

// Dismiss any open ⋮ menu on outside click.
document.addEventListener('click', e => {
  if (!e.target.closest('.inst-more-menu') && !e.target.closest('.inst-more-btn')) {
    closeInstMenus();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

initDropZone();
loadNodes();
loadPodsSidebar();
