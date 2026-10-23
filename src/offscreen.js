/**
 * BabelLive — Offscreen Document
 * Handles tab audio capture using getUserMedia + MediaRecorder.
 * Audio blobs are streamed continuously to the Colab WebSocket backend.
 * Receives JSON subtitles (interim/final) from WebSocket and broadcasts to content script.
 */

const MSG = {
  startCapture: 'BABELLIVE_START_CAPTURE',
  stopCapture: 'BABELLIVE_STOP_CAPTURE',
  captureReady: 'BABELLIVE_CAPTURE_READY',
  captureError: 'BABELLIVE_CAPTURE_ERROR',
  captureEnded: 'BABELLIVE_CAPTURE_ENDED',
};

const STORAGE_KEY = 'babellive_settings';
let sessionConfig = { sourceLang: 'ja', targetLang: 'vi', colabUrl: '' };

const sessions = new Map();

function sendToSW(message) {
  chrome.runtime.sendMessage(message).catch(() => { });
}

function createSession(tabId) {
  return {
    tabId,
    state: 'idle',
    opChain: Promise.resolve(),
    monitorAudioCtx: null,
    monitorGain: null,
    monitorSource: null,
    pcmAudioCtx: null,
    pcmSource: null,
    pcmProcessor: null,
    mediaStream: null,
    recorder: null,
    ws: null,
  };
}

function getOrCreateSession(tabId) {
  let session = sessions.get(tabId);
  if (!session) {
    session = createSession(tabId);
    sessions.set(tabId, session);
  }
  return session;
}

function enqueueForTab(tabId, task) {
  const session = getOrCreateSession(tabId);
  const next = session.opChain.then(task, task);
  session.opChain = next.catch(() => { });
  return next;
}

function disconnectNode(node) {
  try { node?.disconnect(); } catch { }
}

async function closeAudioContext(ctx) {
  if (ctx && ctx.state !== 'closed') {
    try { await ctx.close(); } catch { }
  }
}

async function cleanupSession(session) {
  session.state = 'stopping';

  disconnectNode(session.monitorGain);
  disconnectNode(session.monitorSource);
  disconnectNode(session.pcmProcessor);
  disconnectNode(session.pcmSource);
  session.mediaStream?.getTracks().forEach((track) => track.stop());

  if (session.recorder && session.recorder.state !== 'inactive') {
    try { session.recorder.stop(); } catch { }
  }
  session.recorder = null;

  await closeAudioContext(session.monitorAudioCtx);
  await closeAudioContext(session.pcmAudioCtx);

  if (session.ws) {
    session.ws.close();
    session.ws = null;
  }

  session.monitorGain = null;
  session.monitorSource = null;
  session.pcmProcessor = null;
  session.pcmSource = null;
  session.pcmAudioCtx = null;
  session.mediaStream = null;
  session.monitorAudioCtx = null;
  session.state = 'idle';
  sessions.delete(session.tabId);
}

function formatColabUrl(val) {
  let u = (val || '').trim();
  if (!u) return '';
  if (u.startsWith('http://')) u = u.replace('http://', 'ws://');
  else if (u.startsWith('https://')) u = u.replace('https://', 'wss://');
  else if (!u.startsWith('ws://') && !u.startsWith('wss://')) u = 'wss://' + u;
  if (!u.includes('/ws/live')) {
    u = u.replace(/\/+$/, '') + '/ws/live';
  }
  return u;
}

