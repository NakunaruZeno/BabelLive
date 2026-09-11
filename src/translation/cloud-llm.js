/**
 * BabelLive — Cloud LLM Translation Engine (Option 1)
 * Supports Groq and Gemini Flash APIs.
 * Features:
 *   - Smart Sentence Batching: accumulates sentences over a 3-5s window into one request
 *   - Multi-Key Rotation: round-robin across multiple API keys with cooldown on rate-limited ones
 *   - Rate Limiter: token bucket algorithm (30 RPM Groq, 15 RPM Gemini)
 *   - Retry with exponential backoff
 */

/* ── Provider Configs ────────────────────────── */
const PROVIDERS = {
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.1-8b-instant',
    maxRPM: 30,
    headerKey: 'Authorization',
    headerPrefix: 'Bearer ',
  },
  gemini: {
    name: 'Gemini Flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent',
    maxRPM: 15,
    headerKey: 'x-goog-api-key',
    headerPrefix: '',
  },
};

/* ── Language Names (for prompt) ─────────────── */
const LANG_NAMES = {
  auto: 'the source language',
  ja: 'Japanese', en: 'English', zh: 'Chinese', ko: 'Korean',
  vi: 'Vietnamese', fr: 'French', de: 'German', es: 'Spanish',
  ru: 'Russian', th: 'Thai',
};

/* ── Multi-Key Rotation ──────────────────────── */
class KeyRotator {
  constructor() {
    this.keys = [];
    this.index = 0;
    this.cooldowns = new Map(); // key → timestamp when cooldown ends
  }

  setKeys(keysStr) {
    this.keys = (keysStr || '').split(',').map((k) => k.trim()).filter(Boolean);
    this.index = 0;
    this.cooldowns.clear();
  }

  getNextKey() {
    if (this.keys.length === 0) return null;

    const now = Date.now();
    const total = this.keys.length;

    for (let i = 0; i < total; i++) {
      const idx = (this.index + i) % total;
      const key = this.keys[idx];
      const cooldownEnd = this.cooldowns.get(key) || 0;

      if (now >= cooldownEnd) {
        this.index = (idx + 1) % total;
        return key;
      }
    }

    // All keys are in cooldown — return the one with shortest remaining cooldown
    let bestKey = this.keys[0];
    let bestEnd = this.cooldowns.get(bestKey) || 0;
    for (const key of this.keys) {
      const end = this.cooldowns.get(key) || 0;
      if (end < bestEnd) { bestEnd = end; bestKey = key; }
    }
    return bestKey;
  }

  markRateLimited(key) {
    // Cooldown for 65 seconds (slightly over 1 minute to be safe)
    this.cooldowns.set(key, Date.now() + 65_000);
  }

  get hasKeys() {
    return this.keys.length > 0;
  }
}

/* ── Rate Limiter (Token Bucket) ─────────────── */
class RateLimiter {
  constructor(maxRPM) {
    this.maxRPM = maxRPM;
    this.tokens = maxRPM;
    this.lastRefill = Date.now();
    this.intervalMs = 60_000 / maxRPM;
  }

  async acquire() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // Wait until a token is available
    const waitMs = this.intervalMs - (Date.now() - this.lastRefill) % this.intervalMs;
    await new Promise((r) => setTimeout(r, waitMs + 50));
    this._refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = elapsed / this.intervalMs;
    this.tokens = Math.min(this.maxRPM, this.tokens + newTokens);
    this.lastRefill = now;
  }

  updateRPM(rpm) {
    this.maxRPM = rpm;
    this.intervalMs = 60_000 / rpm;
  }
}

/* ── Smart Sentence Batching ─────────────────── */
class SentenceBatcher {
  constructor(flushCallback, windowMs = 4000) {
    this.buffer = [];
    this.resolvers = [];
    this.windowMs = windowMs;
    this.timer = null;
    this.flushCallback = flushCallback;
  }

  add(text) {
    return new Promise((resolve, reject) => {
      this.buffer.push(text);
      this.resolvers.push({ resolve, reject });

      if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.windowMs);
      }
    });
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.buffer.length === 0) return;

    const batch = [...this.buffer];
    const resolvers = [...this.resolvers];
    this.buffer = [];
    this.resolvers = [];

    try {
      const results = await this.flushCallback(batch);
      resolvers.forEach((r, i) => r.resolve(results[i] || ''));
    } catch (err) {
      resolvers.forEach((r) => r.reject(err));
    }
  }
}

/* ── Singletons ──────────────────────────────── */
const keyRotator = new KeyRotator();
const rateLimiters = {
  groq: new RateLimiter(30),
  gemini: new RateLimiter(15),
};

let currentProvider = 'groq';
let batcher = null;

