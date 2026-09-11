/**
 * BabelLive — Fallback Translation Engine (Option 3)
 * Uses Google Translate's public web endpoint as a free fallback.
 * No API key required. Activated when:
 *   - User hasn't configured API keys
 *   - Machine doesn't support WebGPU
 *   - Primary engine fails (auto-fallback)
 *
 * Includes light rate limiting to avoid being blocked.
 */

/* ── Rate Limiter ────────────────────────────── */
const MIN_INTERVAL_MS = 1500; // Minimum 1.5s between requests
let lastRequestTime = 0;

async function respectRateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

/* ── Google Translate Language Codes ─────────── */
const LANG_MAP = {
  auto: 'auto',
  ja: 'ja',
  en: 'en',
  zh: 'zh-CN',
  ko: 'ko',
  vi: 'vi',
  fr: 'fr',
  de: 'de',
  es: 'es',
  ru: 'ru',
  th: 'th',
};

/**
 * Translate using Google Translate public endpoint.
 * @param {string} text - Text to translate
 * @param {string} sourceLang - Source language code
 * @param {string} targetLang - Target language code
 * @returns {Promise<string>} Translated text
 */
export async function translateFallback(text, sourceLang, targetLang) {
  if (!text || !text.trim()) return '';

  const sl = LANG_MAP[sourceLang] || 'auto';
  const tl = LANG_MAP[targetLang] || 'vi';

  await respectRateLimit();

  // Using the public Google Translate API endpoint
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Google Translate HTTP ${response.status}`);
    }

    const data = await response.json();

    // Response format: [[["translated text","original text",null,null,10]],null,"ja"]
    if (Array.isArray(data) && Array.isArray(data[0])) {
      const translatedParts = data[0]
        .filter((part) => Array.isArray(part) && part[0])
        .map((part) => part[0]);
      return translatedParts.join('');
    }

    throw new Error('Unexpected response format');
  } catch (err) {
    console.warn('[BabelLive Fallback] Translation error:', err.message);
    throw err;
  }
}

/**
 * Batch translate using fallback (sequential with rate limiting).
 */
export async function translateFallbackBatch(texts, sourceLang, targetLang) {
  const results = [];
  for (const text of texts) {
    const translated = await translateFallback(text, sourceLang, targetLang);
    results.push(translated);
  }
  return results;
}
