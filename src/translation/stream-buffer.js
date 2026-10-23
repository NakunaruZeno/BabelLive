/**
 * BabelLive — Stream Buffer Processor
 * Low-latency sentence boundary detection for real-time live-stream captions.
 *
 * Receives accumulated STT text, extracts grammatically complete sentences
 * immediately upon reaching a terminal boundary, and preserves incomplete
 * trailing clauses in the buffer for the next incoming chunk.
 *
 * Design: Pure rule-based, zero external dependencies, < 1ms processing time.
 * Supports: Japanese (primary), English, and generic punctuation fallback.
 */

/* ── Japanese Grammar Rules ─────────────────────── */

/**
 * Terminal forms that signal a complete sentence in Japanese.
 * Ordered from longest match to shortest to prevent partial matches.
 */
const JA_TERMINAL_FORMS = [
  // Polite past
  'でした', 'ました',
  // Polite present
  'です', 'ます',
  // Plain past / ta-form as sentence-ender
  'った', 'んだ', 'のだ',
  // Copula / plain
  'だ',
  // Common auxiliary endings
  'ない', 'たい', 'らしい', 'みたい', 'ようだ', 'そうだ',
  // Volitional
  'ましょう', 'よう', 'だろう', 'でしょう',
  // Imperative
  'なさい', 'ください',
  // Potential / passive endings when sentence-final
  'れる', 'られる',
];

/**
 * Final particles that can terminate a Japanese sentence when they appear
 * after a terminal verb form or at the end of an utterance.
 */
const JA_FINAL_PARTICLES = ['かよ', 'かね', 'かな', 'のか', 'ね', 'よ', 'わ', 'ぞ', 'ぜ', 'な', 'さ', 'か'];

/**
 * Non-terminal continuation markers — if the text ends with these,
 * the sentence is grammatically incomplete and MUST NOT be cut.
 */
const JA_NON_TERMINAL_SUFFIXES = [
  // Subordinating conjunctions / reason markers (longest first)
  'けれども', 'けれど', 'けども',
  'だけど', 'ですけど', 'ますけど',
  'ですから', 'ますから', 'から',
  'なので', 'ので',
  'なのに', 'のに',
  'ために',
  'ながら',
  // Conditional
  'ならば', 'なら', 'れば', 'たら',
  // Continuation / te-form patterns
  'して', 'って', 'いて', 'きて', 'ぎて', 'んで',
  'ちて', 'にて', 'びて', 'みて', 'りて',
  // Listing / ongoing
  'たりして', 'たり', 'とか',
  // Quotative without following verb
  'と', 'って',
  // Coordinating conjunctions
  'そして', 'それで', 'だから', 'でも', 'しかし', 'ただ',
  // Case particles (phrase-level, not sentence-level)
  'が', 'は', 'を', 'に', 'へ', 'で', 'の', 'も',
];

/**
 * Punctuation that acts as a hard sentence boundary in Japanese.
 */
const JA_TERMINAL_PUNCTUATION = ['。', '！', '？', '!', '?'];

/* ── English Grammar Rules ──────────────────────── */

/**
 * English trailing conjunctions / subordinators that indicate
 * an incomplete clause. If the text ends with one of these words,
 * do NOT cut.
 */
const EN_DANGLING_CONJUNCTIONS = [
  'because', 'since', 'although', 'though', 'while', 'when',
  'where', 'if', 'unless', 'until', 'before', 'after',
  'but', 'and', 'or', 'nor', 'so', 'yet', 'for',
  'that', 'which', 'who', 'whom', 'whose',
  'however', 'moreover', 'furthermore', 'therefore',
  'whereas', 'whereby', 'whether',
];

/* ── Stream Buffer Processor ────────────────────── */

export class StreamBufferProcessor {
  /**
   * @param {string} sourceLang — ISO 639-1 language code (e.g. 'ja', 'en')
   */
  constructor(sourceLang = 'ja') {
    this.sourceLang = sourceLang;
    this.buffer = '';
  }

