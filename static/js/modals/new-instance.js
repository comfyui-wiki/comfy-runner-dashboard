// New instance flow.
//
// The runner has no dedicated "create install" endpoint — instead,
// POST /<name>/deploy auto-inits when no install record matches the
// given name. So we collect a name + variant (optional) + cuda_compat
// here and post a `latest` deploy: the runner downloads the standalone
// env, clones ComfyUI, registers the install, and immediately checks out
// the latest stable release. The Job log console streams progress.

import { callEndpoint, showResp } from '../utils.js';

let _niHost = null;

// Match the runner's safe_path_component check: alnum + dash + underscore,
// lowercase by convention. Reject empty / leading dot / path separators.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function openNewInstance(host) {
  _niHost = host;
  document.getElementById('ni-host').textContent = host;
  document.getElementById('ni-name').value = '';
  document.getElementById('ni-variant').value = '';
  document.getElementById('ni-variant-custom').value = '';
  document.getElementById('ni-variant-custom').style.display = 'none';
  document.getElementById('ni-cuda-compat').checked = false;
  document.getElementById('ni-start').checked = true;
  document.getElementById('new-instance-modal').classList.add('open');
  // Focus the name field so users can just start typing.
  setTimeout(() => document.getElementById('ni-name').focus(), 0);
}

export function closeNewInstance() {
  document.getElementById('new-instance-modal').classList.remove('open');
}

export function niVariantChange() {
  const v = document.getElementById('ni-variant').value;
  const custom = document.getElementById('ni-variant-custom');
  if (v === '__custom__') {
    custom.style.display = 'block';
    custom.focus();
  } else {
    custom.style.display = 'none';
  }
}

export function submitNewInstance() {
  if (!_niHost) return;

  const name = document.getElementById('ni-name').value.trim();
  if (!NAME_RE.test(name)) {
    showResp(
      `Invalid instance name: "${name}". Must start with a letter or digit and ` +
      `contain only lowercase letters, digits, dashes, and underscores.`,
      true,
    );
    return;
  }

  const variantSel = document.getElementById('ni-variant').value;
  let variant = '';
  if (variantSel === '__custom__') {
    variant = document.getElementById('ni-variant-custom').value.trim();
  } else if (variantSel) {
    variant = variantSel;
  }

  const cudaCompat = document.getElementById('ni-cuda-compat').checked;
  const start      = document.getElementById('ni-start').checked;

  // `latest` + auto-init: runner sees no existing record, runs
  // init_installation, then deploys the latest release (which is what
  // init would have checked out anyway). Single roundtrip, one job_id.
  const body = { latest: true, start };
  if (variant) body.variant = variant;
  if (cudaCompat) body.cuda_compat = true;

  closeNewInstance();
  callEndpoint(_niHost, 'POST', `/${name}/deploy`, JSON.stringify(body));
}

const _niOverlay = document.getElementById('new-instance-modal');
if (_niOverlay) {
  _niOverlay.addEventListener('click', e => {
    if (e.target === _niOverlay) closeNewInstance();
  });
}
