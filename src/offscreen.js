/**
 * BabelLive — Offscreen Document
 * Handles tab audio capture using getUserMedia + MediaRecorder.
 * Receives START/STOP from service worker, performs STT & Translation.
 */

const MSG = {
  startCapture: 'BABELLIVE_START_CAPTURE',
  stopCapture: 'BABELLIVE_STOP_CAPTURE',
  captureReady: 'BABELLIVE_CAPTURE_READY',
  captureError: 'BABELLIVE_CAPTURE_ERROR',
  captureEnded: 'BABELLIVE_CAPTURE_ENDED',
};

const SEGMENT_MS = 4000;
const AUDIO_RMS_THRESHOLD = 0.0015;
const MIN_AUDIO_BYTES = 1000;
const GEMINI_MODEL = 'gemini-2.5-flash';
const GROQ_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';
const GROQ_CHAT_MODEL = 'llama-3.1-8b-instant';
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

let sessionConfig = { apiKey: '', sourceLang: 'ja', targetLang: 'vi', cloudProvider: 'groq' };

function getApiKey(tabId) {
  const keys = (sessionConfig.apiKey || '').split(',').map((key) => key.trim()).filter(Boolean);
  if (keys.length === 0) {
    sendToSW({ type: MSG.captureError, tabId, error: 'No cloud API key provided.' });
    return '';
  }
  return keys[Math.floor(Math.random() * keys.length)];
}

async function transcribeAndTranslateGemini(audioBase64, mimeType, tabId) {
  const apiKey = getApiKey(tabId);
  if (!apiKey) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  
  if (!apiKey.startsWith('AIza')) {
    console.warn('[BabelLive-Offscreen] Warning: API Key format may not match Google AI Studio (expected AIza...). Key prefix:', apiKey.slice(0, 4));
  }

  const srcName = LANG_NAMES[sessionConfig.sourceLang] || 'the source language';
  const tgtName = LANG_NAMES[sessionConfig.targetLang] || 'the target language';
  const apiMimeType = (mimeType || 'audio/webm').split(';')[0];

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
              { inlineData: { mimeType: apiMimeType, data: audioBase64 } },
              { text: prompt },
            ],
          }
        ],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
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

async function transcribeAndTranslateGroq(blob, mimeType, tabId) {
  const apiKey = getApiKey(tabId);
  if (!apiKey) return null;

  const extension = mimeType?.includes('ogg') ? 'ogg' : 'webm';
  const form = new FormData();
  form.append('file', blob, `babellive-${tabId}.${extension}`);
  form.append('model', GROQ_TRANSCRIPTION_MODEL);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  if (sessionConfig.sourceLang && sessionConfig.sourceLang !== 'auto') {
    form.append('language', sessionConfig.sourceLang);
  }

  const transcriptionResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!transcriptionResponse.ok) {
    const details = await transcriptionResponse.text().catch(() => '');
    throw new Error(`Groq transcription error ${transcriptionResponse.status}: ${details}`);
  }

  const transcription = await transcriptionResponse.json();
  const original = transcription.text?.trim() || '';
  if (!original) return null;
  if (sessionConfig.sourceLang === sessionConfig.targetLang) {
    return { original, translated: original };
  }

  const srcName = LANG_NAMES[sessionConfig.sourceLang] || 'the source language';
  const tgtName = LANG_NAMES[sessionConfig.targetLang] || 'the target language';
  const translationResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content: `Translate subtitles from ${srcName} to ${tgtName}. Return only the natural, concise translation.`,
        },
        { role: 'user', content: original },
      ],
      temperature: 0.2,
      max_tokens: 500,
    }),
  });
  if (!translationResponse.ok) {
    const details = await translationResponse.text().catch(() => '');
    throw new Error(`Groq translation error ${translationResponse.status}: ${details}`);
  }

  const translation = await translationResponse.json();
  const translated = translation.choices?.[0]?.message?.content?.trim() || original;
  return { original, translated };
}

