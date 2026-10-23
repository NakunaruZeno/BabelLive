/**
 * BabelLive — Service Worker (Background)
 * Message router between popup, content script, and offscreen document.
 * Manages tab audio capture lifecycle and translation pipeline.
 */




// Enable session storage access across trusted and untrusted contexts
if (chrome.storage?.session?.setAccessLevel) {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .catch((error) => console.warn('[BabelLive SW] setAccessLevel error:', error));
}

const MSG = {
  // Popup → SW
  start: 'BABELLIVE_START',
  stop: 'BABELLIVE_STOP',
  settingsUpdate: 'BABELLIVE_SETTINGS_UPDATE',

  // SW → Content
  subtitle: 'BABELLIVE_SUBTITLE',
  clear: 'BABELLIVE_CLEAR',

  // SW ↔ Offscreen (audio capture)
  startCapture: 'BABELLIVE_START_CAPTURE',
  stopCapture: 'BABELLIVE_STOP_CAPTURE',
  captureReady: 'BABELLIVE_CAPTURE_READY',
  captureError: 'BABELLIVE_CAPTURE_ERROR',
  captureEnded: 'BABELLIVE_CAPTURE_ENDED',
};

const STORAGE_KEY = 'babellive_settings';
const SESSION_KEY = 'babellive_session';
const OFFSCREEN_URL = 'offscreen.html';

/* ── State ──────────────────────────────────── */
const CaptureState = { idle: 'idle', starting: 'starting', running: 'running', stopping: 'stopping' };
const tabStates = new Map(); // tabId → { state, requestId }

function getTabState(tabId) {
  let s = tabStates.get(tabId);
  if (!s) { s = { state: CaptureState.idle, requestId: 0 }; tabStates.set(tabId, s); }
  return s;
}

/* ── Colab Heartbeat ──────────────────────── */
let heartbeatInterval = null;

function startColabHeartbeat(colabUrl) {
  stopColabHeartbeat();
  if (!colabUrl) return;

  // Ping immediately to verify connectivity
  fetch(`${colabUrl}/ping`, { 
    method: 'POST',
    signal: AbortSignal.timeout(5000)
  })
    .then(r => r.ok || r.status === 405 ? console.log('[BabelLive SW] Colab connected') : null)
    .catch(() => console.warn('[BabelLive SW] Colab unreachable'));

  // Ping every 4 minutes to keep Colab session alive
  heartbeatInterval = setInterval(async () => {
    try {
      const r = await fetch(`${colabUrl}/ping`, { 
        method: 'POST',
        signal: AbortSignal.timeout(5000)
      });
      if (!r.ok && r.status !== 405) throw new Error(`HTTP ${r.status}`);
    } catch {
      console.warn('[BabelLive SW] Colab heartbeat failed');
    }
  }, 4 * 60 * 1000);
}

function stopColabHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/* ── Offscreen Document ─────────────────────── */
let offscreenCreating = null;

async function hasOffscreen() {
  if (typeof chrome.offscreen?.hasDocument === 'function') {
    return chrome.offscreen.hasDocument();
  }
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  if (typeof chrome.runtime?.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    return contexts.length > 0;
  }
  const clients = await self.clients.matchAll();
  return clients.some((c) => c.url === url);
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: 'Capture tab audio for live translation',
    }).finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

async function closeOffscreenIfIdle() {
  for (const s of tabStates.values()) {
    if (s.state !== CaptureState.idle) return;
  }
  try {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  } catch (e) {
    console.warn('[BabelLive SW] close offscreen failed', e);
  }
}

/* ── Tab Capture ────────────────────────────── */
function getStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(streamId);
      }
    });
  });
}