  /**
   * Feed new STT text into the buffer and extract complete sentences.
   * @param {string} newText — raw transcription from STT
   * @returns {{ completed: string[], remaining: string }}
   */
  process(newText) {
    if (!newText || !newText.trim()) {
      return { completed: [], remaining: this.buffer };
    }

    // Append new text to accumulated buffer
    // Add a space separator for English; no separator for CJK languages
    if (this.buffer && this._needsSeparator()) {
      this.buffer += ' ' + newText.trim();
    } else {
      this.buffer += newText.trim();
    }

    let result;
    switch (this.sourceLang) {
      case 'ja':
        result = this._processJapanese();
        break;
      case 'en':
        result = this._processEnglish();
        break;
      default:
        result = this._processGeneric();
        break;
    }

    this.buffer = result.remaining;
    return result;
  }

  /**
   * Force-emit everything currently in the buffer.
   * Used when session ends or after a long silence.
   * @returns {{ completed: string[], remaining: string }}
   */
  flush() {
    const text = this.buffer.trim();
    this.buffer = '';
    if (!text) return { completed: [], remaining: '' };
    return { completed: [text], remaining: '' };
  }

  /**
   * Clear all buffer state.
   */
  reset() {
    this.buffer = '';
  }

  /**
   * Check if we need a space separator when appending.
   * CJK scripts don't use spaces between words.
   */
  _needsSeparator() {
    return !['ja', 'zh', 'ko', 'th'].includes(this.sourceLang);
  }

  /* ── Japanese Processor ───────────────────────── */

  _processJapanese() {
    const text = this.buffer;
    const completed = [];
    let cursor = 0;

    // Scan through the text looking for sentence boundaries
    let i = 0;
    while (i < text.length) {
      // 1. Check for hard punctuation boundaries
      if (JA_TERMINAL_PUNCTUATION.includes(text[i])) {
        const sentence = text.substring(cursor, i + 1).trim();
        if (sentence && sentence.length > 1) {
          // Avoid pushing standalone punctuation (e.g., just '。')
          completed.push(sentence);
        } else if (sentence && sentence.length === 1 && completed.length > 0) {
          // Append lone punctuation to the previous completed sentence
          // This handles cases like terminal form + 。 where both matched
          const prev = completed[completed.length - 1];
          const prevLast = prev[prev.length - 1];
          if (!JA_TERMINAL_PUNCTUATION.includes(prevLast)) {
            completed[completed.length - 1] = prev.slice(0, -1) + sentence;
          }
          // Otherwise just skip it (already punctuated)
        }
        cursor = i + 1;
        i = cursor;
        continue;
      }

      // 2. Check for terminal form at this position
      const terminalMatch = this._matchJapaneseTerminal(text, i);
      if (terminalMatch !== null) {
        let endPos = terminalMatch.endPos;

        // Check what comes after the terminal form
        const afterTerminal = text.substring(endPos);

        // Guard: if the text after terminal starts with a continuation marker,
        // the sentence is NOT complete (e.g., "ですけど" → don't cut at "です")
        if (afterTerminal && this._startsWithContinuation(afterTerminal)) {
          i++;
          continue;
        }

        // Check for optional final particle after the terminal form
        for (const particle of JA_FINAL_PARTICLES) {
          if (afterTerminal.startsWith(particle)) {
            endPos += particle.length;
            break;
          }
        }

        // Consume any trailing punctuation immediately after
        while (endPos < text.length && JA_TERMINAL_PUNCTUATION.includes(text[endPos])) {
          endPos++;
        }

        const remaining = text.substring(endPos).trim();

        // Guard: if there's barely any remaining text and it doesn't look
        // like a new sentence, skip this boundary
        if (remaining && remaining.length > 0 && remaining.length < 2) {
          i++;
          continue;
        }

        // Commit this sentence
        const candidateSentence = text.substring(cursor, endPos).trim();
        if (candidateSentence) {
          const lastChar = candidateSentence[candidateSentence.length - 1];
          if (!JA_TERMINAL_PUNCTUATION.includes(lastChar)) {
            completed.push(candidateSentence + '。');
          } else {
            completed.push(candidateSentence);
          }
        }
        cursor = endPos;
        i = cursor;
        continue;
      }

      i++;
    }

    const remaining = text.substring(cursor).trim();
    return { completed, remaining };
  }

