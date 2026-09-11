/**
 * BabelLive — Offscreen Document
 * Handles tab audio capture using getUserMedia + AudioWorklet + WebCodecs (Opus).
 * Receives START/STOP from service worker, performs STT & Translation.
 */

import { translate } from './translation/translation-router.js';

const MSG = {
  startCapture: 'BABELLIVE_START_CAPTURE',
  stopCapture: 'BABELLIVE_STOP_CAPTURE',
  captureReady: 'BABELLIVE_CAPTURE_READY',
  captureError: 'BABELLIVE_CAPTURE_ERROR',
  captureEnded: 'BABELLIVE_CAPTURE_ENDED',
  audioChunk: 'BABELLIVE_AUDIO_CHUNK',
};

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const FRAME_MS = 20;
const FRAME_SIZE = (SAMPLE_RATE * FRAME_MS) / 1000; // 320 samples

const WORKLET_URL = chrome.runtime.getURL('audio-worklet-processor.js');
const sessions = new Map();

function sendToSW(message) {
  chrome.runtime.sendMessage(message).catch(() => { });
}

const LANG_NAMES = {
  auto: 'the source language',
  ja: 'Japanese', en: 'English', zh: 'Chinese', ko: 'Korean',
  vi: 'Vietnamese', fr: 'French', de: 'German', es: 'Spanish',
  ru: 'Russian', th: 'Thai',
};

const STORAGE_KEY = 'babellive_settings';

let sessionConfig = { apiKey: '', sourceLang: 'ja', targetLang: 'vi' };

async function transcribeAndTranslateGemini(audioBase64, mimeType, tabId) {
  const keys = (sessionConfig.apiKey || '').split(',').map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) {
    sendToSW({ type: MSG.captureError, tabId, error: 'No Gemini API key provided.' });
    return null;
  }
  const apiKey = keys[Math.floor(Math.random() * keys.length)];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  
  if (!apiKey.startsWith('AIza')) {
    console.warn('[BabelLive-Offscreen] Warning: API Key format may not match Google AI Studio (expected AIza...). Key prefix:', apiKey.slice(0, 4));
  }

  const srcName = LANG_NAMES[sessionConfig.sourceLang] || 'the source language';
  const tgtName = LANG_NAMES[sessionConfig.targetLang] || 'the target language';

  const prompt = `Transcribe the audio speech accurately into its original language (${srcName}) and immediately translate it into ${tgtName}. Return ONLY a valid JSON object without markdown formatting: {"original": "...", "translated": "..."}. If there is only silence or background noise, return {"original": "", "translated": ""}.`;

  console.log('[BabelLive-Offscreen] Calling Gemini API...');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { inline_data: { mime_type: mimeType || 'audio/webm', data: audioBase64 } },
              { text: prompt },
            ],
          }
        ],
        generationConfig: { response_mime_type: 'application/json', temperature: 0.2 },
      }),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`[BabelLive-Offscreen GEMINI ERROR] ${res.status}`, errorBody);
      sendToSW({ type: MSG.captureError, tabId, error: `Gemini API Error: ${res.status}` });
      return null;
    }

    console.log(`[BabelLive-Offscreen] Gemini API Response HTTP Status: ${res.status}`);
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;
    
    // Sometimes Gemini wraps JSON in markdown blocks despite instructions
    const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanText);
    
    if (parsed.original || parsed.translated) {
      console.log('[BabelLive-Offscreen] Parsed STT payload:', parsed);
      return { original: parsed.original || '', translated: parsed.translated || parsed.original };
    }
  } catch (err) {
    console.error('[BabelLive-Offscreen GEMINI ERROR] Network or parsing error:', err);
  }
  return null;
}

async function handleAudioBuffer(tabId, audioBase64, mimeType) {
  try {
    // Rely on in-memory sessionConfig, with a safe fallback just in case
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && !sessionConfig.apiKey) {
      const store = await chrome.storage.local.get(STORAGE_KEY);
      const settings = store[STORAGE_KEY] || {};
      if (settings.apiKeys) {
        sessionConfig.apiKey = settings.apiKeys;
        sessionConfig.sourceLang = settings.sourceLang || 'ja';
        sessionConfig.targetLang = settings.targetLang || 'vi';
      }
    }

    // We rely purely on the 2-in-1 Gemini pipeline as requested
    if (sessionConfig.apiKey) {
      const result = await transcribeAndTranslateGemini(audioBase64, mimeType, tabId);
      if (result && (result.original || result.translated)) {
        console.log(`[BabelLive-Offscreen] Dispatching BABELLIVE_SUBTITLE_BROADCAST to Tab ${tabId}`);
        chrome.runtime.sendMessage({
          type: 'BABELLIVE_SUBTITLE_BROADCAST',
          tabId: tabId,
          original: result.original,
          translated: result.translated
        });
      }
    } else {
      // Missing API key handling
      sendToSW({ type: MSG.captureError, tabId, error: 'No Gemini API key provided.' });
    }
  } catch (e) {
    console.warn('[BabelLive offscreen] handleAudioBuffer error:', e);
  }
}