async function startCapture(tabId, settingsPayload) {
  console.log(`[BabelLive-SW] startCapture called for tab: ${tabId}`);
  const ts = getTabState(tabId);
  if (ts.state === CaptureState.running) {
    console.log('[BabelLive-SW] Capture already running for tab:', tabId);
    sendToTab(tabId, { type: MSG.captureReady });
    return;
  }
  if (ts.state === CaptureState.starting || ts.state === CaptureState.stopping) {
    console.log('[BabelLive-SW] Capture in state:', ts.state, ', skipping');
    return;
  }

  ts.state = CaptureState.starting;
  const reqId = ++ts.requestId;

  try {
    console.log(`[BabelLive-SW] Getting stream ID via chrome.tabCapture...`);
    const streamId = await getStreamId(tabId);
    console.log(`[BabelLive-SW] Generated streamId: ${streamId?.slice(0, 20)}...`);
    if (ts.requestId !== reqId || ts.state !== CaptureState.starting) return;

    console.log(`[BabelLive-SW] Creating/verifying offscreen.html...`);
    await ensureOffscreen();
    console.log('[BabelLive-SW] Offscreen document ready');
    if (ts.requestId !== reqId || ts.state !== CaptureState.starting) return;

    let settings = settingsPayload;
    if (!settings) {
      const store = await chrome.storage.local.get(STORAGE_KEY);
      settings = store[STORAGE_KEY] || {};
    }

    // Start Colab heartbeat if URL configured
    if (settings.colabUrl) {
      startColabHeartbeat(settings.colabUrl);
    }

    console.log(`[BabelLive-SW] Forwarding session parameters to offscreen (Tab: ${tabId}, Stream: ${streamId?.slice(0, 10)}...)`);
    const response = await chrome.runtime.sendMessage({
      type: MSG.startCapture,
      streamId,
      tabId,
      settings
    });
    if (!response?.accepted) {
      throw new Error('The audio capture document did not accept the start request.');
    }
  } catch (err) {
    console.error('[BabelLive-SW ERROR] startCapture error:', err);
    if (ts.requestId !== reqId) return;
    ts.state = CaptureState.idle;
    sendToTab(tabId, { type: MSG.captureError, error: err.message });
  }
}

async function stopCapture(tabId) {
  const ts = getTabState(tabId);
  ts.requestId++;

  if (ts.state === CaptureState.idle) {
    try {
      if (await hasOffscreen()) {
        chrome.runtime.sendMessage({ type: MSG.stopCapture, tabId }).catch(() => { });
      }
    } catch { }
    sendToTab(tabId, { type: MSG.clear });
    return;
  }

  ts.state = CaptureState.stopping;
  stopColabHeartbeat();
  try {
    chrome.runtime.sendMessage({ type: MSG.stopCapture, tabId }).catch(() => { });
  } catch {
    ts.state = CaptureState.idle;
    sendToTab(tabId, { type: MSG.clear });
  }
}

/* ── Content Script Injection ───────────────── */
async function injectContentScript(tabId) {
  try {
    console.log(`[BabelLive-SW] Pinging/Injecting content.js into Tab ${tabId}...`);
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['content.js'],
    });
    console.log(`[BabelLive-SW] Successfully injected content.js`);
  } catch (err) {
    console.error('[BabelLive-SW ERROR] inject content.js failed', tabId, err);
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['fullscreen-bridge.js'],
      world: 'MAIN',
    });
    console.log(`[BabelLive-SW] Successfully injected fullscreen-bridge.js`);
  } catch (err) {
    console.error('[BabelLive-SW ERROR] inject fullscreen-bridge failed', tabId, err);
  }
}

/* ── Messaging ──────────────────────────────── */
function sendToTab(tabId, message) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, message, () => {
    // Reading chrome.runtime.lastError suppresses unchecked runtime error logs
    if (chrome.runtime.lastError) {
      // Intentionally ignored when tab is refreshing or unmounted
    }
  });
}

/* ── Language Names ──────────────────────────── */
const LANG_NAMES = {
  auto: 'the source language',
  ja: 'Japanese', en: 'English', zh: 'Chinese', ko: 'Korean',
  vi: 'Vietnamese', fr: 'French', de: 'German', es: 'Spanish',
  ru: 'Russian', th: 'Thai',
};


