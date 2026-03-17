// BrowseClaw Side Panel — Main Application Logic
// Handles chat UI, OpenClaw WebSocket communication, and streaming responses

// ─── State ──────────────────────────────────────────────────────────────────────
let conversationHistory = [];
let isGenerating = false;
let openclawClient = null;
let pendingImageAttachment = null; // {dataUrl, base64, mimeType} from paste
let currentSessionKey = 'chromeclaw-' + Date.now(); // unique per chat session, reset on clear
let currentSessionId = 'session-' + Date.now();    // storage key in chromeclaw_sessions
let visionMessageCount = 0; // track how many vision messages sent in current server session
const VISION_SESSION_ROTATE_AFTER = 5; // rotate session key after this many vision screenshots
const VISION_REMIND_AFTER = 3;         // show "turn off vision" reminder after this many vision messages
let visionReminderShown = false;
const modelContextWindowMap = {};      // model id → context window in chars (populated from models.list)
let modelContextWindow = null;         // context window of currently selected model (null = unknown)
let settings = {
  apiUrl: 'ws://127.0.0.1:18790',
  apiToken: '',
  model: 'openclaw',
  maxContext: 12000,
  theme: 'dark',
  includeContext: true,
  includeVision: false,
  debugMode: false,
  debugDelay: 500,
  debugStepByStep: false
};

let _stepContinueResolve = null;

// ─── System Prompt (injected as message prefix) ─────────────────────────────────
const SYSTEM_PROMPT = `You are BrowseClaw, an AI assistant embedded in a Chrome browser extension. You can SEE and INTERACT with the user's current webpage.

CAPABILITIES:
- Read page content, metadata, and structure (provided as context)
- When a screenshot is attached, you can visually see the page exactly as the user sees it
- You can INTERACT with the page using ACTION commands (see below)
- Help summarize, extract data, explain, and answer questions

PAGE ACTIONS — You can perform actions on the user's page by including action blocks in your response:
\`\`\`action
{"action": "click", "selector": "button.submit"}
\`\`\`
\`\`\`action
{"action": "fill", "selector": "#email", "value": "user@example.com"}
\`\`\`
\`\`\`action
{"action": "click_text", "text": "Sign In"}
\`\`\`
\`\`\`action
{"action": "select", "selector": "select#country", "value": "US"}
\`\`\`
\`\`\`action
{"action": "scroll", "direction": "down"}
\`\`\`
\`\`\`action
{"action": "type", "selector": "textarea", "value": "Hello world"}
\`\`\`

Available actions:
- click: Click an element by CSS selector
- click_text: Click an element by its visible text content
- double_click: Double-click an element
- right_click: Right-click an element (opens context menu)
- hover: Hover over an element (triggers tooltips, dropdowns)
- fill: Fill an input/textarea with a value (clears first). Also works with contenteditable elements (WhatsApp, Slack, etc.)
- type: Type text into an element. Works with contenteditable divs and rich text editors.
- select: Select a dropdown option
- scroll: Scroll the page (direction: up/down/top/bottom)
- check: Check/uncheck a checkbox (add "checked": true/false)
- submit: Submit a form by selector
- press_key: Press a key (add "key": "Enter", "Tab", "Escape", "ArrowDown", etc.)
- highlight: Highlight elements (add "color": "orange")
- get_rect: Get the bounding rect (top/left/width/height) of an element — use this to compute drag coordinates
- drag: Drag from one point to another. Use viewport coordinates (fromX/fromY/toX/toY). If "selector" is given, coordinates are relative to that element's top-left corner. Use "steps" (default 20) for smoother paths.

DRAWING / CANVAS WORKFLOW:
1. Use get_rect on the canvas to get its position
2. Use drag with fromX/fromY/toX/toY to draw lines/shapes
3. Use click to select tools (pencil, brush, shape tools)
4. Example — draw a line on a canvas at position {top:200, left:0}:
\`\`\`action
{"action":"drag","selector":"canvas","fromX":50,"fromY":50,"toX":200,"toY":200}
\`\`\`

GUIDELINES:
1. Be concise. Get straight to the point.
2. When you have a screenshot, USE it to understand the page layout and identify elements.
3. When performing actions, describe what you're doing briefly, then include the action block.
4. After an action, you'll receive a follow-up with the result and a new screenshot (if vision is on).
5. If a selector doesn't work, try click_text or a different selector.
6. For forms, scan the fields first (from the screenshot or page context), then fill them.
7. You can chain multiple actions in one response — they execute in order.
8. CRITICAL — STAY IN CONTEXT: The page context includes a "Currently focused element" line. If the user asks you to type or send a message, use the CURRENTLY FOCUSED/ACTIVE element. DO NOT click on other contacts, channels, or items to navigate away unless the user explicitly asks you to switch. For chat apps (WhatsApp, Telegram, Slack, Discord): type into the active chat's input box using its selector, do NOT click on the contacts list.`;

// ─── OpenClaw WebSocket Client ──────────────────────────────────────────────────
// ─── Device Identity Helpers (Ed25519 signing via Web Crypto) ────────────────
// Reads device identity from ~/.openclaw/identity/ stored in chrome.storage.local
async function loadDeviceIdentity() {
  const stored = await chrome.storage.local.get('chromeclaw_device');
  return stored.chromeclaw_device || null;
}

async function saveDeviceIdentity(identity) {
  await chrome.storage.local.set({ chromeclaw_device: identity });
}

// Import Ed25519 private key PEM into Web Crypto
async function importEd25519PrivateKey(pem) {
  // Strip PEM header/footer and decode base64
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
}

// Extract raw 32-byte public key from PEM and base64url encode it
function publicKeyPemToB64Url(pem) {
  const b64 = pem.replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s/g, '');
  const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  // Ed25519 SPKI is 44 bytes: 12-byte header + 32-byte raw key
  const rawKey = der.slice(der.length - 32);
  // Base64url encode
  let b64url = btoa(String.fromCharCode(...rawKey));
  return b64url.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// Sign the V2 device auth payload
async function signDevicePayload(privateKey, payload) {
  const data = new TextEncoder().encode(payload);
  const sig = await crypto.subtle.sign('Ed25519', privateKey, data);
  let b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

class OpenClawClient {
  constructor() {
    this.ws = null;
    this.pending = new Map(); // id → {resolve, reject}
    this.nextId = 1;
    this.onEvent = null; // callback for events
    this._connectPromise = null;
    this._deviceIdentity = null;
  }

  async connect(url, token) {
    if (this._connectPromise) return this._connectPromise;

    // Load device identity
    this._deviceIdentity = await loadDeviceIdentity();
    if (!this._deviceIdentity) {
      throw new Error('Device identity not configured. Go to Settings and click "Load Device Identity".');
    }

    console.log('[OpenClaw] Connecting to gateway:', url, 'device:', this._deviceIdentity.deviceId?.substring(0, 8) + '...');

    this._connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this._connectPromise = null;
        fn(val);
      };

      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        settle(reject, new Error(`Invalid WebSocket URL: ${err.message}`));
        return;
      }

      const timeout = setTimeout(() => {
        this.ws.close();
        settle(reject, new Error('Connection timed out'));
      }, 10000);

      this.ws.onopen = () => {
        console.log('[OpenClaw] WebSocket opened, waiting for challenge...');
      };

      this.ws.onmessage = async (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          console.warn('[OpenClaw] Non-JSON message:', event.data);
          return;
        }
        console.log('[OpenClaw] ←', msg.type, msg.method || msg.event || '', msg);

        // Challenge-response with device identity
        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          try {
            const nonce = msg.payload.nonce;
            const signedAt = Date.now();
            const di = this._deviceIdentity;
            const scopes = ['operator.admin', 'operator.approvals', 'operator.pairing', 'operator.read', 'operator.write'];

            // Build V2 signing payload: v2|deviceId|clientId|mode|role|scopes|signedAt|token|nonce
            const payloadStr = ['v2', di.deviceId, 'cli', 'cli', 'operator', scopes.join(','), String(signedAt), di.deviceToken, nonce].join('|');

            // Sign with Ed25519
            const privateKey = await importEd25519PrivateKey(di.privateKeyPem);
            const signature = await signDevicePayload(privateKey, payloadStr);
            const publicKeyB64Url = publicKeyPemToB64Url(di.publicKeyPem);

            const connectId = `chromeclaw-${Date.now()}`;
            const connectReq = {
              type: 'req',
              id: connectId,
              method: 'connect',
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: { id: 'cli', version: '1.0.0', platform: 'win32', mode: 'cli' },
                role: 'operator',
                scopes,
                caps: ['tool-events'],
                auth: { deviceToken: di.deviceToken },
                device: { id: di.deviceId, publicKey: publicKeyB64Url, signature, signedAt, nonce }
              }
            };
            console.log('[OpenClaw] → connect (with device identity)');
            this.pending.set(connectId, {
              resolve: (result) => settle(resolve, result),
              reject: (err) => settle(reject, err)
            });
            this.ws.send(JSON.stringify(connectReq));
          } catch (err) {
            settle(reject, new Error(`Device signing failed: ${err.message}`));
          }
          return;
        }

        // All other messages (responses, events)
        this._handleMessage(msg);
      };

      this.ws.onerror = () => {
        settle(reject, new Error('WebSocket connection failed. Is OpenClaw running?'));
      };

      this.ws.onclose = (event) => {
        for (const [id, handler] of this.pending) {
          handler.reject(new Error('Connection closed'));
        }
        this.pending.clear();
        settle(reject, new Error(`Connection closed (code: ${event.code})`));
      };
    });

    return this._connectPromise;
  }

  // Accepts a pre-parsed message object or raw string
  _handleMessage(msgOrData) {
    let msg;
    if (typeof msgOrData === 'string') {
      try {
        msg = JSON.parse(msgOrData);
      } catch {
        return;
      }
      console.log('[OpenClaw] ←', msg.type, msg.method || msg.event || '', msg);
    } else {
      msg = msgOrData;
    }

    if (msg.type === 'res' && msg.id != null) {
      const handler = this.pending.get(msg.id);
      if (handler) {
        this.pending.delete(msg.id);
        if (msg.error || msg.ok === false) {
          const errMsg = msg.error?.message || msg.error || 'Request failed';
          handler.reject(new Error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg)));
        } else {
          handler.resolve(msg.result);
        }
      }
    } else if (msg.type === 'event') {
      if (this.onEvent) {
        this.onEvent(msg.event, msg.payload);
      }
    }
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }

      const id = `chromeclaw-${method}-${this.nextId++}`;
      const msg = { type: 'req', id, method, params };

      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));

      // Timeout for requests (30s)
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.pending.clear();
    this._connectPromise = null;
  }

  get connected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

