/**
 * BabelLive — Service Worker (Background)
 * Coordinates tab audio capture lifecycle, offscreen WebSocket worker,
 * Colab/Modal keep-alive pings, and message routing to content scripts.
 */

if (chrome.storage?.session?.setAccessLevel) {
  chrome.storage.session
    .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .catch(() => {});
}

const MSG = {
  start: 'BABELLIVE_START',
  stop: 'BABELLIVE_STOP',
  settingsUpdate: 'BABELLIVE_SETTINGS_UPDATE',
  subtitle: 'BABELLIVE_SUBTITLE',
  subtitleBroadcast: 'BABELLIVE_SUBTITLE_BROADCAST',
  clear: 'BABELLIVE_CLEAR',
  startCapture: 'BABELLIVE_START_CAPTURE',
  stopCapture: 'BABELLIVE_STOP_CAPTURE',
  captureReady: 'BABELLIVE_CAPTURE_READY',
  captureError: 'BABELLIVE_CAPTURE_ERROR',
  captureEnded: 'BABELLIVE_CAPTURE_ENDED',
};

const STORAGE_KEY = 'babellive_settings';
const SESSION_KEY = 'babellive_session';
const OFFSCREEN_URL = 'offscreen.html';

const CaptureState = {
  idle: 'idle',
  starting: 'starting',
  running: 'running',
  stopping: 'stopping',
};

const tabStates = new Map(); // tabId -> { state, requestId }

function getTabState(tabId) {
  let s = tabStates.get(tabId);
  if (!s) {
    s = { state: CaptureState.idle, requestId: 0 };
    tabStates.set(tabId, s);
  }
  return s;
}

async function setSessionState(isRunning, activeTabId = null) {
  try {
    await chrome.storage.session.set({
      [SESSION_KEY]: { isRunning, activeTabId: isRunning ? activeTabId : null },
    });
  } catch {}
}

/* ── Backend Heartbeat ──────────────────────── */
let heartbeatInterval = null;

function resolveHealthPingUrl(rawUrl) {
  let u = (rawUrl || '').trim();
  if (!u) return '';
  u = u.split('?')[0].replace(/\/+$/, '');
  if (u.startsWith('wss://')) u = u.replace('wss://', 'https://');
  else if (u.startsWith('ws://')) u = u.replace('ws://', 'http://');
  else if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'https://' + u;
  u = u.replace(/\/ws\/live$/, '');
  return `${u}/ping`;
}

function startBackendHeartbeat(rawUrl) {
  stopBackendHeartbeat();
  const pingUrl = resolveHealthPingUrl(rawUrl);
  if (!pingUrl) return;

  const ping = async () => {
    try {
      await fetch(pingUrl, {
        method: 'GET',
        headers: { 'ngrok-skip-browser-warning': 'true' },
        signal: AbortSignal.timeout(5000),
      });
    } catch {}
  };

  ping();
  heartbeatInterval = setInterval(ping, 4 * 60 * 1000);
}

function stopBackendHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/* ── Offscreen Document Lifecycle ───────────── */
let offscreenCreating = null;

async function hasOffscreen() {
  if (typeof chrome.offscreen?.hasDocument === 'function') {
    return chrome.offscreen.hasDocument();
  }
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  if (typeof chrome.runtime?.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url],
    });
    return contexts.length > 0;
  }
  const clients = await self.clients.matchAll();
  return clients.some((c) => c.url === url);
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['USER_MEDIA'],
        justification: 'Capture tab audio for real-time AI subtitle translation',
      })
      .finally(() => {
        offscreenCreating = null;
      });
  }
  await offscreenCreating;
}

async function closeOffscreenIfIdle() {
  for (const s of tabStates.values()) {
    if (s.state !== CaptureState.idle) return;
  }
  try {
    if (await hasOffscreen()) {
      await chrome.offscreen.closeDocument();
    }
  } catch {}
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

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['content.js'],
    });
  } catch {}
}

function sendToTab(tabId, message) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, message, () => {
    if (chrome.runtime.lastError) {
      // Suppress error if tab navigated or closed
    }
  });
}

async function startCapture(tabId, settingsPayload) {
  const ts = getTabState(tabId);
  if (ts.state === CaptureState.running) {
    await setSessionState(true, tabId);
    sendToTab(tabId, { type: MSG.captureReady });
    return;
  }
  if (ts.state === CaptureState.starting || ts.state === CaptureState.stopping) {
    return;
  }

  ts.state = CaptureState.starting;
  const reqId = ++ts.requestId;

  try {
    const streamId = await getStreamId(tabId);
    if (ts.requestId !== reqId || ts.state !== CaptureState.starting) return;

    await ensureOffscreen();
    if (ts.requestId !== reqId || ts.state !== CaptureState.starting) return;

    let settings = settingsPayload;
    if (!settings) {
      const store = await chrome.storage.local.get(STORAGE_KEY);
      settings = store[STORAGE_KEY] || {};
    }

    if (settings.colabUrl) {
      startBackendHeartbeat(settings.colabUrl);
    }

    await setSessionState(true, tabId);

    const response = await chrome.runtime.sendMessage({
      type: MSG.startCapture,
      streamId,
      tabId,
      settings,
    });

    if (!response?.accepted) {
      throw new Error('Audio capture worker failed to accept start request.');
    }
  } catch (err) {
    if (ts.requestId !== reqId) return;
    ts.state = CaptureState.idle;
    await setSessionState(false, null);
    sendToTab(tabId, { type: MSG.captureError, error: err.message });
    chrome.runtime
      .sendMessage({ type: MSG.captureError, tabId, error: err.message })
      .catch(() => {});
  }
}

