const DEFAULT_API_BASE = 'https://api.getmocho.com/v1';

const $ = (id) => document.getElementById(id);

async function loadSettings() {
  const data = await chrome.storage.sync.get(['apiKey', 'apiBase']);
  if (data.apiKey) $('apiKey').value = data.apiKey;
  if (data.apiBase) $('apiBase').value = data.apiBase;
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
  const apiBase = $('apiBase').value.trim();

  if (!apiKey) {
    showStatus('Enter an API key to save.', 'warning');
    return;
  }

  await chrome.storage.sync.set({ apiKey, apiBase });
  showStatus('Settings saved.', 'success');
  setTimeout(clearStatus, 3000);
}

async function testConnection() {
  const apiKey = $('apiKey').value.trim();
  const apiBase = ($('apiBase').value.trim() || DEFAULT_API_BASE).replace(/\/$/, '');

  if (!apiKey) {
    showStatus('Enter an API key first.', 'warning');
    return;
  }

  const btn = $('testBtn');
  btn.disabled = true;
  btn.textContent = 'Testing…';
  clearStatus();

  try {
    const res = await fetch(`${apiBase}/auth/me`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });

    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      const name = json.name || json.email || 'your account';
      showStatus(`Connected — logged in as ${name}.`, 'success');
    } else if (res.status === 401) {
      showStatus('Invalid API key. Check your MOCHO account settings.', 'error');
    } else {
      showStatus(`Server returned ${res.status}. Check the API base URL.`, 'error');
    }
  } catch (err) {
    showStatus(`Connection failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test Connection';
  }
}

// Toggle API key visibility
$('toggleVisibility').addEventListener('click', () => {
  const input = $('apiKey');
  input.type = input.type === 'password' ? 'text' : 'password';
});

$('saveBtn').addEventListener('click', saveSettings);
$('testBtn').addEventListener('click', testConnection);

loadSettings();
