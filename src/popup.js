/**
 * BabelLive Popup — Minimalist Studio Controller
 * Synchronizes user preferences with chrome.storage.local, manages runtime
 * session state via chrome.storage.session, and probes WebSocket endpoints.
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

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  masterToggle: $('#masterToggle'),
  livePill: $('#livePill'),
  livePillText: $('#livePillText'),
  statusBar: $('#statusBar'),
  statusDot: $('#statusDot'),
  statusText: $('#statusText'),
  sourceLang: $('#sourceLang'),
  targetLang: $('#targetLang'),
  swapLangs: $('#swapLangs'),
  presetBtns: $$('.preset-btn'),
  fontSizeSlider: $('#fontSizeSlider'),
  fontSizeValue: $('#fontSizeValue'),
  bilingualToggle: $('#bilingualToggle'),
  demoToggle: $('#demoToggle'),
  colabUrl: $('#colabUrl'),
  testColabBtn: $('#testColabBtn'),
  colabDrawer: $('#colabDrawer'),
  colabNotebookUrl: $('#colabNotebookUrl'),
  oneClickStartBtn: $('#oneClickStartBtn'),
  oneClickBtnText: $('#oneClickBtnText'),
  colabStatus: $('#colabStatus'),
  colabStatusText: $('#colabStatusText'),
};

let state = { ...DEFAULTS };
let isYouTubeTab = false;

/* ── Persistence ───────────────────────────────── */
async function loadState() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    if (result[STORAGE_KEY]) {
      const { enabled, ...prefs } = result[STORAGE_KEY];
      state = { ...DEFAULTS, ...prefs, enabled: false };
    }

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    const sessionData = await chrome.storage.session.get(SESSION_KEY).catch(() => ({}));
    const session = sessionData?.[SESSION_KEY];
    const isRunning =
      session?.isRunning === true &&
      (session.activeTabId == null || session.activeTabId === activeTab?.id);
    state.enabled = Boolean(isRunning);
  } catch (e) {
    console.warn('[BabelLive Popup] loadState error:', e);
  }
}

async function saveState() {
  try {
    const { enabled, ...prefs } = state;
    await chrome.storage.local.set({ [STORAGE_KEY]: { ...prefs, enabled: false } });
    broadcastSettings();
  } catch (e) {
    console.warn('[BabelLive Popup] saveState error:', e);
  }
}

/* ── Safe Tab Messaging ────────────────────────── */
function safeSendMessageToTab(tabId, message, callback) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, message, (response) => {
    if (chrome.runtime.lastError) {
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
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
      isYouTubeTab = false;
      updateStatusUI();
      return;
    }

    isYouTubeTab = tab.url.includes('youtube.com/watch') || tab.url.includes('youtube.com/live');
    updateStatusUI();

    if (!isYouTubeTab) return;

    return new Promise((resolve) => {
      safeSendMessageToTab(tab.id, { type: 'BABELLIVE_PING' }, async (res) => {
        if (res?.ok) {
          broadcastSettings();
          resolve();
          return;
        }
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
          }, 120);
        } catch {
          resolve();
        }
      });
    });
  } catch {}
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
  chrome.runtime.sendMessage(
    {
      type: 'BABELLIVE_SETTINGS_UPDATE',
      settings: state,
    },
    () => {
      if (chrome.runtime.lastError) {}
    }
  );
}

/* ── UI Synchronization ────────────────────────── */
function updateSliderFill() {
  const min = Number(els.fontSizeSlider.min) || 14;
  const max = Number(els.fontSizeSlider.max) || 36;
  const val = Number(els.fontSizeSlider.value) || 22;
  const pct = Math.round(((val - min) / (max - min)) * 100);
  els.fontSizeSlider.style.setProperty('--slider-pct', `${pct}%`);
}

function updateSwapButtonState() {
  if (els.swapLangs) {
    els.swapLangs.disabled = state.sourceLang === 'auto';
  }
}

function applyStateToUI() {
  els.masterToggle.checked = state.enabled;

  els.sourceLang.value = state.sourceLang;
  els.targetLang.value = state.targetLang;
  updateSwapButtonState();

  els.presetBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.preset === state.subtitlePreset);
  });

  els.fontSizeSlider.value = state.fontSize;
  els.fontSizeValue.textContent = `${state.fontSize}px`;
  updateSliderFill();

  els.bilingualToggle.checked = state.bilingual;
  els.demoToggle.checked = state.demoMode;

  if (els.colabUrl) els.colabUrl.value = state.colabUrl || '';
  if (els.colabNotebookUrl) els.colabNotebookUrl.value = state.colabNotebookUrl || '';

  // Auto-open Colab drawer if user has a Colab notebook configured but no direct WS URL
  if (els.colabDrawer && state.colabNotebookUrl && !state.colabUrl) {
    els.colabDrawer.open = true;
  }

  updateStatusUI();
}

function setBannerState(mode, message) {
  els.statusDot.className = `status-dot ${mode}`;
  els.statusText.textContent = message;
}

