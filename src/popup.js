/**
 * BabelLive Popup — State Management & UI Logic
 * Syncs all settings to chrome.storage.local and communicates with
 * service-worker / content scripts via chrome.runtime messaging.
 */

const STORAGE_KEY = 'babellive_settings';
const SESSION_KEY = 'babellive_session';

const DEFAULTS = {
  enabled: false,
  sourceLang: 'ja',
  targetLang: 'vi',
  subtitlePreset: 'anime',
  fontSize: 22,
  bilingual: true,
  engine: 'cloud',
  cloudProvider: 'groq',
  apiKeys: '',
  demoMode: false,
};

/* ── DOM References ────────────────────────────── */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  masterToggle: $('#masterToggle'),
  statusBar: $('#statusBar'),
  statusDot: $('#statusBar .status-dot'),
  statusText: $('#statusText'),
  sourceLang: $('#sourceLang'),
  targetLang: $('#targetLang'),
  swapLangs: $('#swapLangs'),
  presetBtns: $$('.preset-btn'),
  fontSizeSlider: $('#fontSizeSlider'),
  fontSizeValue: $('#fontSizeValue'),
  bilingualToggle: $('#bilingualToggle'),
  engineRadios: $$('input[name="engine"]'),
  cloudSettings: $('#cloudSettings'),
  localSettings: $('#localSettings'),
  fallbackSettings: $('#fallbackSettings'),
  cloudProvider: $('#cloudProvider'),
  apiKeyList: $('#apiKeyList'),
  addKeyBtn: $('#addKeyBtn'),
  toggleKeyVis: $('#toggleKeyVisibility'),
  keyStatus: $('#keyStatus'),
  webgpuStatus: $('#webgpuStatus'),
  downloadModelBtn: $('#downloadModelBtn'),
  downloadProgress: $('#downloadProgress'),
  progressFill: $('#progressFill'),
  progressText: $('#progressText'),
  systemWarning: $('#systemWarning'),
  demoToggle: $('#demoToggle'),
};

let state = { ...DEFAULTS };

/* ── Persistence ───────────────────────────────── */
async function loadState() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    if (result[STORAGE_KEY]) {
      // Do not load enabled from persistent local storage
      const { enabled, ...prefs } = result[STORAGE_KEY];
      state = { ...DEFAULTS, ...prefs, enabled: false };
    }
    // Read session state for the currently active tab
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    const sessionData = await chrome.storage.session.get(SESSION_KEY).catch(() => ({}));
    const session = sessionData?.[SESSION_KEY];
    const isRunning = session?.isRunning === true && (session.activeTabId == null || session.activeTabId === activeTab?.id);
    state.enabled = Boolean(isRunning);
  } catch (e) {
    console.warn('[popup] loadState error', e);
  }
}

async function saveState() {
  try {
    // Never persist enabled: true to local storage
    const { enabled, ...prefs } = state;
    await chrome.storage.local.set({ [STORAGE_KEY]: { ...prefs, enabled: false } });
    // Notify content scripts and service worker
    broadcastSettings();
  } catch (e) {
    console.warn('[popup] saveState error', e);
  }
}

/* ── Safe Tab Messaging ────────────────────────── */
function safeSendMessageToTab(tabId, message, callback) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, message, (response) => {
    if (chrome.runtime.lastError) {
      // Suppress "Receiving end does not exist" error during reload or unmount
      if (callback) callback(null);
      return;
    }
    if (callback) callback(response);
  });
}