async function handleAudioBuffer(tabId, blob, mimeType) {
  try {
    // Rely on in-memory sessionConfig, with a safe fallback just in case
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && !sessionConfig.apiKey) {
      const store = await chrome.storage.local.get(STORAGE_KEY);
      const settings = store[STORAGE_KEY] || {};
      if (settings.apiKeys) {
        sessionConfig.apiKey = settings.apiKeys;
        sessionConfig.sourceLang = settings.sourceLang || 'ja';
        sessionConfig.targetLang = settings.targetLang || 'vi';
        sessionConfig.cloudProvider = settings.cloudProvider || 'groq';
      }
    }

    if (sessionConfig.apiKey) {
      let result;
      if (sessionConfig.cloudProvider === 'gemini') {
        const audioBase64 = await blobToBase64(blob);
        if (!audioBase64) return;
        result = await transcribeAndTranslateGemini(audioBase64, mimeType, tabId);
      } else {
        result = await transcribeAndTranslateGroq(blob, mimeType, tabId);
      }
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
      sendToSW({ type: MSG.captureError, tabId, error: 'No cloud API key provided.' });
    }
  } catch (e) {
    console.error('[BabelLive-Offscreen] Audio processing error:', e);
    sendToSW({ type: MSG.captureError, tabId, error: e.message });
  }
}

function createSession(tabId) {
  return {
    tabId,
    state: 'idle',
    opChain: Promise.resolve(),
    processingChain: Promise.resolve(),
    audioCtx: null,
    source: null,
    analyser: null,
    monitorGain: null,
    mediaStream: null,
    recorder: null,
    segmentTimer: null,
    analysisTimer: null,
    segmentHasAudio: false,
    analyserReadCount: 0,
    stopping: false,
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
  session.stopping = true;

  if (session.segmentTimer) clearTimeout(session.segmentTimer);
  if (session.analysisTimer) clearInterval(session.analysisTimer);

  if (session.recorder && session.recorder.state !== 'inactive') {
    session.recorder.ondataavailable = null;
    session.recorder.onstop = null;
    session.recorder.onerror = null;
    try { session.recorder.stop(); } catch { }
  }
  session.recorder = null;

  disconnectNode(session.monitorGain);
  disconnectNode(session.analyser);
  disconnectNode(session.source);
  session.mediaStream?.getTracks().forEach((track) => track.stop());

  await closeAudioContext(session.audioCtx);

  session.monitorGain = null;
  session.analyser = null;
  session.source = null;
  session.mediaStream = null;
  session.audioCtx = null;
  session.segmentTimer = null;
  session.analysisTimer = null;
  session.state = 'idle';
  sessions.delete(session.tabId);
}

function getRecorderMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Unable to read recorded audio.'));
    reader.onloadend = () => {
      const result = reader.result;
      resolve(typeof result === 'string' ? result.split(',')[1] || '' : '');
    };
    reader.readAsDataURL(blob);
  });
}

function queueAudioSegment(session, blob, mimeType) {
  if (blob.size < MIN_AUDIO_BYTES) return;

  session.processingChain = session.processingChain
    .then(async () => {
      if (sessions.get(session.tabId) !== session || session.stopping) return;
      console.log(`[BabelLive-Offscreen] Captured ${blob.size} bytes of ${mimeType || 'audio'} for tab ${session.tabId}`);
      await handleAudioBuffer(session.tabId, blob, mimeType || 'audio/webm');
    })
    .catch((error) => {
      console.warn('[BabelLive-Offscreen] Failed to process recorded audio:', error);
    });
}

function startSignalAnalysis(session) {
  // MediaRecorder works independently of Web Audio. If the context cannot run in
  // the offscreen document, leave analyserReadCount at zero so segments are kept.
  if (session.audioCtx.state !== 'running') return;

  const samples = new Float32Array(session.analyser.fftSize);
  session.analysisTimer = setInterval(() => {
    if (sessions.get(session.tabId) !== session || session.stopping) return;

    session.analyser.getFloatTimeDomainData(samples);
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
    const rms = Math.sqrt(sumSquares / samples.length);
    session.analyserReadCount += 1;
    if (rms >= AUDIO_RMS_THRESHOLD) session.segmentHasAudio = true;
  }, 100);
}