function setEndpointStatus(mode, text) {
  const dot = els.colabStatus?.querySelector('.status-dot');
  if (dot) dot.className = `status-dot ${mode}`;
  if (els.colabStatusText) els.colabStatusText.textContent = text;
}

function updateStatusUI() {
  if (!isYouTubeTab) {
    els.masterToggle.disabled = true;
    els.masterToggle.checked = false;
    els.livePill.dataset.state = 'idle';
    els.livePillText.textContent = 'STANDBY';
    setBannerState('idle', 'Open a YouTube video or livestream to start');
    els.oneClickStartBtn.classList.remove('is-active');
    els.oneClickBtnText.textContent = 'Connect & Start Subtitles';
    return;
  }

  els.masterToggle.disabled = false;

  if (state.enabled) {
    els.livePill.dataset.state = 'live';
    els.livePillText.textContent = 'LIVE';
    setBannerState('connected', 'Streaming live audio to AI backend');
    setEndpointStatus('running', 'Connected');
    els.oneClickStartBtn.classList.add('is-active');
    els.oneClickBtnText.textContent = 'Subtitles Active';
  } else {
    els.livePill.dataset.state = 'idle';
    els.livePillText.textContent = 'IDLE';
    setBannerState('idle', 'Ready on YouTube — toggle switch to start');
    els.oneClickStartBtn.classList.remove('is-active');
    els.oneClickBtnText.textContent = 'Connect & Start Subtitles';
    if (state.colabUrl) {
      setEndpointStatus('idle', 'Configured');
    } else {
      setEndpointStatus('idle', 'Not configured');
    }
  }
}

/* ── Endpoint Formatting & Probing ─────────────── */
function formatColabUrl(val) {
  let url = (val || '').trim().split('?')[0].replace(/\/+$/, '');
  if (!url) return '';
  if (url.startsWith('http://')) url = url.replace('http://', 'ws://');
  else if (url.startsWith('https://')) url = url.replace('https://', 'wss://');
  else if (!url.startsWith('ws://') && !url.startsWith('wss://')) url = 'wss://' + url;
  if (!url.endsWith('/ws/live')) url += '/ws/live';
  return url;
}

