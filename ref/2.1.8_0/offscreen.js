// Offscreen document: runs in extension context, handles tab audio capture + WebCodecs encoding.
// Receives START_CAPTURE / STOP_CAPTURE from service worker.
// Sends CAPTURE_READY / CAPTURE_ERROR / CAPTURE_ENDED / OPUS_CHUNK back to service worker.

const MSG = {
  startCapture: 'START_CAPTURE',
  stopCapture: 'STOP_CAPTURE',
  captureReady: 'CAPTURE_READY',
  captureError: 'CAPTURE_ERROR',
  captureEnded: 'CAPTURE_ENDED',
  opusChunk: 'OPUS_CHUNK',
  webrtcStartCapture: 'WEBRTC_START_CAPTURE',
  webrtcStopCapture: 'WEBRTC_STOP_CAPTURE',
  webrtcPauseCapture: 'WEBRTC_PAUSE_CAPTURE',
  webrtcResumeCapture: 'WEBRTC_RESUME_CAPTURE',
  webrtcCaptureReady: 'WEBRTC_CAPTURE_READY',
  webrtcCaptureError: 'WEBRTC_CAPTURE_ERROR',
  webrtcCaptureEnded: 'WEBRTC_CAPTURE_ENDED',
  webrtcCapturePaused: 'WEBRTC_CAPTURE_PAUSED',
  webrtcCaptureResumed: 'WEBRTC_CAPTURE_RESUMED',
  webrtcConnState: 'WEBRTC_CONN_STATE',
  webrtcResult: 'WEBRTC_RESULT',
  webrtcStats: 'WEBRTC_STATS',
};

const CAPTURE_STATES = {
  idle: 'idle',
  starting: 'starting',
  running: 'running',
  stopping: 'stopping',
};

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const FRAME_MS = 20;
const FRAME_SIZE = (SAMPLE_RATE * FRAME_MS) / 1000; // 320 samples

const WORKLET_URL = chrome.runtime.getURL('audio-worklet-processor.js');
const sessions = new Map();

