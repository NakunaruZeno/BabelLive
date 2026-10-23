/**
 * BabelLive — Translation Router
 * Central module that dispatches translation requests to the active engine.
 * Provides a unified API: translate(text, sourceLang, targetLang) → Promise<string>
 * Handles auto-fallback when the primary engine fails.
 */

import { translateCloud, translateCloudBatch } from './cloud-llm.js';
import { translateFallback } from './fallback-translate.js';
// local-webgpu removed: WebGPU is not supported in MV3 USER_MEDIA offscreen context.

const STORAGE_KEY = 'babellive_settings';

/**
 * Get current engine preference from storage.
 */
async function getEnginePreference() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return result[STORAGE_KEY]?.engine || 'cloud';
  } catch {
    return 'cloud';
  }
}

/**
 * Get all settings from storage.
 */
async function getSettings() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return result[STORAGE_KEY] || {};
  } catch {
    return {};
  }
}

/**
 * Translate text using the active engine with auto-fallback.
 * @param {string} text - Text to translate
 * @param {string} sourceLang - Source language code
 * @param {string} targetLang - Target language code
 * @returns {Promise<string>} Translated text
 */
export async function translate(text, sourceLang, targetLang) {
  if (!text || !text.trim()) return '';

  const settings = await getSettings();
  const engine = settings.engine || 'cloud';

  try {
    switch (engine) {
      case 'cloud':
        return await translateCloud(text, sourceLang, targetLang, settings);

      case 'local':
        // Local WebGPU is not supported in Chrome MV3 extension offscreen context.
        // Falling back to Google Translate free endpoint.
        console.warn('[BabelLive] Local engine not available in extension context. Using fallback.');
        return await translateFallback(text, sourceLang, targetLang);

      case 'fallback':
        return await translateFallback(text, sourceLang, targetLang);

      default:
        return await translateFallback(text, sourceLang, targetLang);
    }
  } catch (primaryError) {
    console.warn(`[BabelLive] Primary engine (${engine}) failed:`, primaryError.message);

    // Auto-fallback chain: cloud → fallback, local → fallback
    if (engine !== 'fallback') {
      try {
        console.log('[BabelLive] Falling back to Google Translate endpoint');
        return await translateFallback(text, sourceLang, targetLang);
      } catch (fallbackError) {
        console.error('[BabelLive] Fallback also failed:', fallbackError.message);
        throw fallbackError;
      }
    }

    throw primaryError;
  }
}

/**
 * Batch translate multiple texts.
 * Used by Smart Sentence Batching in cloud-llm.js
 * @param {string[]} texts - Array of texts
 * @param {string} sourceLang
 * @param {string} targetLang
 * @returns {Promise<string[]>}
 */
export async function translateBatch(texts, sourceLang, targetLang) {
  const settings = await getSettings();
  const engine = settings.engine || 'cloud';

  if (engine === 'cloud') {
    // Cloud LLM can handle batch natively via prompt
    return translateCloudBatch(texts, sourceLang, targetLang, settings);
  }

  // Other engines: translate individually
  return Promise.all(texts.map((t) => translate(t, sourceLang, targetLang)));
}