function probeWebSocket(url, timeoutMs = 2400) {
  return new Promise((resolve) => {
    try {
      const formatted = formatColabUrl(url);
      if (!formatted) return resolve(false);
      const ws = new WebSocket(formatted);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        resolve(false);
      }, timeoutMs);

      ws.onopen = () => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {}
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

async function testColabConnection() {
  const formatted = formatColabUrl(els.colabUrl?.value);
  if (!formatted) {
    setEndpointStatus('error', 'Enter a valid wss:// URL');
    els.colabUrl?.focus();
    return false;
  }

  els.colabUrl.value = formatted;
  state.colabUrl = formatted;
  saveState();

  setEndpointStatus('starting', 'Probing...');
  const isLive = await probeWebSocket(formatted, 2500);
  if (isLive) {
    setEndpointStatus('running', 'Endpoint online');
    return true;
  } else {
    setEndpointStatus('error', 'Unreachable');
    return false;
  }
}

/* ── Event Bindings ────────────────────────────── */
function bindEvents() {
  els.masterToggle.addEventListener('change', async () => {
    state.enabled = els.masterToggle.checked;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    const tabId = tab?.id;

    if (state.enabled) {
      if (!state.colabUrl && !state.colabNotebookUrl) {
        state.enabled = false;
        els.masterToggle.checked = false;
        setEndpointStatus('error', 'Endpoint required');
        setBannerState('error', 'Enter a WebSocket URL or Colab link below');
        els.colabUrl?.focus();
        return;
      }

      if (!state.colabUrl && state.colabNotebookUrl) {
        await handleOneClickStart();
        return;
      }

      updateStatusUI();
      chrome.runtime.sendMessage(
        {
          action: 'START_LIVE_SESSION',
          type: 'BABELLIVE_START',
          tabId,
          settings: state,
        },
        () => {
          if (chrome.runtime.lastError) {}
        }
      );
    } else {
      updateStatusUI();
      chrome.runtime.sendMessage(
        {
          action: 'STOP_LIVE_SESSION',
          type: 'BABELLIVE_STOP',
          tabId,
        },
        () => {
          if (chrome.runtime.lastError) {}
        }
      );
    }
  });

  els.sourceLang.addEventListener('change', () => {
    state.sourceLang = els.sourceLang.value;
    updateSwapButtonState();
    saveState();
  });

  els.targetLang.addEventListener('change', () => {
    state.targetLang = els.targetLang.value;
    saveState();
  });

  els.swapLangs.addEventListener('click', () => {
    if (state.sourceLang === 'auto') return;
    const prevSource = state.sourceLang;
    state.sourceLang = state.targetLang;
    state.targetLang = prevSource;
    els.sourceLang.value = state.sourceLang;
    els.targetLang.value = state.targetLang;
    updateSwapButtonState();
    saveState();
  });

  els.presetBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.subtitlePreset = btn.dataset.preset;
      els.presetBtns.forEach((b) => b.classList.toggle('active', b === btn));
      saveState();
    });
  });

  els.fontSizeSlider.addEventListener('input', () => {
    state.fontSize = parseInt(els.fontSizeSlider.value, 10);
    els.fontSizeValue.textContent = `${state.fontSize}px`;
    updateSliderFill();
    saveState();
  });

  els.bilingualToggle.addEventListener('change', () => {
    state.bilingual = els.bilingualToggle.checked;
    saveState();
  });

  els.demoToggle.addEventListener('change', () => {
    state.demoMode = els.demoToggle.checked;
    saveState();
    if (state.demoMode) {
      ensureTabConnected();
    }
  });

  async function handleOneClickStart() {
    state.colabNotebookUrl = (els.colabNotebookUrl?.value || '').trim();
    state.colabUrl = formatColabUrl(els.colabUrl?.value);
    if (els.colabUrl && state.colabUrl) els.colabUrl.value = state.colabUrl;
    saveState();

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    const tabId = tab?.id;

    // 1. If WebSocket URL is present, verify and start session
    if (state.colabUrl) {
      els.oneClickBtnText.textContent = 'Connecting...';
      setEndpointStatus('starting', 'Connecting...');

      const isLive = await probeWebSocket(state.colabUrl, 2200);
      if (isLive) {
        if (!isYouTubeTab) {
          setEndpointStatus('running', 'Endpoint online');
          setBannerState('idle', 'Endpoint verified — open a YouTube video to start');
          els.oneClickBtnText.textContent = 'Endpoint Ready';
          return;
        }

        state.enabled = true;
        els.masterToggle.checked = true;
        updateStatusUI();

        chrome.runtime.sendMessage({
          action: 'START_LIVE_SESSION',
          type: 'BABELLIVE_START',
          tabId,
          settings: state,
        });
        return;
      }

      if (!state.colabNotebookUrl) {
        setEndpointStatus('error', 'Offline');
        setBannerState('error', 'Could not reach WebSocket endpoint');
        els.oneClickBtnText.textContent = 'Retry Connection';
        return;
      }
    }

    // 2. Launch Colab Notebook with autorun parameters
    if (state.colabNotebookUrl) {
      els.oneClickBtnText.textContent = 'Launching Colab...';
      setEndpointStatus('starting', 'Starting Colab...');
      setBannerState('starting', 'Opening Google Colab auto-runner...');

      const separator = state.colabNotebookUrl.includes('?') ? '&' : '?';
      const targetUrl = `${state.colabNotebookUrl}${separator}babellive_autorun=true&source_tab=${tabId || ''}`;
      chrome.tabs.create({ url: targetUrl, active: true });
      return;
    }

    // 3. Inline validation feedback (no alert dialog)
    setEndpointStatus('error', 'Missing URL');
    setBannerState('error', 'Provide a WebSocket URL or Colab Notebook link');
    els.colabUrl?.focus();
  }

  els.testColabBtn?.addEventListener('click', testColabConnection);

  els.colabUrl?.addEventListener('change', () => {
    state.colabUrl = formatColabUrl(els.colabUrl.value);
    if (els.colabUrl.value !== state.colabUrl) els.colabUrl.value = state.colabUrl;
    saveState();
  });

  els.colabNotebookUrl?.addEventListener('change', () => {
    state.colabNotebookUrl = (els.colabNotebookUrl.value || '').trim();
    saveState();
  });

  els.oneClickStartBtn?.addEventListener('click', handleOneClickStart);
}

/* ── Runtime & Session Watchers ────────────────── */
function setupWatchers() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[SESSION_KEY]) {
      const newSession = changes[SESSION_KEY].newValue;
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) return;
        const activeId = tabs[0]?.id;
        const isRunning =
          newSession?.isRunning === true &&
          (newSession.activeTabId == null || newSession.activeTabId === activeId);
        state.enabled = Boolean(isRunning);
        els.masterToggle.checked = state.enabled;
        updateStatusUI();
      });
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (
      message.type === 'BABELLIVE_COLAB_STATUS_UPDATE' ||
      message.action === 'BABELLIVE_COLAB_READY'
    ) {
      if (message.colabUrl) {
        state.colabUrl = message.colabUrl;
        if (els.colabUrl) els.colabUrl.value = message.colabUrl;
      }
      state.enabled = true;
      if (els.masterToggle) els.masterToggle.checked = true;
      updateStatusUI();
    }

    if (message.type === 'BABELLIVE_CAPTURE_ERROR') {
      state.enabled = false;
      els.masterToggle.checked = false;
      updateStatusUI();
      setEndpointStatus('error', 'Connection error');
      setBannerState('error', message.error || 'Audio capture failed');
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadState();
  await ensureTabConnected();
  applyStateToUI();
  bindEvents();
  setupWatchers();
});