function startRecorderSegment(session) {
  if (sessions.get(session.tabId) !== session || session.stopping) return;

  const mimeType = getRecorderMimeType();
  const options = { audioBitsPerSecond: 64000 };
  if (mimeType) options.mimeType = mimeType;

  const recorder = new MediaRecorder(session.mediaStream, options);
  const chunks = [];
  session.recorder = recorder;
  session.segmentHasAudio = false;
  session.analyserReadCount = 0;

  recorder.ondataavailable = (event) => {
    if (event.data?.size) chunks.push(event.data);
  };

  recorder.onerror = (event) => {
    const error = event.error || new Error('MediaRecorder failed while capturing tab audio.');
    console.error('[BabelLive-Offscreen] MediaRecorder error:', error);
    sendToSW({ type: MSG.captureError, tabId: session.tabId, error: error.message });
  };

  recorder.onstop = () => {
    if (session.segmentTimer) clearTimeout(session.segmentTimer);
    session.segmentTimer = null;
    if (sessions.get(session.tabId) !== session || session.stopping) return;

    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
    // If analysis could not run, keep the segment instead of silently losing audio.
    if (session.segmentHasAudio || session.analyserReadCount === 0) {
      queueAudioSegment(session, blob, recorder.mimeType || mimeType);
    }

    // A fresh recorder makes every segment a complete, independently decodable file.
    startRecorderSegment(session);
  };

  recorder.start();
  session.segmentTimer = setTimeout(() => {
    if (session.recorder === recorder && recorder.state === 'recording') recorder.stop();
  }, SEGMENT_MS);
}

async function startCapture(streamId, tabId) {
  const session = getOrCreateSession(tabId);

  if (session.state === 'running') {
    sendToSW({ type: MSG.captureReady, tabId });
    return;
  }

  if (session.mediaStream || session.audioCtx || session.recorder) {
    await cleanupSession(session);
    sessions.set(tabId, createSession(tabId));
  }

  const current = getOrCreateSession(tabId);
  current.state = 'starting';
  current.stopping = false;
  console.log(`[BabelLive-Offscreen] Audio stream initialization begins for tab ${tabId} with streamId: ${streamId?.slice(0, 10)}...`);

  try {
    if (!streamId) throw new Error('Chrome did not provide a tab audio stream ID.');

    current.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });

    const audioTracks = current.mediaStream.getAudioTracks();
    if (audioTracks.length === 0) throw new Error('The selected tab did not expose an audio track.');
    audioTracks[0].addEventListener('ended', () => {
      if (sessions.get(tabId) !== current || current.stopping) return;
      cleanupSession(current).finally(() => {
        sendToSW({ type: MSG.captureEnded, tabId });
      });
    }, { once: true });

    current.audioCtx = new AudioContext();
    current.source = current.audioCtx.createMediaStreamSource(current.mediaStream);
    current.analyser = current.audioCtx.createAnalyser();
    current.analyser.fftSize = 2048;
    current.analyser.smoothingTimeConstant = 0.2;
    current.monitorGain = current.audioCtx.createGain();
    current.monitorGain.gain.value = 1;
    current.source.connect(current.analyser);
    current.analyser.connect(current.monitorGain);
    current.monitorGain.connect(current.audioCtx.destination);

    if (current.audioCtx.state === 'suspended') await current.audioCtx.resume();
    console.log(`[BabelLive-Offscreen] AudioContext state: ${current.audioCtx.state}`);
    console.log(`[BabelLive-Offscreen] Loopback destination connected for tab ${tabId}`);

    startSignalAnalysis(current);
    startRecorderSegment(current);
    console.log(`[BabelLive-Offscreen] MediaRecorder started with state: ${current.recorder.state}`);

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === MSG.startCapture && message.tabId != null) {
    if (message.settings) {
      sessionConfig.apiKey = message.settings.apiKeys || '';
      sessionConfig.sourceLang = message.settings.sourceLang || 'ja';
      sessionConfig.targetLang = message.settings.targetLang || 'vi';
      sessionConfig.cloudProvider = message.settings.cloudProvider || 'groq';
    }
    enqueueForTab(message.tabId, () => startCapture(message.streamId, message.tabId));
    sendResponse({ accepted: true });
    return false;
  } else if (message?.type === MSG.stopCapture && message.tabId != null) {
    enqueueForTab(message.tabId, () => stopCapture(message.tabId));
    sendResponse({ accepted: true });
    return false;
  }
  return false;
});