function setupWebSocket(session) {
  const rawUrl = sessionConfig.colabUrl;
  const url = formatColabUrl(rawUrl);
  if (!url) {
    sendToSW({ type: MSG.captureError, tabId: session.tabId, error: 'No WebSocket URL configured.' });
    return;
  }

  console.log(`[BabelLive-Offscreen] Connecting to WebSocket: ${url}`);
  const ws = new WebSocket(url);
  session.ws = ws;

  ws.onopen = () => {
    console.log(`[BabelLive-Offscreen] WebSocket connected for tab ${session.tabId}`);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log(`[BabelLive-Offscreen] WS message received:`, data);
      
      const isInterim = data.type === 'interim';
      
      chrome.runtime.sendMessage({
        type: 'BABELLIVE_SUBTITLE_BROADCAST',
        tabId: session.tabId,
        original: data.original || '',
        translated: data.translated || '',
        isInterim: isInterim,
      });
    } catch (e) {
      console.warn(`[BabelLive-Offscreen] Failed to parse WS message:`, e);
    }
  };

  ws.onerror = (err) => {
    console.error(`[BabelLive-Offscreen] WebSocket error:`, err);
  };

  ws.onclose = () => {
    console.log(`[BabelLive-Offscreen] WebSocket closed for tab ${session.tabId}`);
    // Basic auto-reconnect if session is still running
    if (session.state === 'running') {
      console.log(`[BabelLive-Offscreen] Reconnecting WebSocket...`);
      setTimeout(() => {
        if (session.state === 'running') setupWebSocket(session);
      }, 2000);
    }
  };
}

async function startCapture(streamId, tabId) {
  const session = getOrCreateSession(tabId);

  if (session.state === 'running') {
    sendToSW({ type: MSG.captureReady, tabId });
    return;
  }

  if (session.mediaStream || session.monitorAudioCtx) {
    await cleanupSession(session);
    sessions.set(tabId, createSession(tabId));
  }

  const current = getOrCreateSession(tabId);
  current.state = 'starting';
  console.log(`[BabelLive-Offscreen] Audio stream initialization begins for tab ${tabId}`);

  try {
    // 1. Connect WebSocket
    setupWebSocket(current);

    // 2. Setup Audio
    current.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });

    // Monitor: keep tab audio audible while capturing
    current.monitorAudioCtx = new AudioContext();
    current.monitorSource = current.monitorAudioCtx.createMediaStreamSource(current.mediaStream);
    current.monitorGain = current.monitorAudioCtx.createGain();
    current.monitorGain.gain.value = 1;
    current.monitorSource.connect(current.monitorGain);
    current.monitorGain.connect(current.monitorAudioCtx.destination);
    
    console.log(`[BabelLive-Offscreen] Monitor loopback connected for tab ${tabId}`);

    // Setup Direct 16kHz PCM streaming for zero-latency, lossless audio to STT
    current.pcmAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    current.pcmSource = current.pcmAudioCtx.createMediaStreamSource(current.mediaStream);
    // Buffer size 4096 samples = 256ms of audio at 16kHz (8192 bytes Int16)
    current.pcmProcessor = current.pcmAudioCtx.createScriptProcessor(4096, 1, 1);

    current.pcmProcessor.onaudioprocess = (e) => {
      const active = sessions.get(tabId);
      if (active !== current) return;
      if (!current.ws || current.ws.readyState !== WebSocket.OPEN) return;

      const input = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      current.ws.send(pcm16.buffer);
    };

    current.pcmSource.connect(current.pcmProcessor);
    current.pcmProcessor.connect(current.pcmAudioCtx.destination);
    console.log(`[BabelLive-Offscreen] Direct 16kHz Int16 PCM streaming active (4096 samples/chunk)`);

    current.state = 'running';
    sendToSW({ type: MSG.captureReady, tabId });
  } catch (err) {
    try { await cleanupSession(current); } catch { }
    sendToSW({ type: MSG.captureError, tabId, error: err.message });
  }
}

async function stopCapture(tabId) {
  const session = sessions.get(tabId);
  if (!session) {
    sendToSW({ type: MSG.captureEnded, tabId });
    return;
  }
  await cleanupSession(session);
  sendToSW({ type: MSG.captureEnded, tabId });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.startCapture && message.tabId != null) {
    if (message.settings) {
      sessionConfig.sourceLang = message.settings.sourceLang || 'ja';
      sessionConfig.targetLang = message.settings.targetLang || 'vi';
      sessionConfig.colabUrl = message.settings.colabUrl || '';
    }
    enqueueForTab(message.tabId, () => startCapture(message.streamId, message.tabId));
  } else if (message?.type === MSG.stopCapture && message.tabId != null) {
    enqueueForTab(message.tabId, () => stopCapture(message.tabId));
  }
});
