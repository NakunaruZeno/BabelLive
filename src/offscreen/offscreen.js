/**
 * BabelLive — Offscreen Document
 * Captures tab audio via getUserMedia, preserves local speaker playback via monitor loopback,
 * converts audio to 16kHz mono Int16 PCM using AudioWorklet (with ScriptProcessor fallback),
 * and streams over WebSocket with backpressure protection and exponential-backoff reconnect.
 */

const MSG = {
  startCapture: 'BABELLIVE_START_CAPTURE',
  stopCapture: 'BABELLIVE_STOP_CAPTURE',
  settingsUpdate: 'BABELLIVE_SETTINGS_UPDATE',
  captureReady: 'BABELLIVE_CAPTURE_READY',
  captureError: 'BABELLIVE_CAPTURE_ERROR',
  captureEnded: 'BABELLIVE_CAPTURE_ENDED',
  subtitleBroadcast: 'BABELLIVE_SUBTITLE_BROADCAST',
};

const MAX_RECONNECT_ATTEMPTS = 5;
const MAX_WS_BUFFERED_BYTES = 65536; // 64 KB backpressure cap (~2s of 16kHz Int16 PCM)

let sessionConfig = {
  sourceLang: 'ja',
  targetLang: 'vi',
  colabUrl: '',
};

const sessions = new Map();

function sendToSW(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
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
    pcmNode: null,
    mediaStream: null,
    ws: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
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
  session.opChain = next.catch(() => {});
  return next;
}

function disconnectNode(node) {
  try {
    if (node?.port) node.port.onmessage = null;
    node?.disconnect();
  } catch {}
}

async function closeAudioContext(ctx) {
  if (ctx && ctx.state !== 'closed') {
    try {
      await ctx.close();
    } catch {}
  }
}

async function cleanupSession(session) {
  session.state = 'stopping';

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  disconnectNode(session.monitorGain);
  disconnectNode(session.monitorSource);
  disconnectNode(session.pcmNode);
  disconnectNode(session.pcmSource);

  session.mediaStream?.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {}
  });

  await closeAudioContext(session.monitorAudioCtx);
  await closeAudioContext(session.pcmAudioCtx);

  if (session.ws) {
    try {
      session.ws.onclose = null;
      session.ws.onerror = null;
      session.ws.onmessage = null;
      session.ws.close();
    } catch {}
    session.ws = null;
  }

  session.monitorGain = null;
  session.monitorSource = null;
  session.pcmNode = null;
  session.pcmSource = null;
  session.pcmAudioCtx = null;
  session.mediaStream = null;
  session.monitorAudioCtx = null;
  session.state = 'idle';
  sessions.delete(session.tabId);
}

function buildWebSocketUrl(rawUrl, sourceLang, targetLang) {
  let u = (rawUrl || '').trim();
  if (!u) return '';
  if (u.startsWith('http://')) u = u.replace('http://', 'ws://');
  else if (u.startsWith('https://')) u = u.replace('https://', 'wss://');
  else if (!u.startsWith('ws://') && !u.startsWith('wss://')) u = 'wss://' + u;

  // Strip existing query string before normalizing path
  const [basePart, existingQuery] = u.split('?');
  let normalizedBase = basePart.replace(/\/+$/, '');
  if (!normalizedBase.endsWith('/ws/live')) {
    normalizedBase += '/ws/live';
  }

  const params = new URLSearchParams(existingQuery || '');
  if (sourceLang) params.set('source_lang', sourceLang);
  if (targetLang) params.set('target_lang', targetLang);

  return `${normalizedBase}?${params.toString()}`;
}

function sendConfigToWs(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(
      JSON.stringify({
        type: 'config',
        source_lang: sessionConfig.sourceLang,
        target_lang: sessionConfig.targetLang,
      })
    );
  } catch {}
}

function connectWebSocket(session) {
  const url = buildWebSocketUrl(
    sessionConfig.colabUrl,
    sessionConfig.sourceLang,
    sessionConfig.targetLang
  );

  if (!url) {
    sendToSW({
      type: MSG.captureError,
      tabId: session.tabId,
      error: 'Missing WebSocket endpoint URL.',
    });
    return;
  }

  if (session.ws) {
    try {
      session.ws.onclose = null;
      session.ws.close();
    } catch {}
  }

  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  session.ws = ws;

  ws.onopen = () => {
    session.reconnectAttempts = 0;
    sendConfigToWs(ws);
    sendToSW({ type: MSG.captureReady, tabId: session.tabId });
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'pong' || data.type === 'ack') return;

      const isInterim = data.type === 'interim' || Boolean(data.is_interim);
      sendToSW({
        type: MSG.subtitleBroadcast,
        tabId: session.tabId,
        original: data.original || '',
        translated: data.translated || '',
        isInterim,
      });
    } catch {}
  };

  ws.onerror = () => {
    // Handled in onclose to support retry logic
  };

  ws.onclose = () => {
    if (session.state !== 'running') return;

    if (session.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      session.reconnectAttempts += 1;
      const delayMs = Math.min(1500 * Math.pow(1.6, session.reconnectAttempts - 1), 8000);
      session.reconnectTimer = setTimeout(() => {
        if (session.state === 'running') {
          connectWebSocket(session);
        }
      }, delayMs);
    } else {
      cleanupSession(session).finally(() => {
        sendToSW({
          type: MSG.captureError,
          tabId: session.tabId,
          error: 'Connection to AI backend lost.',
        });
      });
    }
  };
}