async function ensureTabConnected() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id || !tab.url || !/^https?:|^file:/.test(tab.url)) return;

    const isYouTube = tab.url.includes('youtube.com/watch') || tab.url.includes('youtube.com/live');
    console.log(`[BabelLive-Popup] Checked active tab URL: ${tab.url} | isYouTube: ${isYouTube}`);
    if (!isYouTube) {
      els.masterToggle.disabled = true;
      els.masterToggle.checked = false;
      els.statusDot.className = 'status-dot idle';
      els.statusDot.style.background = '#6b7280';
      els.statusText.textContent = 'Inactive: Please open a YouTube video/stream';
      els.statusText.title = 'BabelLive only works on YouTube';
      return;
    }
    
    // Explicitly enable if on YouTube (in case it was disabled previously)
    els.masterToggle.disabled = false;
    els.statusText.title = '';

    return new Promise((resolve) => {
      safeSendMessageToTab(tab.id, { type: 'BABELLIVE_PING' }, async (res) => {
        if (res?.ok) {
          broadcastSettings();
          resolve();
          return;
        }
        // Not injected yet, inject content script & styles programmatically
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: ['content.js'],
          });
          await chrome.scripting.insertCSS({
            target: { tabId: tab.id, allFrames: true },
            files: ['overlay.css'],
          });
          setTimeout(() => {
            broadcastSettings();
            resolve();
          }, 150);
        } catch (injectErr) {
          console.warn('[BabelLive popup] Injection fallback failed:', injectErr);
          resolve();
        }
      });
    });
  } catch (err) {
    console.warn('[BabelLive popup] ensureTabConnected error:', err);
  }
}

function broadcastSettings() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) return;
    if (tabs[0]?.id) {
      safeSendMessageToTab(tabs[0].id, {
        type: 'BABELLIVE_SETTINGS_UPDATE',
        settings: state,
      });
    }
  });
  chrome.runtime.sendMessage({
    type: 'BABELLIVE_SETTINGS_UPDATE',
    settings: state,
  }, () => {
    if (chrome.runtime.lastError) { }
  });
}

/* ── UI → State sync ──────────────────────────── */
function applyStateToUI() {
  // Master toggle
  els.masterToggle.checked = state.enabled;
  updateStatusUI();

  // Language
  els.sourceLang.value = state.sourceLang;
  els.targetLang.value = state.targetLang;

  // Preset
  els.presetBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.preset === state.subtitlePreset);
  });

  // Font size
  els.fontSizeSlider.value = state.fontSize;
  els.fontSizeValue.textContent = `${state.fontSize}px`;

  // Bilingual
  els.bilingualToggle.checked = state.bilingual;

  // Engine
  els.engineRadios.forEach((r) => { r.checked = r.value === state.engine; });
  showEngineSettings(state.engine);

  // Cloud
  els.cloudProvider.value = state.cloudProvider;
  renderApiKeyRows();
  updateKeyCount();

  // Demo
  els.demoToggle.checked = state.demoMode;
}

function updateStatusUI() {
  const dot = els.statusDot;
  dot.className = 'status-dot';
  if (state.enabled) {
    dot.classList.add('connected');
    els.statusText.textContent = `AI Engine: Connected — ${state.engine === 'cloud' ? (state.cloudProvider === 'groq' ? 'Groq' : 'Gemini Flash') : state.engine === 'local' ? 'Local WebGPU' : 'Fallback'}`;
  } else {
    dot.classList.add('idle');
    els.statusText.textContent = 'Idle — Click toggle to start';
  }
}

function showEngineSettings(engine) {
  els.cloudSettings.classList.toggle('hidden', engine !== 'cloud');
  els.localSettings.classList.toggle('hidden', engine !== 'local');
  els.fallbackSettings.classList.toggle('hidden', engine !== 'fallback');
}

function updateKeyCount() {
  const keys = getApiKeysArray();
  const countEl = els.keyStatus.querySelector('.key-count');
  countEl.textContent = keys.length === 0
    ? '0 keys configured'
    : `${keys.length} key${keys.length > 1 ? 's' : ''} configured (rotation ${keys.length > 1 ? 'enabled' : 'disabled'})`;
}

/* ── API Key Management ───────────────────────── */
let keyVisibility = false;

function getApiKeysArray() {
  return (state.apiKeys || '').split(',').map((k) => k.trim()).filter(Boolean);
}

function syncApiKeysFromUI() {
  const inputs = els.apiKeyList.querySelectorAll('.api-key-row-input');
  const keys = Array.from(inputs).map((inp) => inp.value.trim()).filter(Boolean);
  state.apiKeys = keys.join(',');
  updateKeyCount();
  saveState();
}