// ─── Initialization ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  applyTheme();
  setupEventListeners();
  checkConnection();
  restoreChat();

  // Auto-resize textarea
  const input = document.getElementById('user-input');
  input.addEventListener('input', autoResizeInput);

  // Paste image support
  input.addEventListener('paste', handleImagePaste);
});

async function loadSettings() {
  const stored = await chrome.storage.local.get('chromeclaw_settings');
  if (stored.chromeclaw_settings) {
    settings = { ...settings, ...stored.chromeclaw_settings };
  }
  // Migrate old HTTP URLs to WebSocket
  if (settings.apiUrl.startsWith('http://')) {
    settings.apiUrl = settings.apiUrl.replace('http://', 'ws://');
  } else if (settings.apiUrl.startsWith('https://')) {
    settings.apiUrl = settings.apiUrl.replace('https://', 'wss://');
  }
  document.getElementById('include-context').checked = settings.includeContext;
  document.getElementById('include-vision').checked = settings.includeVision;
  populateSettingsForm();
}

async function saveSettings() {
  await chrome.storage.local.set({ chromeclaw_settings: settings });
}

function populateSettingsForm() {
  document.getElementById('setting-api-url').value = settings.apiUrl;
  document.getElementById('setting-api-token').value = settings.apiToken;
  document.getElementById('setting-model').value = settings.model;
  document.getElementById('setting-max-context').value = settings.maxContext;

  // Set the model dropdown if the current value matches
  const modelSelect = document.getElementById('setting-model-select');
  modelSelect.value = settings.model;
  if (!modelSelect.value && settings.model) {
    modelSelect.parentElement.classList.add('custom-mode');
  } else {
    modelSelect.parentElement.classList.remove('custom-mode');
  }

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === settings.theme);
  });

  const debugMode = document.getElementById('setting-debug-mode');
  const debugExtra = document.getElementById('debug-extra');
  if (debugMode) {
    debugMode.checked = !!settings.debugMode;
    debugExtra.classList.toggle('hidden', !settings.debugMode);
    document.getElementById('setting-debug-delay').value = settings.debugDelay ?? 500;
    document.getElementById('setting-debug-step').checked = !!settings.debugStepByStep;
  }
}

// ─── Event Listeners ────────────────────────────────────────────────────────────
function setupEventListeners() {
  const input = document.getElementById('user-input');
  const btnSend = document.getElementById('btn-send');
  const btnStop = document.getElementById('btn-stop');
  const btnSettings = document.getElementById('btn-settings');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const btnSaveSettings = document.getElementById('btn-save-settings');
  const btnTestConnection = document.getElementById('btn-test-connection');
  const toggleTokenVis = document.getElementById('toggle-token-vis');
  const contextToggle = document.getElementById('include-context');

  // Send message
  btnSend.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Stop generation
  btnStop.addEventListener('click', stopGeneration);

  // New session (header button)
  document.getElementById('btn-new-session-header').addEventListener('click', startNewSession);

  // Settings panel
  btnSettings.addEventListener('click', () => {
    document.getElementById('settings-panel').classList.toggle('hidden');
    document.getElementById('sessions-panel').classList.add('hidden');
    populateSettingsForm();
  });
  btnCloseSettings.addEventListener('click', () => {
    document.getElementById('settings-panel').classList.add('hidden');
  });

  // Sessions panel
  document.getElementById('btn-sessions').addEventListener('click', () => {
    const panel = document.getElementById('sessions-panel');
    panel.classList.toggle('hidden');
    document.getElementById('settings-panel').classList.add('hidden');
    if (!panel.classList.contains('hidden')) renderSessionsList();
  });
  document.getElementById('btn-close-sessions').addEventListener('click', closeSessions);
  document.getElementById('btn-new-session').addEventListener('click', startNewSession);

  // Save settings
  btnSaveSettings.addEventListener('click', async () => {
    settings.apiUrl = document.getElementById('setting-api-url').value.replace(/\/+$/, '') || 'ws://127.0.0.1:18790';
    settings.apiToken = document.getElementById('setting-api-token').value;
    settings.model = document.getElementById('setting-model').value || 'openclaw';
    settings.maxContext = parseInt(document.getElementById('setting-max-context').value) || 12000;
    settings.debugMode = document.getElementById('setting-debug-mode').checked;
    settings.debugDelay = parseInt(document.getElementById('setting-debug-delay').value) || 0;
    settings.debugStepByStep = document.getElementById('setting-debug-step').checked;
    await saveSettings();
    updateModelContextWindow();
    showSettingsStatus('Settings saved!', 'success');
    // Reconnect with new settings
    if (openclawClient) {
      openclawClient.disconnect();
      openclawClient = null;
    }
    checkConnection();
  });

  // Test connection
  btnTestConnection.addEventListener('click', testConnection);

  // Token visibility toggle
  toggleTokenVis.addEventListener('click', () => {
    const tokenInput = document.getElementById('setting-api-token');
    tokenInput.type = tokenInput.type === 'password' ? 'text' : 'password';
  });

  // Context toggle
  contextToggle.addEventListener('change', (e) => {
    settings.includeContext = e.target.checked;
    saveSettings();
  });

  // Vision toggle
  const visionToggle = document.getElementById('include-vision');
  visionToggle.addEventListener('change', (e) => {
    settings.includeVision = e.target.checked;
    if (!e.target.checked) visionReminderShown = false; // reset so reminder can show again next time
    saveSettings();
  });

  // Theme buttons
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      settings.theme = btn.dataset.theme;
      applyTheme();
      saveSettings();
    });
  });

  // Quick action buttons
  document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const prompt = btn.dataset.prompt;
      const forceVision = btn.dataset.vision === 'true';
      document.getElementById('user-input').value = prompt;
      sendMessage(forceVision);
    });
  });

  // Collapsible action block toggles (event delegation)
  document.getElementById('messages').addEventListener('click', (e) => {
    const toggle = e.target.closest('.actions-toggle');
    if (toggle) toggle.parentElement.classList.toggle('open');
  });

  document.getElementById('btn-step-continue').addEventListener('click', () => {
    if (_stepContinueResolve) {
      _stepContinueResolve();
      _stepContinueResolve = null;
    }
    document.getElementById('btn-step-continue').classList.add('hidden');
  });

  // Debug mode settings
  const debugModeToggle = document.getElementById('setting-debug-mode');
  const debugExtra = document.getElementById('debug-extra');
  debugModeToggle.addEventListener('change', () => {
    debugExtra.classList.toggle('hidden', !debugModeToggle.checked);
  });

  // Device identity loader
  document.getElementById('btn-load-device').addEventListener('click', loadDeviceIdentityFromFiles);
  updateDeviceStatus();

  // Model selector
  document.getElementById('btn-fetch-models').addEventListener('click', fetchAvailableModels);
  const modelSelect = document.getElementById('setting-model-select');
  const modelInput = document.getElementById('setting-model');
  modelSelect.addEventListener('change', () => {
    const val = modelSelect.value;
    if (val === '__custom__') {
      modelSelect.parentElement.classList.add('custom-mode');
      modelInput.value = '';
      modelInput.focus();
    } else if (val) {
      modelInput.value = val;
    }
  });
  modelInput.addEventListener('dblclick', () => {
    modelSelect.parentElement.classList.remove('custom-mode');
  });
}