function sendToSW(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function createSession(tabId) {
  return {
    tabId,
    state: CAPTURE_STATES.idle,
    opChain: Promise.resolve(),
    audioCtx: null,
    monitorAudioCtx: null,
    encoder: null,
    source: null,
    monitorSource: null,
    workletNode: null,
    monitorGain: null,
    mediaStream: null,
    frameTimestamp: 0,
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
  try { node?.disconnect(); } catch {}
}

async function closeAudioContext(ctx) {
  if (ctx && ctx.state !== 'closed') {
    try { await ctx.close(); } catch {}
  }
}

async function cleanupSession(session) {
  session.state = CAPTURE_STATES.stopping;

  disconnectNode(session.workletNode);
  disconnectNode(session.monitorGain);
  disconnectNode(session.monitorSource);
  disconnectNode(session.source);
  session.mediaStream?.getTracks().forEach((track) => track.stop());

  const encoder = session.encoder;
  if (encoder && encoder.state !== 'closed') {
    try { await encoder.flush(); } catch {}
    try { encoder.close(); } catch {}
  }

  await closeAudioContext(session.audioCtx);
  await closeAudioContext(session.monitorAudioCtx);

  session.workletNode = null;
  session.monitorGain = null;
  session.monitorSource = null;
  session.source = null;
  session.mediaStream = null;
  session.encoder = null;
  session.audioCtx = null;
  session.monitorAudioCtx = null;
  session.frameTimestamp = 0;
  session.state = CAPTURE_STATES.idle;
  sessions.delete(session.tabId);
}

async function startCapture(streamId, tabId) {
  const session = getOrCreateSession(tabId);

  if (session.state === CAPTURE_STATES.running) {
    sendToSW({ type: MSG.captureReady, tabId });
    return;
  }

  if (session.mediaStream || session.audioCtx || session.encoder) {
    await cleanupSession(session);
    sessions.set(tabId, session);
  }

  session.state = CAPTURE_STATES.starting;
  try {
    session.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });

    session.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    session.monitorAudioCtx = new AudioContext();

    await session.audioCtx.audioWorklet.addModule(WORKLET_URL);

    const encoder = new AudioEncoder({
      output: (chunk) => {
        const active = sessions.get(tabId);
        if (active?.encoder !== encoder) return;
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        // Chrome extension message passing uses JSON; send a plain Array, not Uint8Array.
        sendToSW({ type: MSG.opusChunk, tabId, data: Array.from(bytes), timestamp: chunk.timestamp });
      },
      error: (err) => {
        sendToSW({ type: MSG.captureError, tabId, error: err.message });
      },
    });
    session.encoder = encoder;

    encoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS, bitrate: 32000 });

    session.source = session.audioCtx.createMediaStreamSource(session.mediaStream);
    session.monitorSource = session.monitorAudioCtx.createMediaStreamSource(session.mediaStream);
    // numberOfOutputs:0 makes this a sink node; Chrome won't silence inputs when output is unconnected.
    session.workletNode = new AudioWorkletNode(session.audioCtx, 'audio-capture-processor', {
      processorOptions: { frameSize: FRAME_SIZE },
      numberOfOutputs: 0,
    });

    session.workletNode.port.onmessage = ({ data: pcm }) => {
      const active = sessions.get(tabId);
      if (active !== session || encoder.state !== 'configured') return;
      const audioData = new AudioData({
        format: 's16-planar',
        sampleRate: SAMPLE_RATE,
        numberOfFrames: pcm.length,
        numberOfChannels: CHANNELS,
        timestamp: session.frameTimestamp,
        data: pcm,
      });
      encoder.encode(audioData);
      audioData.close();
      session.frameTimestamp += FRAME_MS * 1000;
    };

    session.source.connect(session.workletNode);
    session.monitorGain = session.monitorAudioCtx.createGain();
    session.monitorGain.gain.value = 1;
    session.monitorSource.connect(session.monitorGain);
    session.monitorGain.connect(session.monitorAudioCtx.destination);
    session.state = CAPTURE_STATES.running;
    sendToSW({ type: MSG.captureReady, tabId });
  } catch (err) {
    try { await cleanupSession(session); } catch {}
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
    enqueueForTab(message.tabId, () => startCapture(message.streamId, message.tabId));
  } else if (message?.type === MSG.stopCapture && message.tabId != null) {
    enqueueForTab(message.tabId, () => stopCapture(message.tabId));
  }
});

// ---------------------------------------------------------------------------
// WebRTC relay transport
//
// Instead of manually encoding Opus with WebCodecs (the path above), this
// publishes the tab audio as a WebRTC MediaStreamTrack to rtvtGateWebRTC and
// receives recognition/translation results over a DataChannel. The browser's
// WebRTC stack handles Opus encoding, so no AudioEncoder is needed. The monitor
// playback is still attached so the tab is not muted while captured.
// ---------------------------------------------------------------------------

const RESULT_CHANNEL_LABEL = 'rtvt-result';
const ICE_GATHER_TIMEOUT_MS = 2000;
// `disconnected` is a transient ICE state that often self-heals back to
// `connected`. Give it this grace period before treating it as a real drop.
const WEBRTC_DISCONNECT_GRACE_MS = 5000;
const webrtcSessions = new Map();

function getOrCreateWebrtcSession(tabId) {
  let session = webrtcSessions.get(tabId);
  if (!session) {
    session = {
      tabId,
      opChain: Promise.resolve(),
      pc: null,
      mediaStream: null,
      monitorAudioCtx: null,
      monitorSource: null,
      monitorGain: null,
      resultChannel: null,
      sessionId: '',
      streamId: '',
      relayUrl: '',
      closed: false,
      readySent: false,
      paused: false,
      disconnectTimer: null,
    };
    webrtcSessions.set(tabId, session);
  }
  return session;
}