/* ── Message Listener ───────────────────────── */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const isTab = !!sender.tab;
  const tabId = sender.tab?.id;

  // Popup / UI → SW: Start Live Session
  if (message.type === MSG.start || message.action === 'START_LIVE_SESSION') {
    console.log(`[BabelLive-SW] Received START_BABEL_SESSION trigger for tab ${message.tabId || 'active'}`);
    const startForTab = async (tid, settingsPayload) => {
      if (tid) {
        try {
          const tab = await chrome.tabs.get(tid);
          if (!tab.url || !tab.url.includes('youtube.com')) {
            console.warn('[BabelLive-SW] Cannot start on non-YouTube URL:', tab.url);
            return;
          }
          await injectContentScript(tid);
          await startCapture(tid, settingsPayload);
          sendToTab(tid, { type: MSG.start, action: 'START_LIVE_SESSION' });
        } catch (e) {
          console.error('[BabelLive-SW ERROR] Failed to start tab:', e);
        }
      }
    };

    if (message.tabId != null) {
      startForTab(message.tabId, message.settings);
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const tid = tabs[0]?.id;
        if (tid) await startForTab(tid, message.settings);
      });
    }
    sendResponse({ ok: true });
    return true;
  }

  // Popup / UI → SW: Stop Live Session
  if (message.type === MSG.stop || message.action === 'STOP_LIVE_SESSION') {
    const stopForTab = async (tid) => {
      if (tid) {
        try {
          const tab = await chrome.tabs.get(tid);
          if (!tab.url || !tab.url.includes('youtube.com')) return;
          stopCapture(tid);
          sendToTab(tid, { type: MSG.stop, action: 'STOP_LIVE_SESSION' });
        } catch (e) { }
      }
    };

    if (message.tabId != null) {
      stopForTab(message.tabId);
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tid = tabs[0]?.id;
        if (tid) stopForTab(tid);
      });
    }
    sendResponse({ ok: true });
    return true;
  }

  // Popup → SW: Settings update (relay to content)
  if (message.type === MSG.settingsUpdate) {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((t) => {
        if (t.id) sendToTab(t.id, message);
      });
    });
    sendResponse({ ok: true });
    return false;
  }


  // Offscreen → SW: Capture events
  if (!isTab && message.tabId != null) {
    const tid = message.tabId;
    console.log('[BabelLive SW] Offscreen message:', message.type, 'for tab:', tid);
    switch (message.type) {
      case MSG.captureReady: {
        const ts = getTabState(tid);
        console.log('[BabelLive SW] Capture ready, state was:', ts.state);
        if (ts.state === CaptureState.starting) {
          ts.state = CaptureState.running;
          sendToTab(tid, { type: MSG.captureReady });
        }
        break;
      }
      case MSG.captureError: {
        console.error('[BabelLive SW] Capture error:', message.error);
        const ts = getTabState(tid);
        ts.state = CaptureState.idle;
        sendToTab(tid, { type: MSG.captureError, error: message.error });
        closeOffscreenIfIdle();
        break;
      }
      case MSG.captureEnded: {
        console.log('[BabelLive SW] Capture ended for tab:', tid);
        const ts = getTabState(tid);
        ts.state = CaptureState.idle;
        sendToTab(tid, { type: MSG.captureEnded });
        tabStates.delete(tid);
        closeOffscreenIfIdle();
        break;
      }
      case 'BABELLIVE_SUBTITLE':
      case 'BABELLIVE_SUBTITLE_BROADCAST': {
        // Relay subtitle from offscreen directly to the target tab
        sendToTab(tid, {
          type: 'BABELLIVE_SUBTITLE_BROADCAST',
          original: message.original,
          translated: message.translated,
          isInterim: message.isInterim || false,
        });
        break;
      }
    }
  }

  // Switch tab action triggered by Colab Automator
  if (message.action === 'BABELLIVE_SWITCH_TAB' && message.tabId != null) {
    chrome.tabs.update(message.tabId, { active: true }).catch(() => {});
    return true;
  }

  // Handle Colab Backend Ready auto-detected by Colab Automator
  if (message.action === 'BABELLIVE_COLAB_READY') {
    const wsUrl = message.wsUrl;
    const tabId = message.tabId;
    console.log('[BabelLive-SW] Colab Backend is READY! wsUrl:', wsUrl, 'tabId:', tabId);

    chrome.storage.local.get(STORAGE_KEY, async (res) => {
      const current = res?.[STORAGE_KEY] || {};
      const updated = { ...current, colabUrl: wsUrl, enabled: true };
      await chrome.storage.local.set({ [STORAGE_KEY]: updated });

      startColabHeartbeat(wsUrl);

      // Notify open popup or extension UI
      chrome.runtime.sendMessage({
        type: 'BABELLIVE_COLAB_STATUS_UPDATE',
        status: 'connected',
        colabUrl: wsUrl,
        tabId: tabId
      }).catch(() => {});

      if (tabId != null) {
        try {
          await chrome.tabs.update(tabId, { active: true });
        } catch { }

        await chrome.storage.session.set({
          [SESSION_KEY]: { isRunning: true, activeTabId: tabId },
        }).catch(() => {});

        try {
          await injectContentScript(tabId);
          await startCapture(tabId, updated);
          sendToTab(tabId, { type: MSG.start, action: 'START_LIVE_SESSION', settings: updated });
        } catch (err) {
          console.error('[BabelLive-SW ERROR] Failed to auto-start session after Colab ready:', err);
        }
      }
    });

    sendResponse({ ok: true });
    return true;
  }

  return true;
});