// ─── Theme ──────────────────────────────────────────────────────────────────────
function applyTheme() {
  const theme = settings.theme;
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.body.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    document.body.setAttribute('data-theme', theme);
  }
}

// ─── Connection Management ──────────────────────────────────────────────────────
async function ensureConnected() {
  if (openclawClient && openclawClient.connected) return openclawClient;

  // Disconnect old client if exists
  if (openclawClient) {
    openclawClient.disconnect();
  }

  openclawClient = new OpenClawClient();
  await openclawClient.connect(settings.apiUrl, settings.apiToken);
  return openclawClient;
}

async function checkConnection() {
  const indicator = document.getElementById('status-indicator');
  const statusText = indicator.querySelector('.status-text');

  try {
    const client = await ensureConnected();
    // Try a health check
    try {
      await client.request('health');
    } catch {
      // health method may not exist, but if we're connected that's fine
    }
    indicator.className = 'status connected';
    statusText.textContent = 'Connected';
  } catch (err) {
    indicator.className = 'status disconnected';
    statusText.textContent = 'Offline';
    openclawClient = null;
  }
}

async function testConnection() {
  showSettingsStatus('Testing connection...', 'info');

  const url = document.getElementById('setting-api-url').value.replace(/\/+$/, '') || 'ws://127.0.0.1:18790';
  const token = document.getElementById('setting-api-token').value;

  const testClient = new OpenClawClient();
  try {
    const result = await testClient.connect(url, token);
    showSettingsStatus(`Connected! Protocol handshake successful.`, 'success');
    testClient.disconnect();
  } catch (err) {
    if (err.message.includes('timed out')) {
      showSettingsStatus('Connection timed out — is OpenClaw running?', 'error');
    } else {
      showSettingsStatus(`Cannot connect: ${err.message}`, 'error');
    }
    testClient.disconnect();
  }
}

function showSettingsStatus(text, type) {
  const el = document.getElementById('settings-status');
  el.textContent = text;
  el.className = `settings-status ${type}`;
  el.classList.remove('hidden');
  if (type === 'success') {
    setTimeout(() => el.classList.add('hidden'), 3000);
  }
}

// ─── Chat Persistence ───────────────────────────────────────────────────────────
// Extract text from content that may be a string or array of {type, text} objects
function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(part => part && part.type === 'text' && part.text)
      .map(part => part.text)
      .join('');
  }
  if (content && typeof content === 'object' && content.text) return content.text;
  return String(content || '');
}

async function saveChat() {
  const toSave = conversationHistory.slice(-50);
  await chrome.storage.local.set({ chromeclaw_chat: toSave });
  updateContextMeter();
}

function updateModelContextWindow() {
  modelContextWindow = modelContextWindowMap[settings.model] || null;
  updateContextMeter();
}

function updateContextMeter() {
  const meter = document.getElementById('context-meter');
  const label = document.getElementById('ctx-label');
  if (!meter || !label) return;

  const msgs = conversationHistory.filter(m => m.role === 'user' || m.role === 'assistant');
  const userCount = msgs.filter(m => m.role === 'user').length;

  // Raw history chars
  const historyChars = msgs.reduce((sum, m) => {
    const t = m.role === 'user' ? (m.text || '') : extractTextContent(m.content || '');
    return sum + t.length;
  }, 0);

  // Estimate page context contribution (injected per user message)
  const pageCtxPerMsg = settings.includeContext ? Math.min(settings.maxContext || 12000, 12000) : 0;
  const totalEstimate = historyChars + userCount * pageCtxPerMsg;
  const kChars = Math.round(totalEstimate / 1000);

  let level = 'safe';
  let labelText, hintLine;

  if (modelContextWindow) {
    const pct = Math.round(totalEstimate / modelContextWindow * 100);
    const maxLabel = modelContextWindow >= 4000000 ? `${Math.round(modelContextWindow / 4000000)}M`
      : modelContextWindow >= 1000000 ? `${(modelContextWindow / 1000000).toFixed(1)}M`
      : `${Math.round(modelContextWindow / 1000)}k`;
    level = pct >= 85 ? 'danger' : pct >= 55 ? 'warn' : 'safe';
    labelText = `${userCount} msgs · ${pct}% of ${maxLabel}`;
    hintLine = pct >= 85
      ? '⚠️ Context nearly full — start a new session soon'
      : pct >= 55
      ? '⚠️ Context over half full — consider a new session'
      : 'Context is fine';
  } else {
    // No context window info — fall back to message count heuristics
    level = userCount >= 20 ? 'danger' : userCount >= 10 ? 'warn' : 'safe';
    labelText = `${userCount} msgs · ~${kChars}k`;
    hintLine = level === 'danger'
      ? '⚠️ Context is large — consider starting a new session'
      : level === 'warn'
      ? '⚠️ Context growing — new session soon recommended'
      : 'Context size unknown (fetch models to get limit)';
  }

  label.textContent = labelText;
  meter.dataset.level = level;
  meter.title = `~${kChars}k chars estimated (${historyChars} in history + ~${Math.round(userCount * pageCtxPerMsg / 1000)}k page ctx)\n${modelContextWindow ? `Model context window: ${Math.round(modelContextWindow / 4)}k tokens\n` : 'Model context window: unknown — fetch models in settings\n'}${hintLine}`;
}

async function restoreChat() {
  // Restore the session ID from last time so we stay in the same session
  const meta = await chrome.storage.local.get('chromeclaw_current_session_id');
  if (meta.chromeclaw_current_session_id) {
    currentSessionId = meta.chromeclaw_current_session_id;
    currentSessionKey = 'chromeclaw-' + currentSessionId;
  }

  const stored = await chrome.storage.local.get('chromeclaw_chat');
  if (stored.chromeclaw_chat && stored.chromeclaw_chat.length > 0) {
    conversationHistory = stored.chromeclaw_chat;
    conversationHistory.forEach((msg, idx) => {
      if (msg.type === 'action_result') {
        addActionResultBubble(msg.results);
      } else if (msg.role === 'user') {
        if (msg.text === '[action results]') return; // migrate old stored entries
        addMessageBubble('user', msg.text || '', idx);
      } else if (msg.role === 'assistant' && msg.content) {
        const displayContent = extractTextContent(msg.content);
        if (displayContent) addMessageBubble('assistant', displayContent);
      }
    });
  }
  updateContextMeter();
}

// ─── Session Management ─────────────────────────────────────────────────────────
async function loadAllSessions() {
  const stored = await chrome.storage.local.get('chromeclaw_sessions');
  return stored.chromeclaw_sessions || {};
}

async function saveCurrentSession() {
  if (conversationHistory.length === 0) return;
  const sessions = await loadAllSessions();
  const existing = sessions[currentSessionId];
  const firstUserMsg = conversationHistory.find(m => m.role === 'user' && m.text && m.text !== '[action results]');
  const name = firstUserMsg ? firstUserMsg.text.substring(0, 48) : 'Untitled';
  sessions[currentSessionId] = {
    id: currentSessionId,
    name,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
    history: conversationHistory.slice(-50)
  };
  await chrome.storage.local.set({
    chromeclaw_sessions: sessions,
    chromeclaw_current_session_id: currentSessionId
  });
}