function sendPcmBuffer(session, arrayBuffer) {
  const ws = session.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // Drop frame if network socket buffer is backed up to prevent latency drift
  if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) return;
  try {
    ws.send(arrayBuffer);
  } catch {}
}

async function setupPcmPipeline(session) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  session.pcmAudioCtx = new AudioCtx({ sampleRate: 16000 });
  session.pcmSource = session.pcmAudioCtx.createMediaStreamSource(session.mediaStream);

  // Prefer AudioWorkletNode for off-main-thread, low-latency 128ms chunks
  if (session.pcmAudioCtx.audioWorklet) {
    try {
      const workletUrl = chrome.runtime.getURL('offscreen/audio-worklet-processor.js');
      await session.pcmAudioCtx.audioWorklet.addModule(workletUrl);
      const workletNode = new AudioWorkletNode(session.pcmAudioCtx, 'audio-capture-processor', {
        processorOptions: { frameSize: 2048 },
      });

      workletNode.port.onmessage = (event) => {
        if (sessions.get(session.tabId) !== session) return;
        if (event.data instanceof ArrayBuffer) {
          sendPcmBuffer(session, event.data);
        }
      };

      session.pcmNode = workletNode;
      session.pcmSource.connect(workletNode);
      return;
    } catch (workletErr) {
      console.warn('[BabelLive Offscreen] AudioWorklet fallback to ScriptProcessor:', workletErr);
    }
  }

  // Fallback: ScriptProcessorNode (2048 samples = 128ms @ 16kHz)
  const processor = session.pcmAudioCtx.createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = (e) => {
    if (sessions.get(session.tabId) !== session) return;
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) return;

    const input = e.inputBuffer.getChannelData(0);
    const pcm16 = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm16[i] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7FFF) | 0;
    }
    sendPcmBuffer(session, pcm16.buffer);
  };

  session.pcmNode = processor;
  session.pcmSource.connect(processor);
  processor.connect(session.pcmAudioCtx.destination);
}

async function startCapture(streamId, tabId) {
  const existing = getOrCreateSession(tabId);
  if (existing.state === 'running') {
    sendToSW({ type: MSG.captureReady, tabId });
    return;
  }

  if (existing.mediaStream || existing.monitorAudioCtx) {
    await cleanupSession(existing);
  }

  const current = getOrCreateSession(tabId);
  current.state = 'starting';

  try {
    // 1. Capture Tab Audio Stream
    current.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    // Listen for tab audio track ending (e.g. tab closed or capture revoked)
    const audioTrack = current.mediaStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.addEventListener('ended', () => {
        if (sessions.has(tabId)) {
          stopCapture(tabId);
        }
      });
    }

    // 2. Monitor Loopback: keep tab audio audible to the user
    current.monitorAudioCtx = new AudioContext();
    current.monitorSource = current.monitorAudioCtx.createMediaStreamSource(current.mediaStream);
    current.monitorGain = current.monitorAudioCtx.createGain();
    current.monitorGain.gain.value = 1.0;
    current.monitorSource.connect(current.monitorGain);
    current.monitorGain.connect(current.monitorAudioCtx.destination);

    // 3. Setup 16kHz Int16 PCM pipeline
    await setupPcmPipeline(current);

    // 4. Connect to AI WebSocket Backend
    current.state = 'running';
    connectWebSocket(current);
  } catch (err) {
    await cleanupSession(current);
    sendToSW({
      type: MSG.captureError,
      tabId,
      error: err?.message || 'Failed to initialize tab audio capture.',
    });
  }
}

async function stopCapture(tabId) {
  const session = sessions.get(tabId);
  if (session) {
    await cleanupSession(session);
  }
  sendToSW({ type: MSG.captureEnded, tabId });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === MSG.startCapture && message.tabId != null) {
    if (message.settings) {
      sessionConfig.sourceLang = message.settings.sourceLang || 'ja';
      sessionConfig.targetLang = message.settings.targetLang || 'vi';
      sessionConfig.colabUrl = message.settings.colabUrl || '';
    }
    enqueueForTab(message.tabId, () => startCapture(message.streamId, message.tabId));
    sendResponse({ accepted: true });
    return false;
  }

  if (message?.type === MSG.stopCapture && message.tabId != null) {
    enqueueForTab(message.tabId, () => stopCapture(message.tabId));
    sendResponse({ accepted: true });
    return false;
  }

  if (message?.type === MSG.settingsUpdate && message.settings) {
    const prevSource = sessionConfig.sourceLang;
    const prevTarget = sessionConfig.targetLang;
    sessionConfig.sourceLang = message.settings.sourceLang || sessionConfig.sourceLang;
    sessionConfig.targetLang = message.settings.targetLang || sessionConfig.targetLang;
    if (message.settings.colabUrl !== undefined) {
      sessionConfig.colabUrl = message.settings.colabUrl;
    }

    if (prevSource !== sessionConfig.sourceLang || prevTarget !== sessionConfig.targetLang) {
      sessions.forEach((session) => {
        if (session.state === 'running' && session.ws) {
          sendConfigToWs(session.ws);
        }
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
