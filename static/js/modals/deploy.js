import { callEndpoint } from '../utils.js';

let _deployHost = null;
let _deployPath = null;

const DM_INPUTS = {
  branch: { label: 'Branch name',  placeholder: 'e.g. master' },
  tag:    { label: 'Tag / version', placeholder: 'e.g. v0.3.27' },
  commit: { label: 'Commit SHA',    placeholder: 'e.g. a1b2c3d' },
  pr:     { label: 'PR number',     placeholder: 'e.g. 1234' },
};

export function openDeploy(host, path, instName) {
  _deployHost = host;
  _deployPath = path;
  document.getElementById('dm-instance').textContent = instName || '(default)';
  document.querySelector('input[name="dm-mode"][value="latest"]').checked = true;
  document.getElementById('dm-force').checked = false;
  dmModeChange();
  document.getElementById('deploy-modal').classList.add('open');
}

export function closeDeploy() {
  document.getElementById('deploy-modal').classList.remove('open');
}

export function dmModeChange() {
  const mode = document.querySelector('input[name="dm-mode"]:checked')?.value;
  const inputRow = document.getElementById('dm-input-row');
  const cfg = DM_INPUTS[mode];
  if (cfg) {
    document.getElementById('dm-input-label').textContent = cfg.label;
    document.getElementById('dm-input-val').placeholder = cfg.placeholder;
    document.getElementById('dm-input-val').value = '';
    inputRow.style.display = 'block';
  } else {
    inputRow.style.display = 'none';
  }
}

export function submitDeploy() {
  const mode  = document.querySelector('input[name="dm-mode"]:checked')?.value;
  const val   = document.getElementById('dm-input-val').value.trim();
  const start = document.getElementById('dm-start').checked;
  const force = document.getElementById('dm-force').checked;

  const body = { start };
  if (force) body.force = true;
  if      (mode === 'latest') body.latest = true;
  else if (mode === 'pull')   body.pull   = true;
  else if (mode === 'reset')  body.reset  = true;
  else if (mode === 'branch') body.branch = val || 'master';
  else if (mode === 'tag')    body.tag    = val;
  else if (mode === 'commit') body.commit = val;
  else if (mode === 'pr')     body.pr     = parseInt(val) || 0;

  closeDeploy();
  callEndpoint(_deployHost, 'POST', _deployPath, JSON.stringify(body));
}

document.getElementById('deploy-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeDeploy();
});