/* ── Build Translation Prompt ────────────────── */
function buildPrompt(texts, sourceLang, targetLang) {
  const srcName = LANG_NAMES[sourceLang] || sourceLang;
  const tgtName = LANG_NAMES[targetLang] || targetLang;
  const isBatch = texts.length > 1;

  const systemPrompt = `You are a professional subtitle translator. Translate the following ${isBatch ? 'lines' : 'line'} from ${srcName} to ${tgtName}. Rules:
- Keep translations natural, concise, and suitable for video subtitles
- Maintain the original tone and intent
- Do NOT add explanations, notes, or extra text
- ${isBatch ? `Return exactly ${texts.length} lines, one translation per line, in the same order` : 'Return only the translated text'}`;

  const userContent = isBatch
    ? texts.map((t, i) => `[${i + 1}] ${t}`).join('\n')
    : texts[0];

  return { systemPrompt, userContent };
}

/* ── API Call: Groq (OpenAI-compatible) ──────── */
async function callGroq(systemPrompt, userContent, apiKey) {
  const config = PROVIDERS.groq;
  const response = await fetch(config.baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [config.headerKey]: `${config.headerPrefix}${apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    }),
  });

  if (response.status === 429) {
    throw new RateLimitError(apiKey);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Groq API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

/* ── API Call: Gemini Flash ──────────────────── */
async function callGemini(systemPrompt, userContent, apiKey) {
  const config = PROVIDERS.gemini;
  const url = `${config.baseUrl}?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userContent }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 2000,
      },
    }),
  });

  if (response.status === 429) {
    throw new RateLimitError(apiKey);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

/* ── Rate Limit Error ────────────────────────── */
class RateLimitError extends Error {
  constructor(key) {
    super('Rate limited');
    this.name = 'RateLimitError';
    this.key = key;
  }
}

/* ── Core Translation (with retry) ───────────── */
async function callProvider(texts, sourceLang, targetLang, settings, retries = 2) {
  const provider = settings.cloudProvider || 'groq';
  currentProvider = provider;
  keyRotator.setKeys(settings.apiKeys || '');

  if (!keyRotator.hasKeys) {
    throw new Error('No API keys configured. Please add your API key in the popup.');
  }

  const { systemPrompt, userContent } = buildPrompt(texts, sourceLang, targetLang);
  const limiter = rateLimiters[provider];

  for (let attempt = 0; attempt <= retries; attempt++) {
    const apiKey = keyRotator.getNextKey();
    if (!apiKey) throw new Error('All API keys exhausted');

    try {
      await limiter.acquire();

      let result;
      if (provider === 'groq') {
        result = await callGroq(systemPrompt, userContent, apiKey);
      } else {
        result = await callGemini(systemPrompt, userContent, apiKey);
      }

      return result;
    } catch (err) {
      if (err instanceof RateLimitError) {
        keyRotator.markRateLimited(err.key);
        console.warn(`[BabelLive Cloud] Key rate-limited, rotating...`);
        continue;
      }

      if (attempt < retries) {
        const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      throw err;
    }
  }

  throw new Error('All retries exhausted');
}

/* ── Parse Batch Response ────────────────────── */
function parseBatchResponse(response, count) {
  const lines = response.split('\n')
    .map((l) => l.replace(/^\[\d+\]\s*/, '').trim())
    .filter(Boolean);

  // If we got the right number of lines, return them
  if (lines.length === count) return lines;

  // If more lines, take the first `count`
  if (lines.length > count) return lines.slice(0, count);

  // If fewer, pad with empty strings
  while (lines.length < count) lines.push('');
  return lines;
}

/* ── Public API ──────────────────────────────── */

/**
 * Translate a single text using Cloud LLM.
 * Uses Smart Sentence Batching: the call is queued and flushed after a 4s window.
 */
export async function translateCloud(text, sourceLang, targetLang, settings) {
  // For single requests, we can also batch them
  if (!batcher || batcher._sourceLang !== sourceLang || batcher._targetLang !== targetLang) {
    batcher = new SentenceBatcher(async (batch) => {
      const response = await callProvider(batch, sourceLang, targetLang, settings);
      return batch.length === 1 ? [response] : parseBatchResponse(response, batch.length);
    }, 4000);
    batcher._sourceLang = sourceLang;
    batcher._targetLang = targetLang;
  }

  return batcher.add(text);
}

/**
 * Translate a batch of texts directly (bypasses batching window).
 */
export async function translateCloudBatch(texts, sourceLang, targetLang, settings) {
  const response = await callProvider(texts, sourceLang, targetLang, settings);
  return texts.length === 1 ? [response] : parseBatchResponse(response, texts.length);
}