async function switchToSession(sessionId) {
  const sessions = await loadAllSessions();
  const session = sessions[sessionId];
  if (!session) return;
  await saveCurrentSession();
  currentSessionId = session.id;
  currentSessionKey = 'chromeclaw-' + session.id;
  conversationHistory = session.history || [];
  const messages = document.getElementById('messages');
  messages.innerHTML = '';
  conversationHistory.forEach((msg, idx) => {
    if (msg.isInternal) return;
    if (msg.type === 'action_result') {
      addActionResultBubble(msg.results);
    } else if (msg.role === 'user') {
      if (msg.text === '[action results]') return;
      addMessageBubble('user', msg.text || '', idx);
    } else if (msg.role === 'assistant' && msg.content) {
      const displayContent = extractTextContent(msg.content);
      if (displayContent) addMessageBubble('assistant', displayContent);
    }
  });
  updateContextMeter();
  closeSessions();
}

async function deleteSession(sessionId) {
  const sessions = await loadAllSessions();
  delete sessions[sessionId];
  await chrome.storage.local.set({ chromeclaw_sessions: sessions });
}

async function startNewSession() {
  await saveCurrentSession();
  currentSessionId = 'session-' + Date.now();
  currentSessionKey = 'chromeclaw-' + Date.now();
  visionMessageCount = 0;
  visionReminderShown = false;
  conversationHistory = [];
  const messages = document.getElementById('messages');
  messages.innerHTML = '';
  addSystemMessage('New session started. How can I help with this page?');
  chrome.storage.local.remove('chromeclaw_chat');
  updateContextMeter();
  closeSessions();
}

function closeSessions() {
  document.getElementById('sessions-panel').classList.add('hidden');
}

function renderSessionsList() {
  const list = document.getElementById('sessions-list');
  list.innerHTML = '';
  loadAllSessions().then(sessions => {
    const entries = Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt);
    if (entries.length === 0) {
      list.innerHTML = '<p style="font-size:12.5px;color:var(--text-muted);text-align:center;padding:20px 0;">No saved sessions yet.</p>';
      return;
    }
    entries.forEach(session => {
      const isCurrent = session.id === currentSessionId;
      const date = new Date(session.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const msgCount = (session.history || []).filter(m => m.role === 'user' || m.role === 'assistant').length;
      const item = document.createElement('div');
      item.className = `session-item${isCurrent ? ' active' : ''}`;
      item.innerHTML = `
        <div class="session-item-meta">
          <div class="session-item-name" title="${escapeHtml(session.name)}">${escapeHtml(session.name)}</div>
          <div class="session-item-detail">${escapeHtml(date)} &middot; ${msgCount} msg${msgCount !== 1 ? 's' : ''}</div>
        </div>
        <div class="session-item-actions">
          ${isCurrent
            ? '<button class="btn-session-load" disabled style="opacity:0.4;cursor:default;">Current</button>'
            : '<button class="btn-session-load">Load</button>'}
          <button class="btn-session-delete">Delete</button>
        </div>`;
      if (!isCurrent) {
        item.querySelector('.btn-session-load').addEventListener('click', () => switchToSession(session.id));
      }
      item.querySelector('.btn-session-delete').addEventListener('click', async () => {
        await deleteSession(session.id);
        renderSessionsList();
      });
      list.appendChild(item);
    });
  });
}

// ─── Image Paste Support ────────────────────────────────────────────────────────
function handleImagePaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) return;

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
        pendingImageAttachment = {
          dataUrl,
          base64,
          mimeType: item.type,
          name: `pasted-image.${item.type.split('/')[1] || 'png'}`
        };
        showImagePreview(dataUrl);
      };
      reader.readAsDataURL(blob);
      return; // Only handle first image
    }
  }
}

function showImagePreview(dataUrl) {
  removeImagePreview();
  const inputArea = document.getElementById('input-area');
  const preview = document.createElement('div');
  preview.id = 'image-preview';
  preview.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 12px;background:rgba(255,107,53,0.1);border:1px solid rgba(255,107,53,0.2);border-radius:8px;margin:0 12px 6px 12px;';

  const img = document.createElement('img');
  img.src = dataUrl;
  img.style.cssText = 'max-height:48px;max-width:80px;border-radius:4px;object-fit:cover;';

  const label = document.createElement('span');
  label.textContent = 'Image attached';
  label.style.cssText = 'font-size:12px;color:var(--text-secondary,#9a9a9a);flex:1;';

  const removeBtn = document.createElement('button');
  removeBtn.textContent = '✕';
  removeBtn.style.cssText = 'background:none;border:none;color:var(--text-secondary,#9a9a9a);cursor:pointer;font-size:14px;padding:2px 6px;';
  removeBtn.onclick = () => { pendingImageAttachment = null; removeImagePreview(); };

  preview.appendChild(img);
  preview.appendChild(label);
  preview.appendChild(removeBtn);
  inputArea.insertBefore(preview, inputArea.querySelector('.input-row'));
}

function removeImagePreview() {
  const existing = document.getElementById('image-preview');
  if (existing) existing.remove();
}

// ─── Message Sending ────────────────────────────────────────────────────────────
// editContext = { text, historyIndex, existingBubble } — set when re-sending an edited message
async function sendMessage(forceVision = false, editContext = null) {
  const input = document.getElementById('user-input');
  const text = editContext ? editContext.text : input.value.trim();
  if ((!text && !pendingImageAttachment) || isGenerating) return;

  if (!editContext) {
    input.value = '';
    input.style.height = 'auto';
    // Add user message to chat with its history index (= current length, before push)
    const historyIndex = conversationHistory.length;
    addMessageBubble('user', text || '[Image]', historyIndex);
  } else {
    // Restore the edited bubble to normal display mode
    const bubble = editContext.existingBubble;
    bubble.classList.remove('editing');
    const contentDiv = bubble.querySelector('.message-content');
    contentDiv.innerHTML = '';
    contentDiv.textContent = text;
  }

  // Build message text, optionally with page context
  let messageText = text;
  if (settings.includeContext) {
    try {
      const context = await getPageContext();
      if (context) {
        let focusLine = '';
        if (context.focusedElement) {
          const f = context.focusedElement;
          const parts = [`tag=${f.tag}`];
          if (f.ariaLabel) parts.push(`aria-label="${f.ariaLabel}"`);
          if (f.placeholder) parts.push(`placeholder="${f.placeholder}"`);
          if (f.contenteditable) parts.push('contenteditable=true');
          if (f.activeSectionLabel) parts.push(`active-section="${f.activeSectionLabel}"`);
          if (f.selector) parts.push(`selector=${f.selector}`);
          focusLine = `\n[Currently focused element: ${parts.join(', ')}]`;
          focusLine += `\n[IMPORTANT: The user is currently in "${f.activeSectionLabel || f.ariaLabel || f.placeholder || f.tag}". Type/interact HERE — do NOT click away to navigate to a different section/chat/page unless explicitly asked.]`;
        }
        messageText = `[Current Page: ${context.title} — ${context.url}]\n[Page has ${context.forms} forms, ${context.links} links]${focusLine}\n\n${SYSTEM_PROMPT}\n\nUser request: ${text}`;
      } else {
        messageText = `${SYSTEM_PROMPT}\n\nUser request: ${text}`;
      }
    } catch {
      messageText = `${SYSTEM_PROMPT}\n\nUser request: ${text}`;
    }
  } else {
    messageText = `${SYSTEM_PROMPT}\n\nUser request: ${text}`;
  }

  // Build attachments from pasted image and/or vision screenshot
  let attachments = [];

  // Pasted image
  if (pendingImageAttachment) {
    attachments.push({
      name: pendingImageAttachment.name,
      content: pendingImageAttachment.base64,
      encoding: 'base64',
      mimeType: pendingImageAttachment.mimeType
    });
    messageText += '\n\n[A pasted image is attached.]';
    pendingImageAttachment = null;
    removeImagePreview();
  }

  // Vision screenshot
  const useVision = forceVision || settings.includeVision;
  if (useVision) {
    // Rotate the server session after VISION_SESSION_ROTATE_AFTER screenshots so old
    // images don't keep accumulating in the gateway's context window.
    if (visionMessageCount > 0 && visionMessageCount % VISION_SESSION_ROTATE_AFTER === 0) {
      currentSessionKey = 'chromeclaw-' + Date.now();
    }

    const screenshot = await captureScreenshot();
    if (screenshot) {
      const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, '');
      attachments.push({
        name: 'screenshot.jpg',
        content: base64Data,
        encoding: 'base64',
        mimeType: 'image/jpeg'
      });
      messageText += '\n\n[A screenshot of the current page is attached.]';
      visionMessageCount++;
      if (!visionReminderShown && visionMessageCount >= VISION_REMIND_AFTER) {
        visionReminderShown = true;
        addVisionReminder();
      }
    }
  }

  if (attachments.length === 0) attachments = null;

  // Store for history (keep raw user text for display)
  // For editContext, the history was already truncated to historyIndex; push at that slot
  conversationHistory.push({ role: 'user', text, content: messageText });

  // Update the bubble's historyIndex to its actual position (in case it changed)
  if (editContext?.existingBubble) {
    editContext.existingBubble.dataset.historyIndex = conversationHistory.length - 1;
  }

  // Send via WebSocket
  await runAgentLoop(messageText, attachments);
}

