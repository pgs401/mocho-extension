import { verifyConnection } from '../lib/mochoApi.js';

const $ = (id) => document.getElementById(id);

async function loadSettings() {
  const data = await chrome.storage.sync.get(['apiKey']);
  if (data.apiKey) $('apiKey').value = data.apiKey;
}

function showStatus(msg, type) {
  const bar = $('statusBar');
  bar.textContent = msg;
  bar.className = `status-bar ${type}`;
}

function clearStatus() {
  $('statusBar').className = 'status-bar';
  $('statusBar').textContent = '';
}

async function saveSettings() {
  const apiKey = $('apiKey').value.trim();

  if (!apiKey) {
    showStatus('Enter an API key to save.', 'warning');
    return;
  }

  await chrome.storage.sync.set({ apiKey });
  showStatus('Settings saved.', 'success');
  setTimeout(clearStatus, 3000);
}

async function testConnection() {
  const apiKey = $('apiKey').value.trim();

  if (!apiKey) {
    showStatus('Enter an API key first.', 'warning');
    return;
  }

  // Save temporarily so apiFetch can read it
  await chrome.storage.sync.set({ apiKey });

  const btn = $('testBtn');
  btn.disabled = true;
  btn.textContent = 'Testing…';
  clearStatus();

  const result = await verifyConnection();

  if (result.ok) {
    const { name, email, plan } = result.data.user || {};
    const label = name || email || 'your account';
    showStatus(`Connected as ${label}${plan ? ` (${plan} plan)` : ''}.`, 'success');
  } else {
    showStatus(result.error, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Test Connection';
}

$('toggleVisibility').addEventListener('click', () => {
  const input = $('apiKey');
  input.type = input.type === 'password' ? 'text' : 'password';
});

$('saveBtn').addEventListener('click', saveSettings);
$('testBtn').addEventListener('click', testConnection);

loadSettings();