function createKeyRow(value = '') {
  const row = document.createElement('div');
  row.className = 'api-key-row';

  const input = document.createElement('input');
  input.type = keyVisibility ? 'text' : 'password';
  input.className = 'api-key-row-input';
  input.placeholder = 'Paste API key here...';
  input.value = value;
  input.spellcheck = false;
  input.autocomplete = 'off';

  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(syncApiKeysFromUI, 400);
  });

  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove-key-btn';
  removeBtn.title = 'Remove this key';
  removeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  removeBtn.addEventListener('click', () => {
    row.remove();
    syncApiKeysFromUI();
    // If no rows left, add an empty one
    if (els.apiKeyList.children.length === 0) {
      els.apiKeyList.appendChild(createKeyRow());
    }
  });

  row.appendChild(input);
  row.appendChild(removeBtn);
  return row;
}

function renderApiKeyRows() {
  els.apiKeyList.innerHTML = '';
  const keys = getApiKeysArray();
  if (keys.length === 0) {
    // Always show at least one empty input
    els.apiKeyList.appendChild(createKeyRow());
  } else {
    keys.forEach((key) => {
      els.apiKeyList.appendChild(createKeyRow(key));
    });
  }
}

/* ── WebGPU Check ─────────────────────────────── */
async function checkWebGPU() {
  const statusEl = els.webgpuStatus;
  const warningEl = els.systemWarning;

  if (typeof navigator.gpu === 'undefined') {
    statusEl.innerHTML = '<div class="status-icon">❌</div><span>WebGPU not supported in this browser</span>';
    statusEl.className = 'webgpu-status unsupported';
    warningEl.classList.remove('hidden');
    els.downloadModelBtn.disabled = true;
    return;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No adapter');
    statusEl.innerHTML = '<div class="status-icon">✅</div><span>WebGPU supported — Ready</span>';
    statusEl.className = 'webgpu-status supported';
    warningEl.classList.add('hidden');
    els.downloadModelBtn.disabled = false;
  } catch {
    statusEl.innerHTML = '<div class="status-icon">⚠️</div><span>WebGPU adapter unavailable</span>';
    statusEl.className = 'webgpu-status unsupported';
    warningEl.classList.remove('hidden');
    els.downloadModelBtn.disabled = true;
  }
}

