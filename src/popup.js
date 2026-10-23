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
  colabUrl: '',
  colabNotebookUrl: '',
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
  colabSettings: $('#colabSettings'),
  colabNotebookUrl: $('#colabNotebookUrl'),
  oneClickStartBtn: $('#oneClickStartBtn'),
  oneClickBtnText: $('#oneClickBtnText'),
  colabUrl: $('#colabUrl'),
  testColabBtn: $('#testColabBtn'),
  colabStatus: $('#colabStatus'),
  colabStatusText: $('#colabStatusText'),
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
            target: { tabId: tab.id, allFrames: false },
            files: ['content.js'],
          });
          await chrome.scripting.insertCSS({
            target: { tabId: tab.id, allFrames: false },
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

  // Colab
  if (els.colabUrl) els.colabUrl.value = state.colabUrl || '';
  if (els.colabNotebookUrl) els.colabNotebookUrl.value = state.colabNotebookUrl || '';

  // Demo
  els.demoToggle.checked = state.demoMode;
}

function updateStatusUI() {
  const dot = els.statusDot;
  dot.className = 'status-dot';
  if (state.enabled) {
    dot.classList.add('connected');
    els.statusText.textContent = `AI Engine: Connected — Colab Server`;
  } else {
    dot.classList.add('idle');
    els.statusText.textContent = 'Idle — Click toggle to start';
  }
}

function formatColabUrl(val) {
  let url = (val || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  if (url.startsWith('http://')) url = url.replace('http://', 'ws://');
  else if (url.startsWith('https://')) url = url.replace('https://', 'wss://');
  else if (!url.startsWith('ws://') && !url.startsWith('wss://')) url = 'wss://' + url;
  if (!url.endsWith('/ws/live')) url = url + '/ws/live';
  return url;
}

function probeWebSocket(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    try {
      const formatted = formatColabUrl(url);
      if (!formatted) return resolve(false);
      const ws = new WebSocket(formatted);
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        resolve(false);
      }, timeoutMs);

      ws.onopen = () => {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(true);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    } catch {
      resolve(false);
    }
  });
}