function enqueueWebrtc(tabId, task) {
  const session = getOrCreateWebrtcSession(tabId);
  const next = session.opChain.then(task, task);
  session.opChain = next.catch(() => {});
  return next;
}

function waitForIceGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    pc.addEventListener('icegatheringstatechange', onChange);
    setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
  });
}

// Parse the ICE candidates the relay collected and returned in its answer SDP,
// i.e. the server endpoints we will push RTP to. Each entry is
// "address:port transport typ" (e.g. "47.96.1.2:39214 udp host").
function parseSdpCandidates(sdp) {
  const out = [];
  if (!sdp) return out;
  for (const line of sdp.split(/\r?\n/)) {
    const idx = line.indexOf('candidate:');
    if (idx === -1) continue;
    // foundation component transport priority address port typ type ...
    const parts = line.slice(idx + 'candidate:'.length).trim().split(/\s+/);
    if (parts.length < 6) continue;
    const transport = parts[2];
    const address = parts[4];
    const port = parts[5];
    const typIdx = parts.indexOf('typ');
    const type = typIdx !== -1 ? (parts[typIdx + 1] || '') : '';
    out.push(`${address}:${port} ${transport} ${type}`.trim());
  }
  return out;
}

async function cleanupWebrtcSession(session, { deleteRemote = true } = {}) {
  session.closed = true;

  if (session.disconnectTimer) {
    clearTimeout(session.disconnectTimer);
    session.disconnectTimer = null;
  }

  if (session.resultChannel) {
    try { session.resultChannel.close(); } catch {}
    session.resultChannel = null;
  }
  if (session.pc) {
    try { session.pc.onconnectionstatechange = null; } catch {}
    try {
      session.pc.getSenders().forEach((sender) => sender.track && sender.track.stop());
    } catch {}
    try { session.pc.close(); } catch {}
    session.pc = null;
  }
  disconnectNode(session.monitorGain);
  disconnectNode(session.monitorSource);
  session.mediaStream?.getTracks().forEach((track) => track.stop());
  await closeAudioContext(session.monitorAudioCtx);

  session.monitorGain = null;
  session.monitorSource = null;
  session.monitorAudioCtx = null;
  session.mediaStream = null;

  if (deleteRemote && session.relayUrl && session.sessionId) {
    try {
      const origin = new URL(session.relayUrl).origin;
      await fetch(`${origin}/gate/webrtc/session/${encodeURIComponent(session.sessionId)}`, { method: 'DELETE' });
    } catch (err) {
      console.warn('[offscreen] delete webrtc session failed', err);
    }
  }
  session.sessionId = '';
  webrtcSessions.delete(session.tabId);
}