/* ── Event Listeners ──────────────────────────── */
function bindEvents() {
  // Master toggle (Session-only execution)
  els.masterToggle.addEventListener('change', async () => {
    state.enabled = els.masterToggle.checked;
    updateStatusUI();

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    const tabId = tab?.id;
    const isYouTube = tab?.url?.includes('youtube.com/watch') || tab?.url?.includes('youtube.com/live');
    
    // Mask API key for logging
    const keys = getApiKeysArray();
    const maskedKey = keys.length > 0 ? `${keys[0].substring(0, 8)}...****` : 'NONE';
    console.log(`[BabelLive-Popup] Master Toggle Clicked! -> Tab ID: ${tabId} | isYouTube: ${isYouTube} | API Key: ${maskedKey}`);

    if (state.enabled) {
      await chrome.storage.session.set({
        [SESSION_KEY]: { isRunning: true, activeTabId: tabId },
      }).catch(() => { });

      console.log(`[BabelLive-Popup] Dispatching START_BABEL_SESSION to Service Worker for Tab ${tabId}...`);
      chrome.runtime.sendMessage({
        action: 'START_LIVE_SESSION',
        type: 'BABELLIVE_START',
        tabId,
        settings: state
      }, () => { if (chrome.runtime.lastError) { } });
    } else {
      await chrome.storage.session.set({
        [SESSION_KEY]: { isRunning: false, activeTabId: null },
      }).catch(() => { });

      console.log(`[BabelLive-Popup] Dispatching STOP_LIVE_SESSION to Service Worker for Tab ${tabId}...`);
      chrome.runtime.sendMessage({
        action: 'STOP_LIVE_SESSION',
        type: 'BABELLIVE_STOP',
        tabId,
      }, () => { if (chrome.runtime.lastError) { } });
    }
  });

  // Language selects
  els.sourceLang.addEventListener('change', () => {
    state.sourceLang = els.sourceLang.value;
    saveState();
  });

  els.targetLang.addEventListener('change', () => {
    state.targetLang = els.targetLang.value;
    saveState();
  });

  // Swap languages
  els.swapLangs.addEventListener('click', () => {
    const src = state.sourceLang;
    const tgt = state.targetLang;
    if (src === 'auto') return; // Can't swap auto-detect
    state.sourceLang = tgt;
    state.targetLang = src;
    els.sourceLang.value = state.sourceLang;
    els.targetLang.value = state.targetLang;
    // Swap animation
    els.swapLangs.style.transform = 'rotate(180deg) scale(1.05)';
    setTimeout(() => { els.swapLangs.style.transform = ''; }, 300);
    saveState();
  });

  // Style presets
  els.presetBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.subtitlePreset = btn.dataset.preset;
      els.presetBtns.forEach((b) => b.classList.toggle('active', b === btn));
      saveState();
    });
  });

  // Font size slider
  els.fontSizeSlider.addEventListener('input', () => {
    state.fontSize = parseInt(els.fontSizeSlider.value, 10);
    els.fontSizeValue.textContent = `${state.fontSize}px`;
    saveState();
  });

  // Bilingual toggle
  els.bilingualToggle.addEventListener('change', () => {
    state.bilingual = els.bilingualToggle.checked;
    saveState();
  });

  // Engine radio buttons
  els.engineRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      state.engine = radio.value;
      showEngineSettings(state.engine);
      updateStatusUI();
      saveState();
    });
  });

  // Cloud provider
  els.cloudProvider.addEventListener('change', () => {
    state.cloudProvider = els.cloudProvider.value;
    updateStatusUI();
    saveState();
  });

  // Add key button
  els.addKeyBtn.addEventListener('click', () => {
    els.apiKeyList.appendChild(createKeyRow());
    // Focus the new input
    const inputs = els.apiKeyList.querySelectorAll('.api-key-row-input');
    inputs[inputs.length - 1].focus();
  });

  // Toggle key visibility
  els.toggleKeyVis.addEventListener('click', () => {
    keyVisibility = !keyVisibility;
    const inputs = els.apiKeyList.querySelectorAll('.api-key-row-input');
    inputs.forEach((inp) => {
      inp.type = keyVisibility ? 'text' : 'password';
    });
  });

  // Demo mode toggle
  els.demoToggle.addEventListener('change', () => {
    state.demoMode = els.demoToggle.checked;
    saveState();
    if (state.demoMode) {
      ensureTabConnected();
    }
  });

  // Download model button (placeholder)
  els.downloadModelBtn.addEventListener('click', async () => {
    els.downloadModelBtn.disabled = true;
    els.downloadModelBtn.textContent = 'Downloading...';
    els.downloadProgress.classList.remove('hidden');

    // Simulate download progress
    let progress = 0;
    const interval = setInterval(() => {
      progress += Math.random() * 8 + 2;
      if (progress >= 100) {
        progress = 100;
        clearInterval(interval);
        els.downloadModelBtn.textContent = 'Model Ready ✓';
        els.downloadModelBtn.style.background = 'linear-gradient(135deg, #22c55e, #06b6d4)';
      }
      els.progressFill.style.width = `${progress}%`;
      els.progressText.textContent = `${Math.round(progress)}%`;
    }, 200);
  });
}

/* ── Tab & Session Watchers ───────────────────── */
function setupTabWatchers() {
  // Listen for session storage changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[SESSION_KEY]) {
      const newSession = changes[SESSION_KEY].newValue;
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) return;
        const activeId = tabs[0]?.id;
        const isRunning = newSession?.isRunning === true && (newSession.activeTabId == null || newSession.activeTabId === activeId);
        state.enabled = Boolean(isRunning);
        els.masterToggle.checked = state.enabled;
        updateStatusUI();
      });
    }
  });

  // Listen for runtime messages (e.g. STT errors)
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'BABELLIVE_CAPTURE_ERROR') {
      state.enabled = false;
      els.masterToggle.checked = false;
      els.statusDot.className = 'status-dot idle';
      els.statusDot.style.background = '#ef4444'; // Red error dot
      els.statusDot.style.boxShadow = '0 0 8px rgba(239, 68, 68, 0.5)';
      els.statusText.textContent = `Error: ${message.error}`;
      // Also update session to stop
      chrome.storage.session.set({
        [SESSION_KEY]: { isRunning: false, activeTabId: null },
      }).catch(() => { });
    }
  });
}

/* ── Init ─────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[BabelLive-Popup] DOM loaded, initializing popup...');
  await loadState();
  applyStateToUI();
  bindEvents();
  setupTabWatchers();
  checkWebGPU();
  ensureTabConnected();
});