/* ── Colab Connection Test ──────────────────── */
async function testColabConnection() {
  const url = formatColabUrl(els.colabUrl?.value);
  if (!url) {
    if (els.colabStatusText) els.colabStatusText.textContent = 'Please enter a valid WebSocket URL';
    return;
  }

  const dot = els.colabStatus?.querySelector('.status-dot');
  if (els.colabStatusText) els.colabStatusText.textContent = 'Testing connection...';
  if (dot) dot.className = 'status-dot starting';

  const isLive = await probeWebSocket(url, 2500);
  if (isLive) {
    if (dot) dot.className = 'status-dot running';
    if (els.colabStatusText) {
      els.colabStatusText.textContent = 'Connected to WebSocket backend.';
      els.colabStatusText.style.color = 'var(--text-color)';
    }
  } else {
    if (dot) dot.className = 'status-dot error';
    if (els.colabStatusText) els.colabStatusText.textContent = 'Failed to connect to WebSocket endpoint.';
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
    
    // Mask URL for logging
    const urlMasked = state.colabUrl ? `${state.colabUrl.substring(0, 15)}...` : 'NONE';
    console.log(`[BabelLive-Popup] Master Toggle Clicked! -> Tab ID: ${tabId} | isYouTube: ${isYouTube} | URL: ${urlMasked}`);

    if (state.enabled) {
      // If WebSocket URL is missing but notebook link is available, trigger automated launch
      if (!state.colabUrl && state.colabNotebookUrl) {
        await handleOneClickStart();
        return;
      }
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



  // Demo mode toggle
  els.demoToggle.addEventListener('change', () => {
    state.demoMode = els.demoToggle.checked;
    saveState();
    if (state.demoMode) {
      ensureTabConnected();
    }
  });

  // Launch backend and initiate live subtitles
  async function handleOneClickStart() {
    state.colabNotebookUrl = (els.colabNotebookUrl?.value || '').trim();
    state.colabUrl = formatColabUrl(els.colabUrl?.value);
    saveState();

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    const tabId = tab?.id;
    const dot = els.colabStatus?.querySelector('.status-dot');
    const btnText = els.oneClickBtnText;

    // 1. If WebSocket URL is present, verify backend availability
    if (state.colabUrl) {
      if (btnText) btnText.textContent = 'Testing server connection...';
      if (els.colabStatusText) els.colabStatusText.textContent = 'Verifying WebSocket endpoint...';
      if (dot) dot.className = 'status-dot starting';

      const isLive = await probeWebSocket(state.colabUrl, 1800);
      if (isLive) {
        if (dot) dot.className = 'status-dot running';
        if (els.colabStatusText) {
          els.colabStatusText.textContent = 'Connected to AI backend.';
          els.colabStatusText.style.color = 'var(--text-color)';
        }
        if (btnText) btnText.textContent = 'Subtitles Active';
        state.enabled = true;
        els.masterToggle.checked = true;
        updateStatusUI();

        await chrome.storage.session.set({
          [SESSION_KEY]: { isRunning: true, activeTabId: tabId },
        }).catch(() => {});

        chrome.runtime.sendMessage({
          action: 'START_LIVE_SESSION',
          type: 'BABELLIVE_START',
          tabId,
          settings: state
        });
        return;
      }
    }

    // 2. If endpoint is not active yet, launch notebook tab with autorun parameter
    if (state.colabNotebookUrl) {
      if (btnText) btnText.textContent = 'Launching Colab environment...';
      if (els.colabStatusText) {
        els.colabStatusText.textContent = 'Opening Colab notebook...';
        els.colabStatusText.style.color = '#f59e0b';
      }
      if (dot) dot.className = 'status-dot starting';

      let url = state.colabNotebookUrl;
      const separator = url.includes('?') ? '&' : '?';
      url = url + separator + 'babellive_autorun=true&source_tab=' + tabId;
      chrome.tabs.create({ url: url, active: true });
      return;
    }

    // 3. Fallback when neither URL is configured
    alert('Please enter your Google Colab Notebook URL or a WebSocket endpoint to proceed.');
  }

  els.testColabBtn?.addEventListener('click', testColabConnection);

  els.colabUrl?.addEventListener('change', () => {
    state.colabUrl = formatColabUrl(els.colabUrl.value);
    if (els.colabUrl.value !== state.colabUrl) els.colabUrl.value = state.colabUrl;
    saveState();
  });
  els.colabUrl?.addEventListener('blur', () => {
    state.colabUrl = formatColabUrl(els.colabUrl.value);
    if (els.colabUrl.value !== state.colabUrl) els.colabUrl.value = state.colabUrl;
    saveState();
  });

  els.colabNotebookUrl?.addEventListener('change', () => {
    state.colabNotebookUrl = (els.colabNotebookUrl.value || '').trim();
    saveState();
  });
  els.colabNotebookUrl?.addEventListener('blur', () => {
    state.colabNotebookUrl = (els.colabNotebookUrl.value || '').trim();
    saveState();
  });

  els.oneClickStartBtn?.addEventListener('click', handleOneClickStart);
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

  // Listen for runtime messages (e.g. STT errors, Colab ready)
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'BABELLIVE_COLAB_STATUS_UPDATE' || message.action === 'BABELLIVE_COLAB_READY') {
      if (message.colabUrl) {
        state.colabUrl = message.colabUrl;
        if (els.colabUrl) els.colabUrl.value = message.colabUrl;
      }
      state.enabled = true;
      if (els.masterToggle) els.masterToggle.checked = true;
      if (els.oneClickBtnText) els.oneClickBtnText.textContent = 'Subtitles Active';
      if (els.colabStatusText) {
        els.colabStatusText.textContent = 'Connected to AI backend.';
        els.colabStatusText.style.color = 'var(--text-color)';
      }
      const dot = els.colabStatus?.querySelector('.status-dot');
      if (dot) dot.className = 'status-dot running';
      updateStatusUI();
    }

    if (message.type === 'BABELLIVE_CAPTURE_ERROR') {
      state.enabled = false;
      els.masterToggle.checked = false;
      if (els.oneClickBtnText) els.oneClickBtnText.textContent = 'Launch & Start Subtitles';
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

/* ── Init ─────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[BabelLive-Popup] DOM loaded, initializing popup...');
  await loadState();
  applyStateToUI();
  bindEvents();
  setupTabWatchers();
  ensureTabConnected();
});
