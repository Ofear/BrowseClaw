// BrowseClaw Settings Page

const defaults = {
  apiUrl: 'ws://127.0.0.1:18790',
  apiToken: '',
  model: 'openclaw',
  maxContext: 12000,
  theme: 'dark',
  includeContext: true
};

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.local.get('chromeclaw_settings');
  const settings = { ...defaults, ...stored.chromeclaw_settings };

  // Migrate old HTTP URLs to WebSocket
  if (settings.apiUrl.startsWith('http://')) {
    settings.apiUrl = settings.apiUrl.replace('http://', 'ws://');
  } else if (settings.apiUrl.startsWith('https://')) {
    settings.apiUrl = settings.apiUrl.replace('https://', 'wss://');
  }

  document.getElementById('api-url').value = settings.apiUrl;
  document.getElementById('api-token').value = settings.apiToken;
  document.getElementById('model').value = settings.model;
  document.getElementById('max-context').value = settings.maxContext;

  document.getElementById('btn-save').addEventListener('click', saveSettings);
  document.getElementById('btn-test').addEventListener('click', testConnection);
});

async function saveSettings() {
  const stored = await chrome.storage.local.get('chromeclaw_settings');
  const existing = { ...defaults, ...stored.chromeclaw_settings };

  const settings = {
    ...existing,
    apiUrl: document.getElementById('api-url').value.replace(/\/+$/, '') || defaults.apiUrl,
    apiToken: document.getElementById('api-token').value,
    model: document.getElementById('model').value || defaults.model,
    maxContext: parseInt(document.getElementById('max-context').value) || defaults.maxContext
  };

  await chrome.storage.local.set({ chromeclaw_settings: settings });
  showStatus('Settings saved successfully!', 'success');
}

async function testConnection() {
  showStatus('Testing WebSocket connection...', 'info');

  const url = document.getElementById('api-url').value.replace(/\/+$/, '') || defaults.apiUrl;
  const token = document.getElementById('api-token').value;

  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn(val);
      };

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        settle(reject, new Error(`Invalid WebSocket URL: ${err.message}`));
        return;
      }

      const timeout = setTimeout(() => {
        ws.close();
        settle(reject, new Error('Connection timed out'));
      }, 10000);

      ws.onopen = () => {};

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          // If we get a challenge, the gateway is alive
          if (msg.type === 'event' && msg.event === 'connect.challenge') {
            settle(resolve, { connected: true });
            ws.close();
            return;
          }
        } catch {
          settle(reject, new Error('Invalid response from gateway'));
          ws.close();
        }
      };

      ws.onerror = () => {
        settle(reject, new Error('WebSocket connection failed'));
      };

      ws.onclose = (event) => {
        settle(reject, new Error(`Connection closed (code: ${event.code})`));
      };
    });

    showStatus('Gateway is running! Configure device identity in the sidepanel settings.', 'success');
  } catch (err) {
    if (err.message.includes('timed out')) {
      showStatus('Connection timed out. Make sure OpenClaw is running (openclaw onboard --install-daemon)', 'error');
    } else if (err.message.includes('Authentication')) {
      showStatus('Authentication failed. Please check your API token.', 'error');
    } else {
      showStatus(`Cannot connect: ${err.message}. Is OpenClaw running?`, 'error');
    }
  }
}

function showStatus(text, type) {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = type;
  if (type === 'success') {
    setTimeout(() => { el.className = ''; }, 5000);
  }
}