function createSession(tabId) {
  return {
    tabId,
    state: 'idle',
    opChain: Promise.resolve(),
    audioCtx: null,
    monitorAudioCtx: null,
    encoder: null,
    source: null,
    monitorSource: null,
    workletNode: null,
    monitorGain: null,
    mediaStream: null,
    recorder: null,
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

  disconnectNode(session.workletNode);
  disconnectNode(session.monitorGain);
  disconnectNode(session.monitorSource);
  disconnectNode(session.source);
  session.mediaStream?.getTracks().forEach((track) => track.stop());

  if (session.recorder && session.recorder.state !== 'inactive') {
    try { session.recorder.stop(); } catch { }
  }
  session.recorder = null;

  const encoder = session.encoder;
  if (encoder && encoder.state !== 'closed') {
    try { await encoder.flush(); } catch { }
    try { encoder.close(); } catch { }
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
  session.state = 'idle';
  sessions.delete(session.tabId);
}

async function startCapture(streamId, tabId) {
  const session = getOrCreateSession(tabId);

  if (session.state === 'running') {
    sendToSW({ type: MSG.captureReady, tabId });
    return;
  }

  if (session.mediaStream || session.audioCtx || session.encoder) {
    await cleanupSession(session);
    sessions.set(tabId, createSession(tabId));
  }

  const current = getOrCreateSession(tabId);
  current.state = 'starting';
  console.log(`[BabelLive-Offscreen] Audio stream initialization begins for tab ${tabId} with streamId: ${streamId?.slice(0, 10)}...`);

  try {
    current.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });

    current.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    current.monitorAudioCtx = new AudioContext();
    console.log(`[BabelLive-Offscreen] AudioContext state: ${current.audioCtx.state}`);

    await current.audioCtx.audioWorklet.addModule(WORKLET_URL);

    const encoder = new AudioEncoder({
      output: (chunk) => {
        const active = sessions.get(tabId);
        if (active?.encoder !== encoder) return;
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        sendToSW({
          type: MSG.audioChunk,
          tabId,
          data: Array.from(bytes),
          timestamp: chunk.timestamp,
        });
      },
      error: (err) => {
        sendToSW({ type: MSG.captureError, tabId, error: err.message });
      },
    });
    current.encoder = encoder;

    encoder.configure({
      codec: 'opus',
      sampleRate: SAMPLE_RATE,
      numberOfChannels: CHANNELS,
      bitrate: 32000,
    });

    current.source = current.audioCtx.createMediaStreamSource(current.mediaStream);
    current.monitorSource = current.monitorAudioCtx.createMediaStreamSource(current.mediaStream);
    current.workletNode = new AudioWorkletNode(current.audioCtx, 'audio-capture-processor', {
      processorOptions: { frameSize: FRAME_SIZE },
      numberOfOutputs: 0,
    });

    current.workletNode.port.onmessage = ({ data: pcm }) => {
      const active = sessions.get(tabId);
      if (active !== current) return;

      // Simple Energy VAD
      let sum = 0;
      for (let i = 0; i < pcm.length; i++) sum += Math.abs(pcm[i]);
      const energy = sum / pcm.length;
      if (energy > 500) {
        current.lastSpeechTime = Date.now();
      }

      if (encoder.state === 'configured') {
        const audioData = new AudioData({
          format: 's16-planar',
          sampleRate: SAMPLE_RATE,
          numberOfFrames: pcm.length,
          numberOfChannels: CHANNELS,
          timestamp: current.frameTimestamp,
          data: pcm,
        });
        encoder.encode(audioData);
        audioData.close();
      }
      current.frameTimestamp += FRAME_MS * 1000;
    };

    current.source.connect(current.workletNode);

    // Monitor: keep tab audible
    current.monitorGain = current.monitorAudioCtx.createGain();
    current.monitorGain.gain.value = 1;
    current.monitorSource.connect(current.monitorGain);
    current.monitorGain.connect(current.monitorAudioCtx.destination);
    console.log(`[BabelLive-Offscreen] Loopback destination connected for tab ${tabId}`);

    // Setup MediaRecorder with VAD buffering
    try {
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      const recorder = new MediaRecorder(current.mediaStream, { mimeType });
      current.recorder = recorder;

      let chunkBuffer = [];
      let isSpeaking = false;
      let recordStartTime = Date.now();

      recorder.ondataavailable = (e) => {
        const active = sessions.get(tabId);
        if (active !== current || !e.data || e.data.size < 100) return;

        const now = Date.now();
        const timeSinceLastSpeech = now - (current.lastSpeechTime || 0);
        const hasSpeech = timeSinceLastSpeech < 1000;

        if (hasSpeech) {
          isSpeaking = true;
          chunkBuffer.push(e.data);
        } else if (isSpeaking) {
          // Speech ended, finalize buffer and send
          isSpeaking = false;
          chunkBuffer.push(e.data);
          const blob = new Blob(chunkBuffer, { type: mimeType });
          chunkBuffer = [];

          if (blob.size > 1000) {
            const reader = new FileReader();
            reader.onloadend = () => {
              const res = reader.result;
              if (typeof res === 'string') {
                const base64data = res.split(',')[1];
                if (base64data) {
                  console.log(`[BabelLive-Offscreen] Base64 conversion success. Payload size: ${base64data.length} bytes`);
                  handleAudioBuffer(tabId, base64data, mimeType);
                }
              }
            };
            reader.readAsDataURL(blob);
          }
        }
      };

      recorder.start(500); // 500ms chunks for VAD
      console.log(`[BabelLive-Offscreen] MediaRecorder started with state: ${recorder.state}`);
    } catch (recorderErr) {
      console.error('[BabelLive-Offscreen] MediaRecorder init error:', recorderErr);
    }

    current.state = 'running';
    console.log('[BabelLive offscreen] Capture started successfully for tab:', tabId);
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
      sessionConfig.apiKey = message.settings.apiKeys || '';
      sessionConfig.sourceLang = message.settings.sourceLang || 'ja';
      sessionConfig.targetLang = message.settings.targetLang || 'vi';
    }
    enqueueForTab(message.tabId, () => startCapture(message.streamId, message.tabId));
  } else if (message?.type === MSG.stopCapture && message.tabId != null) {
    enqueueForTab(message.tabId, () => stopCapture(message.tabId));
  }
});