async function startWebrtcCapture(message) {
  const { tabId, streamId, relayUrl, iceServers, request } = message;
  const session = getOrCreateWebrtcSession(tabId);

  if (session.pc || session.mediaStream) {
    await cleanupWebrtcSession(session);
    getOrCreateWebrtcSession(tabId);
  }
  const current = getOrCreateWebrtcSession(tabId);
  current.closed = false;
  current.readySent = false;
  if (current.disconnectTimer) {
    clearTimeout(current.disconnectTimer);
    current.disconnectTimer = null;
  }
  current.relayUrl = relayUrl || '';

  try {
    if (!relayUrl) throw new Error('webrtc relay url is empty');

    current.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });

    // Keep the tab audible while it is captured.
    current.monitorAudioCtx = new AudioContext();
    current.monitorSource = current.monitorAudioCtx.createMediaStreamSource(current.mediaStream);
    current.monitorGain = current.monitorAudioCtx.createGain();
    current.monitorGain.gain.value = 1;
    current.monitorSource.connect(current.monitorGain);
    current.monitorGain.connect(current.monitorAudioCtx.destination);

    const pc = new RTCPeerConnection({ iceServers: Array.isArray(iceServers) ? iceServers : [] });
    current.pc = pc;

    const tearDownSession = () => {
      enqueueWebrtc(tabId, async () => {
        if (current.closed) return;
        await cleanupWebrtcSession(current);
        sendToSW({ type: MSG.webrtcCaptureEnded, tabId });
      });
    };

    pc.onconnectionstatechange = () => {
      if (current.closed) return;
      const stateName = pc.connectionState;
      // Forward to the content side so it goes through the shared logger/uploader.
      sendToSW({ type: MSG.webrtcConnState, tabId, state: stateName });
      if (stateName === 'connected') {
        // A transient `disconnected` may have armed the grace timer; the
        // connection recovered, so cancel the pending teardown.
        if (current.disconnectTimer) {
          clearTimeout(current.disconnectTimer);
          current.disconnectTimer = null;
        }
        // Only announce ready once the ICE/DTLS connection is actually up, not
        // when the SDP exchange finishes. This way an unreachable relay (bad
        // candidate IP/port) surfaces as a start timeout / drop instead of a
        // false "running", and the content side can fall back to FPNN.
        // Guard against re-firing on connection flaps so ready is emitted once.
        if (!current.readySent) {
          current.readySent = true;
          sendToSW({
            type: MSG.webrtcCaptureReady,
            tabId,
            sessionId: current.sessionId,
            streamId: current.streamId,
          });
        }
      } else if (stateName === 'disconnected') {
        // `disconnected` is transient and frequently self-heals back to
        // `connected`. Wait out a grace period before tearing down; a recovery
        // into `connected` cancels this timer above.
        if (!current.disconnectTimer) {
          current.disconnectTimer = setTimeout(() => {
            current.disconnectTimer = null;
            if (current.closed) return;
            if (pc.connectionState === 'connected') return;
            tearDownSession();
          }, WEBRTC_DISCONNECT_GRACE_MS);
        }
      } else if (stateName === 'failed' || stateName === 'closed') {
        // Terminal states: tear down immediately, no grace period.
        if (current.disconnectTimer) {
          clearTimeout(current.disconnectTimer);
          current.disconnectTimer = null;
        }
        tearDownSession();
      }
    };

    const resultChannel = pc.createDataChannel(RESULT_CHANNEL_LABEL, { ordered: true });
    current.resultChannel = resultChannel;
    resultChannel.onmessage = (event) => {
      if (current.closed) return;
      sendToSW({ type: MSG.webrtcResult, tabId, data: event.data });
    };

    const [audioTrack] = current.mediaStream.getAudioTracks();
    if (!audioTrack) throw new Error('no audio track from tab capture');
    pc.addTrack(audioTrack, current.mediaStream);

    const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    const payload = { ...request, offer: { sdp: pc.localDescription.sdp } };
    const response = await fetch(relayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `webrtc offer http ${response.status}`);
    if (current.closed) return;

    current.sessionId = data.sessionId || '';
    current.streamId = String(data.streamId ?? '');
    await pc.setRemoteDescription({ type: data.answer.type, sdp: data.answer.sdp });
    if (current.closed) return;

    // Log the relay endpoints collected in the answer (server ip/port for RTP).
    const remoteCandidates = parseSdpCandidates(data.answer?.sdp);
    sendToSW({
      type: MSG.webrtcStats,
      tabId,
      log: remoteCandidates.length
        ? `webrtc answer remote candidates: ${remoteCandidates.join(', ')}`
        : 'webrtc answer remote candidates: none in answer sdp',
    });
    // webrtcCaptureReady is now sent from onconnectionstatechange once the
    // connection reaches 'connected'.
  } catch (err) {
    try { await cleanupWebrtcSession(current, { deleteRemote: false }); } catch {}
    sendToSW({ type: MSG.webrtcCaptureError, tabId, error: err?.message || String(err || 'webrtc start failed') });
  }
}

