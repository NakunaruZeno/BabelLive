const assert = require('node:assert/strict');
const test = require('node:test');

const waitFor = async (predicate, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for capture state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('records complete segments and routes audio to the selected provider', async () => {
  let messageListener;
  const sentMessages = [];
  const apiRequests = [];
  const groqTranscriptions = [];
  const groqTranslations = [];

  global.chrome = {
    runtime: {
      onMessage: { addListener: (listener) => { messageListener = listener; } },
      sendMessage: async (message) => { sentMessages.push(message); },
    },
    storage: { local: { get: async () => ({}) } },
  };

  const track = { stop() {}, addEventListener() {} };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => stream } },
  });

  const node = () => ({ connect() {}, disconnect() {} });
  global.AudioContext = class {
    constructor() { this.state = 'running'; this.destination = {}; }
    createMediaStreamSource() { return node(); }
    createAnalyser() {
      return {
        ...node(),
        fftSize: 2048,
        smoothingTimeConstant: 0,
        getFloatTimeDomainData(samples) { samples.fill(0); },
      };
    }
    createGain() { return { ...node(), gain: { value: 0 } }; }
    async close() { this.state = 'closed'; }
  };

  class FakeMediaRecorder {
    static instances = [];
    static isTypeSupported(type) { return type.startsWith('audio/webm'); }
    constructor(_stream, options) {
      this.id = FakeMediaRecorder.instances.length + 1;
      this.mimeType = options.mimeType;
      this.state = 'inactive';
      FakeMediaRecorder.instances.push(this);
    }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      const bytes = new Uint8Array(2048).fill(this.id);
      this.ondataavailable?.({ data: new Blob([bytes], { type: this.mimeType }) });
      this.onstop?.();
    }
  }
  global.MediaRecorder = FakeMediaRecorder;

  global.FileReader = class {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
        this.onloadend?.();
      }, (error) => {
        this.error = error;
        this.onerror?.();
      });
    }
  };

  global.fetch = async (url, options) => {
    if (url.includes('/audio/transcriptions')) {
      groqTranscriptions.push(options);
      return { ok: true, status: 200, json: async () => ({ text: 'heard by groq' }) };
    }
    if (url.includes('api.groq.com') && url.includes('/chat/completions')) {
      groqTranslations.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'groq da nghe' } }] }),
      };
    }

    apiRequests.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"original":"heard","translated":"da nghe"}' }] } }],
      }),
    };
  };

  require('../src/offscreen.js');
  assert.equal(typeof messageListener, 'function');

  let response;
  messageListener({
    type: 'BABELLIVE_START_CAPTURE',
    tabId: 7,
    streamId: 'stream-id',
    settings: { apiKeys: 'AIza-test', sourceLang: 'en', targetLang: 'vi', cloudProvider: 'gemini' },
  }, {}, (value) => { response = value; });

  assert.deepEqual(response, { accepted: true });
  await waitFor(() => FakeMediaRecorder.instances.length === 1);

  FakeMediaRecorder.instances[0].stop();
  await waitFor(() => apiRequests.length === 1 && FakeMediaRecorder.instances.length === 2);
  FakeMediaRecorder.instances[1].stop();
  await waitFor(() => apiRequests.length === 2 && FakeMediaRecorder.instances.length === 3);

  const audioParts = apiRequests.map((request) => request.contents[0].parts[0].inlineData);
  assert.equal(audioParts[0].mimeType, 'audio/webm');
  assert.equal(Buffer.from(audioParts[0].data, 'base64')[0], 1);
  assert.equal(Buffer.from(audioParts[1].data, 'base64')[0], 2);
  assert.equal(sentMessages.filter((message) => message.type === 'BABELLIVE_CAPTURE_READY').length, 1);
  assert.equal(sentMessages.filter((message) => message.type === 'BABELLIVE_SUBTITLE_BROADCAST').length, 2);

  messageListener({ type: 'BABELLIVE_STOP_CAPTURE', tabId: 7 }, {}, () => {});
  await waitFor(() => sentMessages.some((message) => message.type === 'BABELLIVE_CAPTURE_ENDED'));

  messageListener({
    type: 'BABELLIVE_START_CAPTURE',
    tabId: 8,
    streamId: 'stream-id-2',
    settings: { apiKeys: 'gsk-test', sourceLang: 'en', targetLang: 'vi', cloudProvider: 'groq' },
  }, {}, () => {});
  await waitFor(() => FakeMediaRecorder.instances.length === 4);
  FakeMediaRecorder.instances[3].stop();
  await waitFor(() => groqTranscriptions.length === 1 && groqTranslations.length === 1);

  const transcriptionForm = groqTranscriptions[0].body;
  assert.equal(transcriptionForm.get('model'), 'whisper-large-v3-turbo');
  assert.equal(transcriptionForm.get('language'), 'en');
  assert.equal(transcriptionForm.get('file').size, 2048);
  assert.equal(groqTranslations[0].model, 'llama-3.1-8b-instant');
  assert.ok(sentMessages.some((message) => (
    message.type === 'BABELLIVE_SUBTITLE_BROADCAST'
    && message.original === 'heard by groq'
    && message.translated === 'groq da nghe'
  )));

  messageListener({ type: 'BABELLIVE_STOP_CAPTURE', tabId: 8 }, {}, () => {});
  await waitFor(() => sentMessages.filter((message) => message.type === 'BABELLIVE_CAPTURE_ENDED').length === 2);
});