async function stopCapture(tabId) {
  const ts = getTabState(tabId);
  ts.requestId++;
  ts.state = CaptureState.stopping;

  stopBackendHeartbeat();
  await setSessionState(false, null);

  try {
    if (await hasOffscreen()) {
      await chrome.runtime.sendMessage({ type: MSG.stopCapture, tabId }).catch(() => {});
    }
  } catch {}

  ts.state = CaptureState.idle;
  tabStates.delete(tabId);
  sendToTab(tabId, { type: MSG.clear });
  await closeOffscreenIfIdle();
}

/* ── Message Router ─────────────────────────── */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const isTab = Boolean(sender.tab);

  // 1. Start Live Session
  if (message.type === MSG.start || message.action === 'START_LIVE_SESSION') {
    const startForTab = async (tid, settingsPayload) => {
      if (!tid) return;
      try {
        const tab = await chrome.tabs.get(tid);
        if (!tab.url || !tab.url.includes('youtube.com')) return;
        await injectContentScript(tid);
        await startCapture(tid, settingsPayload);
        sendToTab(tid, { type: MSG.start, action: 'START_LIVE_SESSION', settings: settingsPayload });
      } catch {}
    };

    if (message.tabId != null) {
      startForTab(message.tabId, message.settings);
    } else {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tid = tabs[0]?.id;
        if (tid) startForTab(tid, message.settings);
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  // 2. Stop Live Session
  if (message.type === MSG.stop || message.action === 'STOP_LIVE_SESSION') {
    const stopForTab = async (tid) => {
      if (!tid) return;
      try {
        await stopCapture(tid);
        sendToTab(tid, { type: MSG.stop, action: 'STOP_LIVE_SESSION' });
      } catch {}
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
    return false;
  }

  // 3. Settings Update (Broadcast to YouTube tabs + Offscreen worker)
  if (message.type === MSG.settingsUpdate) {
    chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
      tabs.forEach((t) => {
        if (t.id) sendToTab(t.id, message);
      });
    });
    sendResponse({ ok: true });
    return false;
  }

  // 4. Offscreen Worker Events
  if (!isTab && message.tabId != null) {
    const tid = message.tabId;
    switch (message.type) {
      case MSG.captureReady: {
        const ts = getTabState(tid);
        ts.state = CaptureState.running;
        setSessionState(true, tid);
        sendToTab(tid, { type: MSG.captureReady });
        break;
      }
      case MSG.captureError: {
        const ts = getTabState(tid);
        ts.state = CaptureState.idle;
        setSessionState(false, null);
        sendToTab(tid, { type: MSG.captureError, error: message.error });
        closeOffscreenIfIdle();
        break;
      }
      case MSG.captureEnded: {
        const ts = getTabState(tid);
        ts.state = CaptureState.idle;
        tabStates.delete(tid);
        setSessionState(false, null);
        sendToTab(tid, { type: MSG.captureEnded });
        closeOffscreenIfIdle();
        break;
      }
      case MSG.subtitle:
      case MSG.subtitleBroadcast: {
        sendToTab(tid, {
          type: MSG.subtitleBroadcast,
          original: message.original,
          translated: message.translated,
          isInterim: Boolean(message.isInterim),
        });
        break;
      }
    }
    return false;
  }

  // 5. Switch Tab from Colab Automator
  if (message.action === 'BABELLIVE_SWITCH_TAB' && message.tabId != null) {
    chrome.tabs.update(message.tabId, { active: true }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  // 6. Colab Automator Ready Callback
  if (message.action === 'BABELLIVE_COLAB_READY') {
    const wsUrl = message.wsUrl;
    let targetTabId = message.tabId;

    chrome.storage.local.get(STORAGE_KEY, async (res) => {
      const current = res?.[STORAGE_KEY] || {};
      const updated = { ...current, colabUrl: wsUrl, enabled: true };
      await chrome.storage.local.set({ [STORAGE_KEY]: updated });

      startBackendHeartbeat(wsUrl);

      chrome.runtime
        .sendMessage({
          type: 'BABELLIVE_COLAB_STATUS_UPDATE',
          status: 'connected',
          colabUrl: wsUrl,
          tabId: targetTabId,
        })
        .catch(() => {});

      if (targetTabId == null) {
        const ytTabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' }).catch(() => []);
        if (ytTabs?.length > 0) {
          targetTabId = ytTabs[0].id;
        }
      }

      if (targetTabId != null) {
        try {
          await chrome.tabs.update(targetTabId, { active: true });
        } catch {}

        await setSessionState(true, targetTabId);

        try {
          await injectContentScript(targetTabId);
          await startCapture(targetTabId, updated);
          sendToTab(targetTabId, {
            type: MSG.start,
            action: 'START_LIVE_SESSION',
            settings: updated,
          });
        } catch {}
      }
    });

    sendResponse({ ok: true });
    return false;
  }

  return false;
});

/* ── Tab Lifecycle Cleanup ──────────────────── */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    const ts = tabStates.get(tabId);
    if (ts && ts.state !== CaptureState.idle) {
      stopCapture(tabId);
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabStates.has(tabId)) {
    stopCapture(tabId);
  }
});

/* ── Install Handler ────────────────────────── */
chrome.runtime.onInstalled.addListener((details) => {
  setSessionState(false, null);

  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.storage.local.set({
      [STORAGE_KEY]: {
        enabled: false,
        sourceLang: 'ja',
        targetLang: 'vi',
        subtitlePreset: 'anime',
        fontSize: 22,
        bilingual: true,
        colabUrl: '',
        colabNotebookUrl: '',
        demoMode: false,
      },
    });
  }
});