async function stopWebrtcCapture(tabId) {
  const session = webrtcSessions.get(tabId);
  if (!session) {
    sendToSW({ type: MSG.webrtcCaptureEnded, tabId });
    return;
  }
  await cleanupWebrtcSession(session);
  sendToSW({ type: MSG.webrtcCaptureEnded, tabId });
}

// Soft pause for a quick fullscreen toggle: detach the local tab-capture track
// and tear down the monitor, but keep the PeerConnection, DataChannel and the
// remote relay session alive so resuming does not require a new SDP/ICE
// negotiation. RTP simply stops flowing while the track is null; ICE/DTLS
// keepalives keep the connection 'connected'.
async function pauseWebrtcCapture(tabId) {
  const session = webrtcSessions.get(tabId);
  if (!session || !session.pc || session.closed) {
    sendToSW({ type: MSG.webrtcCapturePaused, tabId });
    return;
  }
  try {
    session.pc.getSenders().forEach((sender) => {
      try { sender.replaceTrack(null); } catch {}
    });
  } catch {}
  disconnectNode(session.monitorGain);
  disconnectNode(session.monitorSource);
  session.mediaStream?.getTracks().forEach((track) => track.stop());
  await closeAudioContext(session.monitorAudioCtx);
  session.monitorGain = null;
  session.monitorSource = null;
  session.monitorAudioCtx = null;
  session.mediaStream = null;
  session.paused = true;
  sendToSW({ type: MSG.webrtcCapturePaused, tabId });
}

// Resume from a soft pause: re-acquire the tab audio (a fresh streamId is
// required since tabCapture stream ids are single-use), rebuild the monitor and
// swap the new track back onto the existing sender via replaceTrack — no
// renegotiation. If the relay session is gone, signal ended so the content side
// falls back to a full restart.
async function resumeWebrtcCapture(message) {
  const { tabId, streamId } = message;
  const session = webrtcSessions.get(tabId);
  if (!session || !session.pc || session.closed) {
    sendToSW({ type: MSG.webrtcCaptureEnded, tabId });
    return;
  }
  try {
    session.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });

    // Keep the tab audible while it is captured.
    session.monitorAudioCtx = new AudioContext();
    session.monitorSource = session.monitorAudioCtx.createMediaStreamSource(session.mediaStream);
    session.monitorGain = session.monitorAudioCtx.createGain();
    session.monitorGain.gain.value = 1;
    session.monitorSource.connect(session.monitorGain);
    session.monitorGain.connect(session.monitorAudioCtx.destination);

    const [audioTrack] = session.mediaStream.getAudioTracks();
    if (!audioTrack) throw new Error('no audio track from tab capture');
    const sender = session.pc.getSenders().find((s) => s.track === null) || session.pc.getSenders()[0];
    if (sender) await sender.replaceTrack(audioTrack);
    else session.pc.addTrack(audioTrack, session.mediaStream);

    session.paused = false;
    sendToSW({ type: MSG.webrtcCaptureResumed, tabId, streamId: session.streamId });
  } catch (err) {
    try { await cleanupWebrtcSession(session); } catch {}
    sendToSW({ type: MSG.webrtcCaptureEnded, tabId });
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.webrtcStartCapture && message.tabId != null) {
    enqueueWebrtc(message.tabId, () => startWebrtcCapture(message));
  } else if (message?.type === MSG.webrtcStopCapture && message.tabId != null) {
    enqueueWebrtc(message.tabId, () => stopWebrtcCapture(message.tabId));
  } else if (message?.type === MSG.webrtcPauseCapture && message.tabId != null) {
    enqueueWebrtc(message.tabId, () => pauseWebrtcCapture(message.tabId));
  } else if (message?.type === MSG.webrtcResumeCapture && message.tabId != null) {
    enqueueWebrtc(message.tabId, () => resumeWebrtcCapture(message));
  }
});