// ─── Streaming Chat via WebSocket ───────────────────────────────────────────────
async function runAgentLoop(messageText, attachments = null) {
  isGenerating = true;
  updateSendButton();

  let currentBubble = null;
  let accumulatedContent = '';
  let sessionKey = currentSessionKey;

  try {
    const client = await ensureConnected();

    // Set up event listener for streaming response
    const streamComplete = new Promise((resolve, reject) => {
      let resolved = false;

      client.onEvent = (event, payload) => {
        if (event !== 'chat') return;
        if (resolved) return;

        const state = payload?.state;
        const msgContent = payload?.message?.content;

        // Extract text from content array or string
        let text = '';
        if (typeof msgContent === 'string') {
          text = msgContent;
        } else if (Array.isArray(msgContent)) {
          for (const part of msgContent) {
            if (part.type === 'text' && part.text) {
              text += part.text;
            }
          }
        }

        if (state === 'delta' && text) {
          // Gateway sends the full text so far in each delta, not incremental chunks
          accumulatedContent = text;
          if (!currentBubble) {
            currentBubble = createAssistantBubble();
          }
          updateAssistantBubble(currentBubble, accumulatedContent);
        } else if (state === 'final') {
          // Final message contains the complete text
          if (text) {
            accumulatedContent = text;
          }
          resolved = true;
          resolve(accumulatedContent);
        } else if (state === 'aborted') {
          resolved = true;
          resolve(accumulatedContent || '[Aborted]');
        } else if (state === 'error') {
          resolved = true;
          reject(new Error(text || 'Chat error from gateway'));
        }
      };

      // Timeout for the whole chat response (2 minutes)
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          if (accumulatedContent) {
            resolve(accumulatedContent);
          } else {
            reject(new Error('Response timed out'));
          }
        }
      }, 120000);
    });

    // Send the message
    const sendParams = {
      sessionKey,
      message: messageText,
      deliver: false,
      idempotencyKey: `chromeclaw-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    };
    if (attachments) {
      sendParams.attachments = attachments;
    }
    await client.request('chat.send', sendParams);

    // Wait for streaming to complete
    const finalContent = await streamComplete;

    // Finalize the message
    if (finalContent) {
      finalizeAssistantMessage(finalContent);
      conversationHistory.push({ role: 'assistant', content: finalContent });

      // Check for action blocks and execute them
      const actions = parseActions(finalContent);
      if (actions.length > 0) {
        await executeActions(actions, client, sessionKey);
      }
    }

  } catch (err) {
    if (err.message === 'aborted') {
      finalizeCurrentAssistant('[Stopped]');
    } else {
      if (openclawClient && !openclawClient.connected) {
        openclawClient = null;
      }
      addMessageBubble('error', `Error: ${err.message}`);
    }
  } finally {
    isGenerating = false;
    if (openclawClient) {
      openclawClient.onEvent = null;
    }
    updateSendButton();
    saveChat();
    saveCurrentSession();
  }
}

// ─── Debug Helpers ──────────────────────────────────────────────────────────────
async function debugShowForAction(action, tab) {
  const type = action.action;
  const labelParts = [type];
  if (action.selector) labelParts.push(action.selector.substring(0, 45));
  else if (action.text) labelParts.push(`"${String(action.text).substring(0, 30)}"`);
  else if (action.key) labelParts.push(action.key);
  const label = labelParts.join(' · ');

  const send = (msg) => chrome.tabs.sendMessage(tab.id, msg).catch(() => {});

  if (['click', 'click_text', 'double_click', 'right_click', 'fill', 'type', 'hover', 'check', 'submit'].includes(type)) {
    const hlRes = action.selector
      ? await chrome.tabs.sendMessage(tab.id, { action: 'debug_highlight', selector: action.selector }).catch(() => null)
      : null;
    const rect = hlRes?.data?.rect;
    const cx = rect ? rect.left + rect.width / 2 : 100;
    const cy = rect ? rect.top + rect.height / 2 : 100;
    await send({ action: 'debug_cursor', x: cx, y: cy });
    await send({ action: 'debug_label', x: cx, y: cy, text: label });

  } else if (type === 'drag') {
    let { fromX = 0, fromY = 0, toX = 100, toY = 100 } = action;
    if (action.selector) {
      const r = await chrome.tabs.sendMessage(tab.id, { action: 'get_rect', selector: action.selector }).catch(() => null);
      if (r?.data) {
        fromX = r.data.left + fromX; fromY = r.data.top + fromY;
        toX = r.data.left + toX;     toY = r.data.top + toY;
      }
    }
    await send({ action: 'debug_drag_path', fromX, fromY, toX, toY });
    await send({ action: 'debug_cursor', x: fromX, y: fromY });
    await send({ action: 'debug_label', x: (fromX + toX) / 2, y: Math.min(fromY, toY) - 16, text: label });

  } else if (type === 'get_rect' && action.selector) {
    const hlRes = await chrome.tabs.sendMessage(tab.id, { action: 'debug_highlight', selector: action.selector }).catch(() => null);
    const rect = hlRes?.data?.rect;
    if (rect) await send({ action: 'debug_label', x: rect.left + rect.width / 2, y: rect.top, text: label });

  } else if (type === 'scroll') {
    await send({ action: 'debug_label', x: window.innerWidth / 2, y: 80, text: label });

  } else if (type === 'press_key') {
    await send({ action: 'debug_label', x: 80, y: 80, text: label });
  }
}

async function debugRippleForAction(action, tab) {
  if (!['click', 'click_text', 'double_click', 'right_click'].includes(action.action)) return;
  if (!action.selector) return;
  const r = await chrome.tabs.sendMessage(tab.id, { action: 'get_rect', selector: action.selector }).catch(() => null);
  if (r?.data) {
    await chrome.tabs.sendMessage(tab.id, {
      action: 'debug_ripple',
      x: r.data.left + r.data.width / 2,
      y: r.data.top + r.data.height / 2
    }).catch(() => {});
  }
}

function pauseForStep(action) {
  return new Promise(resolve => {
    _stepContinueResolve = resolve;
    const toolActivity = document.getElementById('tool-activity');
    const text = document.getElementById('tool-activity-text');
    const btn = document.getElementById('btn-step-continue');
    const label = [action.action, action.selector || action.text || action.key || ''].filter(Boolean).join(' · ');
    text.textContent = `⏸ ${label}`;
    btn.classList.remove('hidden');
    toolActivity.classList.remove('hidden');
  });
}

// ─── Action Parsing & Execution ─────────────────────────────────────────────────
function parseActions(text) {
  const actions = [];
  const regex = /```action\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      actions.push(JSON.parse(match[1].trim()));
    } catch {
      // Skip malformed action blocks
    }
  }
  return actions;
}