/* ── Tab Lifecycle & Session Reset ──────────── */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    const ts = getTabState(tabId);
    if (ts.state !== CaptureState.idle) {
      console.log('[BabelLive SW] Tab reloaded/navigated, stopping capture:', tabId);
      stopCapture(tabId);
      tabStates.delete(tabId);
    }
    // Check if reloading tab was active in session
    chrome.storage.session.get(SESSION_KEY, (res) => {
      if (chrome.runtime.lastError) return;
      const session = res?.[SESSION_KEY];
      if (session && (session.activeTabId === tabId || !session.activeTabId)) {
        console.log('[BabelLive SW] Resetting session on tab reload:', tabId);
        chrome.storage.session.set({
          [SESSION_KEY]: { isRunning: false, activeTabId: null },
        }).catch(() => { });
      }
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabStates.has(tabId)) {
    stopCapture(tabId);
    tabStates.delete(tabId);
  }
  chrome.storage.session.get(SESSION_KEY, (res) => {
    if (chrome.runtime.lastError) return;
    const session = res?.[SESSION_KEY];
    if (session && session.activeTabId === tabId) {
      chrome.storage.session.set({
        [SESSION_KEY]: { isRunning: false, activeTabId: null },
      }).catch(() => { });
    }
  });
});

/* ── Install handler ────────────────────────── */
chrome.runtime.onInstalled.addListener((details) => {
  // Clear any existing runtime session state on install/update
  chrome.storage.session.set({
    [SESSION_KEY]: { isRunning: false, activeTabId: null },
  }).catch(() => { });

  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    // Set default settings in persistent local storage
    chrome.storage.local.set({
      [STORAGE_KEY]: {
        enabled: false,
        sourceLang: 'ja',
        targetLang: 'vi',
        subtitlePreset: 'anime',
        fontSize: 22,
        bilingual: true,
        engine: 'cloud',
        cloudProvider: 'groq',
        apiKeys: '',
        colabUrl: '',
        demoMode: false,
      },
    });
  }
});

console.log('[BabelLive] Service worker initialized');
