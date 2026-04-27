import { callEndpoint } from '../utils.js';

let _modalCb = null;

export function openModal(host, method, path) {
  document.getElementById('modal-title').textContent = `${method} ${path}`;
  document.getElementById('modal-path-preview').value = path;
  document.getElementById('modal-body').value = '{}';
  _modalCb = () => {
    const body = document.getElementById('modal-body').value.trim() || '{}';
    callEndpoint(host, method, path, body);
  };
  document.getElementById('modal').classList.add('open');
}

export function closeModal() {
  document.getElementById('modal').classList.remove('open');
}

export function submitModal() {
  closeModal();
  _modalCb?.();
}

document.getElementById('modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});