async function executeActions(actions, client, sessionKey) {
  const results = [];

  const delay = settings.debugMode ? (settings.debugDelay ?? 500) : 300;

  for (const action of actions) {
    // Step-by-step: pause and wait for user to click Continue
    if (settings.debugMode && settings.debugStepByStep) {
      await pauseForStep(action);
    } else {
      showToolActivity(action.action);
    }

    // Show debug overlays before executing
    if (settings.debugMode) {
      const tab = await getActiveTab();
      if (tab) await debugShowForAction(action, tab).catch(() => {});
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
    }

    try {
      const result = await executePageAction(action);
      results.push({ action: action.action, success: true, result });
    } catch (err) {
      results.push({ action: action.action, success: false, error: err.message });
    }

    // Show ripple for clicks, then clear overlays
    if (settings.debugMode) {
      const tab = await getActiveTab();
      if (tab) {
        await debugRippleForAction(action, tab).catch(() => {});
        if (delay > 0) await new Promise(r => setTimeout(r, delay / 2));
        await chrome.tabs.sendMessage(tab.id, { action: 'debug_clear' }).catch(() => {});
      }
    } else {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  hideToolActivity();

  // Show subtle action summary in the UI
  addActionResultBubble(results);

  // Build follow-up message with results and optional new screenshot
  let followUp = `[Action results:\n${results.map(r =>
    r.success ? `✓ ${r.action}: ${JSON.stringify(r.result).substring(0, 200)}` : `✗ ${r.action}: ${r.error}`
  ).join('\n')}]`;

  // Only capture a follow-up screenshot if an action failed — success text is enough context.
  // This prevents screenshots accumulating in the conversation on every action round.
  let followUpAttachments = null;
  const hasFailure = results.some(r => !r.success);
  if (settings.includeVision && hasFailure) {
    await new Promise(r => setTimeout(r, 500)); // Wait for page to settle
    const screenshot = await captureScreenshot();
    if (screenshot) {
      const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, '');
      followUpAttachments = [{
        name: 'after-action.jpg',
        content: base64Data,
        encoding: 'base64',
        mimeType: 'image/jpeg'
      }];
      followUp += '\n[Screenshot after actions attached.]';
    }
  }

  conversationHistory.push({ type: 'action_result', results });

  // If all actions succeeded and no screenshot to send, skip the follow-up entirely —
  // the agent's original message already explained the intent, no need to force another response.
  if (!hasFailure && !followUpAttachments) {
    return;
  }

  // Stream the agent's response to action results
  let currentBubble = null;
  let accumulatedContent = '';

  const streamComplete = new Promise((resolve, reject) => {
    let resolved = false;
    client.onEvent = (event, payload) => {
      if (event !== 'chat' || resolved) return;
      const state = payload?.state;
      const msgContent = payload?.message?.content;
      let text = '';
      if (typeof msgContent === 'string') text = msgContent;
      else if (Array.isArray(msgContent)) {
        for (const part of msgContent) {
          if (part.type === 'text' && part.text) text += part.text;
        }
      }
      if (state === 'delta' && text) {
        accumulatedContent = text;
        if (!currentBubble) currentBubble = createAssistantBubble();
        updateAssistantBubble(currentBubble, accumulatedContent);
      } else if (state === 'final') {
        if (text) accumulatedContent = text;
        resolved = true;
        resolve(accumulatedContent);
      } else if (state === 'aborted' || state === 'error') {
        resolved = true;
        resolve(accumulatedContent || '');
      }
    };
    setTimeout(() => { if (!resolved) { resolved = true; resolve(accumulatedContent); } }, 120000);
  });

  const sendParams = {
    sessionKey,
    message: followUp,
    deliver: false,
    idempotencyKey: `chromeclaw-action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  };
  if (followUpAttachments) sendParams.attachments = followUpAttachments;
  await client.request('chat.send', sendParams);

  const finalContent = await streamComplete;
  if (finalContent) {
    finalizeAssistantMessage(finalContent);
    conversationHistory.push({ role: 'assistant', content: finalContent });

    // Recurse if the follow-up also contains actions (max depth handled by isGenerating)
    const moreActions = parseActions(finalContent);
    if (moreActions.length > 0) {
      await executeActions(moreActions, client, sessionKey);
    }
  }
}

async function executePageAction(action) {
  const tab = await getActiveTab();
  if (!tab || tab.url?.startsWith('chrome://')) {
    throw new Error('Cannot interact with this page');
  }
  await chrome.runtime.sendMessage({ action: 'ensureContentScript', tabId: tab.id });

  const type = action.action;
  let msg = {};

  switch (type) {
    case 'click':
      msg = { action: 'click_element', selector: action.selector };
      break;
    case 'click_text':
      msg = { action: 'click_element', text: action.text };
      break;
    case 'fill':
      msg = { action: 'fill_input', selector: action.selector, text: action.text, value: action.value };
      break;
    case 'type':
    case 'type_keyboard':
      msg = { action: 'type_keyboard', selector: action.selector, text: action.text, value: action.value };
      break;
    case 'select':
      msg = { action: 'select_option', selector: action.selector, value: action.value, option_text: action.option_text };
      break;
    case 'scroll':
      msg = { action: 'scroll_page', direction: action.direction || 'down', amount: action.amount };
      break;
    case 'check':
      msg = { action: 'check_element', selector: action.selector, text: action.text, checked: action.checked !== false };
      break;
    case 'submit':
      msg = { action: 'submit_form', selector: action.selector };
      break;
    case 'press_key':
      msg = { action: 'press_key', key: action.key, selector: action.selector };
      break;
    case 'highlight':
      msg = { action: 'highlight_elements', selector: action.selector, color: action.color || 'orange' };
      break;
    case 'double_click':
      msg = { action: 'double_click', selector: action.selector, text: action.text };
      break;
    case 'right_click':
      msg = { action: 'right_click', selector: action.selector, text: action.text };
      break;
    case 'hover':
      msg = { action: 'hover', selector: action.selector, text: action.text };
      break;
    case 'get_rect':
      msg = { action: 'get_rect', selector: action.selector, text: action.text };
      break;
    case 'drag':
      msg = { action: 'drag', selector: action.selector, fromX: action.fromX, fromY: action.fromY, toX: action.toX, toY: action.toY, steps: action.steps };
      break;
    default:
      throw new Error(`Unknown action: ${type}`);
  }

  const response = await chrome.tabs.sendMessage(tab.id, msg);
  if (response?.success) return response.data;
  throw new Error(response?.error || 'Action failed');
}

function showToolActivity(actionName) {
  const el = document.getElementById('tool-activity');
  if (!el) return;
  const text = document.getElementById('tool-activity-text');
  if (text) text.textContent = `Performing: ${actionName}...`;
  el.classList.remove('hidden');
}

function hideToolActivity() {
  const el = document.getElementById('tool-activity');
  if (el) el.classList.add('hidden');
}

// ─── Page Context ───────────────────────────────────────────────────────────────
async function getPageContext() {
  try {
    const tab = await getActiveTab();
    if (!tab || tab.url?.startsWith('chrome://')) return null;

    await chrome.runtime.sendMessage({ action: 'ensureContentScript', tabId: tab.id });

    const [pageResp, focusResp] = await Promise.all([
      chrome.tabs.sendMessage(tab.id, { action: 'get_page_context', max_length: settings.maxContext }),
      chrome.tabs.sendMessage(tab.id, { action: 'get_focused_element' }).catch(() => null)
    ]);

    const data = pageResp?.success ? pageResp.data : null;
    if (!data) return null;

    if (focusResp?.success && focusResp.data?.focused) {
      data.focusedElement = focusResp.data;
    }

    return data;
  } catch {
    return null;
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ─── Screenshot Capture ─────────────────────────────────────────────────────────
async function captureScreenshot(quality = 75) {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'captureScreenshot',
      format: 'jpeg',
      quality
    });
    if (response?.success) {
      return response.dataUrl;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Message Editing ─────────────────────────────────────────────────────────────
function enterEditMode(bubble) {
  if (isGenerating) return;
  const historyIndex = parseInt(bubble.dataset.historyIndex);
  const originalText = conversationHistory[historyIndex]?.text || '';

  bubble.classList.add('editing');
  const contentDiv = bubble.querySelector('.message-content');
  const editBtn = bubble.querySelector('.msg-edit-btn');

  // Replace content with textarea
  contentDiv.innerHTML = '';
  const textarea = document.createElement('textarea');
  textarea.className = 'msg-edit-textarea';
  textarea.value = originalText;
  textarea.rows = Math.max(2, originalText.split('\n').length);
  contentDiv.appendChild(textarea);

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'msg-edit-actions';

  const sendBtn = document.createElement('button');
  sendBtn.className = 'msg-edit-send';
  sendBtn.textContent = 'Send';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'msg-edit-cancel';
  cancelBtn.textContent = 'Cancel';

  actions.appendChild(cancelBtn);
  actions.appendChild(sendBtn);
  if (editBtn) editBtn.style.opacity = '0';
  bubble.appendChild(actions);

  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  // Auto-resize textarea
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
  });

  // Enter = send, Shift+Enter = newline
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    } else if (e.key === 'Escape') {
      cancelBtn.click();
    }
  });

  cancelBtn.addEventListener('click', () => {
    bubble.classList.remove('editing');
    contentDiv.innerHTML = '';
    contentDiv.textContent = originalText;
    actions.remove();
    if (editBtn) editBtn.style.opacity = '';
  });

  sendBtn.addEventListener('click', () => {
    const newText = textarea.value.trim();
    if (!newText) return;
    submitEditedMessage(bubble, newText, historyIndex, actions, editBtn);
  });
}

function submitEditedMessage(bubble, newText, historyIndex, actionsEl, editBtn) {
  // Count how many messages follow this one in the DOM
  const allBubbles = Array.from(document.getElementById('messages').querySelectorAll('.message'));
  const bubbleIdx = allBubbles.indexOf(bubble);
  const followingBubbles = allBubbles.slice(bubbleIdx + 1);
  const followingCount = followingBubbles.length;

  if (followingCount === 0) {
    // No messages after — just resend immediately
    doEditSend(bubble, newText, historyIndex, followingBubbles, actionsEl, editBtn);
    return;
  }

  // Show confirmation overlay (fixed, always visible)
  const overlay = document.createElement('div');
  overlay.className = 'edit-confirm-overlay';
  overlay.innerHTML = `
    <div class="edit-confirm-box">
      <p>This will remove <strong>${followingCount} message${followingCount > 1 ? 's' : ''}</strong> that follow this point.</p>
      <div class="edit-confirm-btns">
        <button class="edit-confirm-no">Cancel</button>
        <button class="edit-confirm-yes">Send &amp; Remove</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  overlay.querySelector('.edit-confirm-no').addEventListener('click', () => {
    overlay.remove();
  });

  overlay.querySelector('.edit-confirm-yes').addEventListener('click', () => {
    overlay.remove();
    doEditSend(bubble, newText, historyIndex, followingBubbles, actionsEl, editBtn);
  });
}

function doEditSend(bubble, newText, historyIndex, followingBubbles, actionsEl, editBtn) {
  // Remove subsequent DOM bubbles
  followingBubbles.forEach(b => b.remove());

  // Truncate conversationHistory to just before this message
  conversationHistory.splice(historyIndex);

  // Clean up edit UI
  actionsEl?.remove();
  if (editBtn) editBtn.style.opacity = '';

  // Fire the send
  sendMessage(false, { text: newText, historyIndex, existingBubble: bubble });
}

// ─── UI Helpers ─────────────────────────────────────────────────────────────────
function addMessageBubble(role, content, historyIndex) {
  const messages = document.getElementById('messages');
  const bubble = document.createElement('div');
  bubble.className = `message ${role}`;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';

  if (role === 'user') {
    contentDiv.textContent = content;
    bubble.appendChild(contentDiv);

    if (historyIndex !== undefined) {
      bubble.dataset.historyIndex = historyIndex;
      const editBtn = document.createElement('button');
      editBtn.className = 'msg-edit-btn';
      editBtn.title = 'Edit message';
      editBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M11.333 2a1.886 1.886 0 012.667 2.667L5.333 13.333 1.333 14.667l1.334-4L11.333 2z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> Edit`;
      editBtn.addEventListener('click', () => enterEditMode(bubble));
      bubble.appendChild(editBtn);
    }
  } else {
    contentDiv.innerHTML = renderMarkdown(extractTextContent(content));
    bubble.appendChild(contentDiv);
  }

  messages.appendChild(bubble);
  scrollToBottom();
}

function addActionResultBubble(results = []) {
  const messages = document.getElementById('messages');
  const bubble = document.createElement('div');
  bubble.className = 'message action-result';

  const ok = results.filter(r => r.success).length;
  const fail = results.filter(r => !r.success).length;
  const label = results.map(r => `${r.success ? '✓' : '✗'} ${r.action}`).join('  ');

  bubble.innerHTML = `<div class="action-result-content">${label}</div>`;
  messages.appendChild(bubble);
  scrollToBottom();
}

function addSystemMessage(text) {
  const messages = document.getElementById('messages');
  const bubble = document.createElement('div');
  bubble.className = 'message system';
  bubble.innerHTML = `<div class="message-content"><p>${escapeHtml(text)}</p></div>`;
  messages.appendChild(bubble);
  scrollToBottom();
}

function addVisionReminder() {
  const messages = document.getElementById('messages');
  const bubble = document.createElement('div');
  bubble.className = 'message vision-reminder';
  bubble.innerHTML = `
    <div class="vision-reminder-content">
      <span class="vision-reminder-icon">📸</span>
      <span class="vision-reminder-text">Vision has been on for ${VISION_REMIND_AFTER}+ messages. Turn it off to save context.</span>
      <button class="vision-reminder-off">Turn off</button>
      <button class="vision-reminder-dismiss">✕</button>
    </div>`;
  bubble.querySelector('.vision-reminder-off').addEventListener('click', () => {
    settings.includeVision = false;
    visionReminderShown = false;
    document.getElementById('include-vision').checked = false;
    saveSettings();
    bubble.remove();
  });
  bubble.querySelector('.vision-reminder-dismiss').addEventListener('click', () => bubble.remove());
  messages.appendChild(bubble);
  scrollToBottom();
}

function createAssistantBubble() {
  const messages = document.getElementById('messages');
  const bubble = document.createElement('div');
  bubble.className = 'message assistant streaming';

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';

  const cursor = document.createElement('span');
  cursor.className = 'cursor';

  contentDiv.appendChild(cursor);
  bubble.appendChild(contentDiv);
  messages.appendChild(bubble);
  scrollToBottom();
  return bubble;
}

function updateAssistantBubble(bubble, content) {
  const contentDiv = bubble.querySelector('.message-content');
  contentDiv.innerHTML = renderMarkdown(content) + '<span class="cursor"></span>';
  scrollToBottom();
}

function finalizeAssistantMessage(content) {
  const messages = document.getElementById('messages');
  const streaming = messages.querySelector('.message.streaming');
  const text = extractTextContent(content);

  if (streaming) {
    streaming.classList.remove('streaming');
    const contentDiv = streaming.querySelector('.message-content');
    contentDiv.innerHTML = renderMarkdown(text);
  } else {
    addMessageBubble('assistant', text);
  }
  scrollToBottom();
}

function finalizeCurrentAssistant(suffix) {
  const messages = document.getElementById('messages');
  const streaming = messages.querySelector('.message.streaming');
  if (streaming) {
    streaming.classList.remove('streaming');
    const cursor = streaming.querySelector('.cursor');
    if (cursor) cursor.remove();
    if (suffix) {
      const contentDiv = streaming.querySelector('.message-content');
      contentDiv.innerHTML += `<em>${escapeHtml(suffix)}</em>`;
    }
  }
}

function updateSendButton() {
  document.getElementById('btn-send').classList.toggle('hidden', isGenerating);
  document.getElementById('btn-stop').classList.toggle('hidden', !isGenerating);
}

async function stopGeneration() {
  // Try to abort the current chat on the server
  if (openclawClient && openclawClient.connected) {
    try {
      await openclawClient.request('chat.abort', { sessionKey: currentSessionKey });
    } catch {
      // Best-effort abort
    }
  }
  finalizeCurrentAssistant('[Stopped]');
  isGenerating = false;
  updateSendButton();
}

function scrollToBottom() {
  const container = document.getElementById('chat-container');
  container.scrollTop = container.scrollHeight;
}

function autoResizeInput() {
  const input = document.getElementById('user-input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 150) + 'px';
}

// ─── Device Identity ────────────────────────────────────────────────────────────
async function updateDeviceStatus() {
  const el = document.getElementById('device-status');
  if (!el) return;
  const identity = await loadDeviceIdentity();
  if (identity) {
    el.textContent = `Loaded (device: ${identity.deviceId.substring(0, 12)}...)`;
    el.style.color = 'var(--success, #22c55e)';
  } else {
    el.textContent = 'Not loaded — click button below to load from OpenClaw config';
    el.style.color = 'var(--text-muted, #666)';
  }
}

async function loadDeviceIdentityFromFiles() {
  const statusEl = document.getElementById('device-status');
  statusEl.textContent = 'Select device.json from ~/.openclaw/identity/ ...';
  statusEl.style.color = 'var(--info, #3b82f6)';

  try {
    // Use file picker for device.json
    const deviceFile = await pickJsonFile('Select device.json');
    if (!deviceFile) { statusEl.textContent = 'Cancelled'; return; }

    statusEl.textContent = 'Now select device-auth.json ...';
    const authFile = await pickJsonFile('Select device-auth.json');
    if (!authFile) { statusEl.textContent = 'Cancelled'; return; }

    const operatorAuth = authFile.tokens?.operator;
    if (!operatorAuth?.token) {
      throw new Error('No operator token found. Run "openclaw onboard" first.');
    }

    const identity = {
      deviceId: deviceFile.deviceId,
      publicKeyPem: deviceFile.publicKeyPem,
      privateKeyPem: deviceFile.privateKeyPem,
      deviceToken: operatorAuth.token,
      scopes: operatorAuth.scopes || []
    };

    await saveDeviceIdentity(identity);

    // Disconnect to force reconnect with new identity
    if (openclawClient) {
      openclawClient.disconnect();
      openclawClient = null;
    }

    statusEl.textContent = `Loaded! Device: ${identity.deviceId.substring(0, 12)}...`;
    statusEl.style.color = 'var(--success, #22c55e)';
    showSettingsStatus('Device identity loaded successfully!', 'success');
    checkConnection();
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.style.color = 'var(--error, #ef4444)';
  }
}

function pickJsonFile(title) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) { resolve(null); return; }
      try {
        const text = await file.text();
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    };
    input.click();
  });
}

// ─── Model Fetching ─────────────────────────────────────────────────────────────
async function fetchAvailableModels() {
  const select = document.getElementById('setting-model-select');
  const btn = document.getElementById('btn-fetch-models');

  btn.disabled = true;
  select.innerHTML = '<option value="">Fetching models...</option>';

  const models = [];

  // Try fetching from OpenClaw gateway via WebSocket
  try {
    const url = document.getElementById('setting-api-url').value.replace(/\/+$/, '') || settings.apiUrl;
    const token = document.getElementById('setting-api-token').value || settings.apiToken;

    const fetchClient = new OpenClawClient();
    await fetchClient.connect(url, token);
    const result = await fetchClient.request('models.list');
    fetchClient.disconnect();

    const rawModels = Array.isArray(result?.models) ? result.models
      : Array.isArray(result) ? result : [];
    for (const m of rawModels) {
      const id = typeof m === 'string' ? m : (m.id || m);
      const label = typeof m === 'string' ? m : (m.name || m.id || m);
      // OpenClaw gateway returns contextWindow (tokens, optional)
      const ctxTokens = m.contextWindow || null;
      if (ctxTokens && id) modelContextWindowMap[id] = ctxTokens * 4; // tokens → chars estimate
      models.push({ id, source: 'OpenClaw', label });
    }
  } catch {}

  // Default OpenClaw entry
  const knownModels = [
    { id: 'openclaw', source: 'Default', label: 'openclaw (gateway default)' },
  ];

  // Build the dropdown
  select.innerHTML = '';
  const seen = new Set();

  // Group: OpenClaw gateway models
  const openclawModels = models.filter(m => m.source === 'OpenClaw');
  if (openclawModels.length > 0) {
    const group = document.createElement('optgroup');
    group.label = 'OpenClaw Gateway';
    for (const m of openclawModels) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      group.appendChild(opt);
    }
    select.appendChild(group);
  }

  // Group: Fallback/known models
  const fallbackGroup = document.createElement('optgroup');
  fallbackGroup.label = 'Common Models';
  for (const m of knownModels) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label || m.id;
    fallbackGroup.appendChild(opt);
  }
  select.appendChild(fallbackGroup);

  // Custom option
  const customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = '✎ Type custom model...';
  select.appendChild(customOpt);

  // Pre-select current model
  const currentModel = document.getElementById('setting-model').value;
  if (currentModel) {
    select.value = currentModel;
    if (!select.value) {
      select.parentElement.classList.add('custom-mode');
    }
  }

  btn.disabled = false;
  if (openclawModels.length > 0) {
    const withCtx = openclawModels.filter(m => modelContextWindowMap[m.id]).length;
    const ctxNote = withCtx > 0 ? ` (${withCtx} with context window info)` : '';
    showSettingsStatus(`Found ${openclawModels.length} model(s) from OpenClaw gateway.${ctxNote}`, 'success');
  } else {
    showSettingsStatus('Could not fetch models from gateway. Using defaults.', 'info');
  }
  // Update the context meter with the new context window info for the selected model
  updateModelContextWindow();
}

// ─── Markdown Renderer (lightweight, no dependencies) ───────────────────────────
function describeActionSummary(obj) {
  const a = obj.action || 'action';
  switch (a) {
    case 'drag':
      return `drag (${obj.fromX},${obj.fromY} → ${obj.toX},${obj.toY})`;
    case 'type': case 'fill': {
      const val = String(obj.value || '');
      const preview = val.length > 40 ? val.substring(0, 40) + '…' : val;
      return `${a} "${preview}"`;
    }
    case 'click': return `click ${obj.selector || ''}`;
    case 'click_text': return `click "${obj.text || ''}"`;
    case 'press_key': return `press ${obj.key || ''}`;
    case 'scroll': return `scroll ${obj.direction || ''}`;
    case 'hover': return `hover ${obj.selector || ''}`;
    case 'double_click': return `double_click ${obj.selector || ''}`;
    case 'right_click': return `right_click ${obj.selector || ''}`;
    case 'get_rect': return `get_rect ${obj.selector || ''}`;
    case 'select': return `select ${obj.selector || ''} → "${obj.value || ''}"`;
    case 'highlight': return `highlight ${obj.selector || ''}`;
    case 'check': return `${obj.checked ? 'check' : 'uncheck'} ${obj.selector || ''}`;
    default: return a;
  }
}

function renderMarkdown(text) {
  if (!text) return '';

  let html = escapeHtml(text);

  // Extract code blocks and inline code to protect them from formatting
  const codeBlocks = [];
  const actionItems = []; // {summary, code} for lang-action blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    if (lang === 'action') {
      // Unescape HTML entities to parse JSON
      const rawJson = code.trim()
        .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      let summary = 'action';
      try { summary = describeActionSummary(JSON.parse(rawJson)); } catch (e) {}
      const aIdx = actionItems.length;
      actionItems.push({ summary, code: code.trim() });
      codeBlocks.push(`\x00ACTION:${aIdx}\x00`);
    } else {
      codeBlocks.push(`<pre><code class="lang-${lang}">${code.trim()}</code></pre>`);
    }
    return `\x00CODEBLOCK${idx}\x00`;
  });

  const inlineCodes = [];
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${code}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

  // Blockquotes — collapse consecutive > lines into a single <blockquote>
  html = html.replace(/((?:^&gt; ?.*(?:\n|$))+)/gm, (match) => {
    const inner = match.replace(/^&gt; ?/gm, '').trimEnd();
    return `<blockquote>${inner}</blockquote>\n`;
  });

  // Unordered lists
  html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<oli>$1</oli>');
  html = html.replace(/((?:<oli>.*<\/oli>\n?)+)/g, (match) => {
    return '<ol>' + match.replace(/<\/?oli>/g, (t) => t.replace('oli', 'li')) + '</ol>';
  });

  // Links (unescape &amp; back to & in URLs)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    return `<a href="${url.replace(/&amp;/g, '&')}" target="_blank" rel="noopener">${text}</a>`;
  });

  // Line breaks → paragraphs
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = `<p>${html}</p>`;

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>\s*(<(?:h[234]|pre|ul|ol|blockquote)>)/g, '$1');
  html = html.replace(/(<\/(?:h[234]|pre|ul|ol|blockquote)>)\s*<\/p>/g, '$1');

  // Restore code blocks and inline code
  codeBlocks.forEach((block, i) => {
    html = html.replace(`\x00CODEBLOCK${i}\x00`, block);
  });
  inlineCodes.forEach((code, i) => {
    html = html.replace(`\x00INLINE${i}\x00`, code);
  });

  // Group consecutive action placeholders (unwrap from <p> tags first, then group)
  if (actionItems.length > 0) {
    html = html.replace(/<p>\s*\x00ACTION:(\d+)\x00\s*<\/p>/g, '\x00AGROUP:$1\x00');
    html = html.replace(/\x00ACTION:(\d+)\x00/g, '\x00AGROUP:$1\x00'); // bare (inside other tags)

    html = html.replace(/(\x00AGROUP:\d+\x00(\s|<br>)*)+/g, (match) => {
      const indices = [...match.matchAll(/\x00AGROUP:(\d+)\x00/g)].map(m => parseInt(m[1]));
      const items = indices.map(i => actionItems[i]);
      const label = items.length === 1
        ? items[0].summary
        : `${items.length} actions`;
      const details = items.map(a =>
        `<div class="action-block-item"><code>${a.code}</code></div>`
      ).join('');
      return `<div class="actions-group"><button class="actions-toggle"><span class="actions-icon">⚡</span><span class="actions-label">${label}</span><span class="actions-arrow">▾</span></button><div class="actions-content">${details}</div></div>`;
    });
  }

  return html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