  /**
   * Try to match a Japanese terminal form at exactly position `pos`.
   * Returns { endPos } if a terminal form starts at pos, or null.
   */
  _matchJapaneseTerminal(text, pos) {
    const slice = text.substring(pos);
    for (const term of JA_TERMINAL_FORMS) {
      if (slice.startsWith(term)) {
        return { endPos: pos + term.length };
      }
    }
    return null;
  }

  /**
   * Check if `text` starts with a continuation marker that would make
   * the preceding terminal form non-final.
   */
  _startsWithContinuation(text) {
    // Check subordinating conjunctions and continuation forms
    const continuationMarkers = [
      'けれども', 'けれど', 'けども', 'けど',
      'から', 'ので', 'のに',
      'ために', 'ながら',
      'なら', 'ならば',
      'りして', 'り', // たり listing continuation (after った match)
      'し', // listing reason: 〜だし、〜だし
      'が', // adversative: 〜ですが
      'て', 'で', // te-form continuation
      'と', // conditional/quotative
      'たり',
    ];

    for (const marker of continuationMarkers) {
      if (text.startsWith(marker)) {
        return true;
      }
    }
    return false;
  }

  /* ── English Processor ────────────────────────── */

  _processEnglish() {
    const text = this.buffer;
    const completed = [];

    // Split on sentence-ending punctuation followed by space or end
    const segments = text.split(/(?<=[.!?])\s+/);

    if (segments.length <= 1) {
      // No boundary found — check if the whole text ends with punctuation
      if (/[.!?]$/.test(text.trim())) {
        if (!this._endsWithDanglingConjunction(text.trim())) {
          return { completed: [text.trim()], remaining: '' };
        }
      }
      return { completed: [], remaining: text };
    }

    // All segments except the last are complete
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i].trim();
      if (seg) {
        completed.push(seg);
      }
    }

    // Evaluate the last segment
    let lastSegment = segments[segments.length - 1].trim();

    if (lastSegment) {
      if (/[.!?]$/.test(lastSegment)) {
        if (!this._endsWithDanglingConjunction(lastSegment)) {
          completed.push(lastSegment);
          return { completed, remaining: '' };
        }
        return { completed, remaining: lastSegment };
      }
      // Doesn't end with punctuation — keep in buffer
      return { completed, remaining: lastSegment };
    }

    return { completed, remaining: '' };
  }

  /**
   * Check if English text ends with a dangling conjunction/subordinator.
   */
  _endsWithDanglingConjunction(text) {
    const words = text.trim().split(/\s+/);
    if (words.length === 0) return false;
    const lastWord = words[words.length - 1].toLowerCase().replace(/[.,;:!?]$/, '');
    return EN_DANGLING_CONJUNCTIONS.includes(lastWord);
  }

  /* ── Generic Processor (other languages) ──────── */

  _processGeneric() {
    const text = this.buffer;
    const completed = [];

    // Universal punctuation split
    const segments = text.split(/(?<=[.!?。！？])\s*/);

    if (segments.length <= 1) {
      // Check if ends with punctuation
      if (/[.!?。！？]$/.test(text.trim())) {
        return { completed: [text.trim()], remaining: '' };
      }
      return { completed: [], remaining: text };
    }

    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i].trim();
      if (seg) completed.push(seg);
    }

    const last = segments[segments.length - 1].trim();
    if (last && /[.!?。！？]$/.test(last)) {
      completed.push(last);
      return { completed, remaining: '' };
    }

    return { completed, remaining: last || '' };
  }
}

/**
 * Factory: create a StreamBufferProcessor for the given source language.
 * @param {string} sourceLang
 * @returns {StreamBufferProcessor}
 */
export function createStreamBuffer(sourceLang = 'ja') {
  return new StreamBufferProcessor(sourceLang);
}
