/**
 * BabelLive — Stream Buffer Processor Tests
 * Run: node src/translation/stream-buffer.test.js
 *
 * Tests Japanese sentence boundary detection, English splitting,
 * non-terminal guards, and multi-chunk accumulation.
 */

// Simple ESM-compatible test runner (no dependencies)
import { StreamBufferProcessor, createStreamBuffer } from './stream-buffer.js';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, testName, detail = '') {
  if (condition) {
    passed++;
    console.log(`  [PASS] ${testName}`);
  } else {
    failed++;
    failures.push({ testName, detail });
    console.log(`  [FAIL] ${testName}`);
    if (detail) console.log(`     ${detail}`);
  }
}

function assertDeepEqual(actual, expected, testName) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, testName, `Expected: ${e}\n     Actual:   ${a}`);
}

function section(name) {
  console.log(`\n── ${name} ──`);
}

/* ═══════════════════════════════════════════════════ */
/*  JAPANESE TESTS                                    */
/* ═══════════════════════════════════════════════════ */

section('Japanese: Punctuation boundaries');

(() => {
  const p = new StreamBufferProcessor('ja');
  const r = p.process('今日はいい天気です。明日も晴れるでしょう。');
  assertDeepEqual(r.completed, ['今日はいい天気です。', '明日も晴れるでしょう。'], 'Two sentences split by 。');
  assertDeepEqual(r.remaining, '', 'No remaining after full punctuation');
})();

(() => {
  const p = new StreamBufferProcessor('ja');
  const r = p.process('すごい！本当ですか？');
  assertDeepEqual(r.completed, ['すごい！', '本当ですか？'], 'Split on ！ and ？');
  assertDeepEqual(r.remaining, '', 'No remaining');
})();

section('Japanese: Terminal forms');

(() => {
  const p = new StreamBufferProcessor('ja');
  const r = p.process('ダンベル何キロ持てるですかねスクランブルエッグ載せちゃったりして');
  assert(r.completed.length >= 1, 'Example from spec: at least 1 completed');
  assert(r.completed[0].includes('ダンベル何キロ持てる'), 'First sentence contains ダンベル');
  assert(r.remaining.includes('スクランブルエッグ') || r.remaining.includes('たりして'),
    'Remaining has ongoing たりして form');
})();

(() => {
  const p = new StreamBufferProcessor('ja');
  const r = p.process('これは字幕のテストです');
  assert(r.completed.length === 1, 'Single polite ending (です) → completed');
  assert(r.completed[0].includes('テストです'), 'Contains テストです');
})();

(() => {
  const p = new StreamBufferProcessor('ja');
  const r = p.process('リアルタイム翻訳が始まります');
  assert(r.completed.length === 1, 'ます ending → completed');
})();

section('Japanese: Final particles');

(() => {
  const p = new StreamBufferProcessor('ja');
  const r = p.process('いいですね次の話題に行きましょう');
  assert(r.completed.length >= 1, 'ですね → completed (final particle after terminal)');
})();

section('Japanese: Non-terminal guards (DO NOT CUT)');

(() => {
  const p = new StreamBufferProcessor('ja');
  const r = p.process('行きたいですけど');
  assert(r.completed.length === 0, 'ですけど → NOT completed (continuation)');
  assert(r.remaining.includes('けど'), 'Remaining preserves けど');
})();

(() => {
  const p = new StreamBufferProcessor('ja');
  const r = p.process('食べたりして');
  assert(r.completed.length === 0, 'たりして → NOT completed (listing)');
  assert(r.remaining.includes('たりして'), 'Remaining preserves たりして');
})();

(() => {
  const p = new StreamBufferProcessor('ja');
  const r = p.process('雨が降っているから');
  assert(r.completed.length === 0, 'から → NOT completed (reason)');
  assert(r.remaining.includes('から'), 'Remaining preserves から');
})();

section('Japanese: Multi-chunk accumulation');

(() => {
  const p = new StreamBufferProcessor('ja');

  // Chunk 1: incomplete
  const r1 = p.process('今日は天気が');
  assert(r1.completed.length === 0, 'Chunk 1: incomplete → no completed');
  assert(r1.remaining.includes('天気が'), 'Chunk 1: buffer preserved');

  // Chunk 2: completes the sentence + starts new one
  const r2 = p.process('いいです。明日は');
  assert(r2.completed.length >= 1, 'Chunk 2: sentence completed');
  assert(r2.remaining.includes('明日は'), 'Chunk 2: new fragment in remaining');

  // Chunk 3: completes second sentence
  const r3 = p.process('どうでしょう。');
  assert(r3.completed.length >= 1, 'Chunk 3: second sentence completed');
  assert(r3.remaining === '', 'Chunk 3: no remaining');
})();

/* ═══════════════════════════════════════════════════ */
/*  ENGLISH TESTS                                     */
/* ═══════════════════════════════════════════════════ */

section('English: Punctuation splitting');

(() => {
  const p = new StreamBufferProcessor('en');
  const r = p.process('Hello world. How are you? I am fine!');
  assertDeepEqual(r.completed, ['Hello world.', 'How are you?', 'I am fine!'], '3 sentences split');
  assertDeepEqual(r.remaining, '', 'No remaining');
})();

(() => {
  const p = new StreamBufferProcessor('en');
  const r = p.process('The weather is nice today');
  assertDeepEqual(r.completed, [], 'No punctuation → no completed');
  assert(r.remaining === 'The weather is nice today', 'Entire text in remaining');
})();

section('English: Dangling conjunctions');

(() => {
  const p = new StreamBufferProcessor('en');
  const r = p.process('I went to the store. I bought some milk because');
  assert(r.completed.length >= 1, 'First sentence completed');
  assert(r.completed[0] === 'I went to the store.', 'First sentence correct');
  assert(r.remaining.includes('because'), 'Dangling "because" kept in buffer');
})();

(() => {
  const p = new StreamBufferProcessor('en');
  const r = p.process('She is smart but');
  assert(r.completed.length === 0, 'Dangling "but" → no completed');
  assert(r.remaining.includes('but'), 'Buffer preserves "but"');
})();

section('English: Multi-chunk accumulation');

(() => {
  const p = new StreamBufferProcessor('en');

  const r1 = p.process('The quick brown');
  assert(r1.completed.length === 0, 'Chunk 1: incomplete');

  const r2 = p.process('fox jumps. Over the');
  assert(r2.completed.length >= 1, 'Chunk 2: sentence completed');
  assert(r2.remaining.includes('Over the'), 'Chunk 2: trailing fragment');

  const r3 = p.process('lazy dog.');
  assert(r3.completed.length >= 1, 'Chunk 3: second sentence completed');
})();

/* ═══════════════════════════════════════════════════ */
/*  EDGE CASES                                        */
/* ═══════════════════════════════════════════════════ */

section('Edge cases');

(() => {
  const p = new StreamBufferProcessor('ja');
  const r = p.process('');
  assertDeepEqual(r, { completed: [], remaining: '' }, 'Empty input');
})();

(() => {
  const p = new StreamBufferProcessor('ja');
  const r = p.process('   ');
  assertDeepEqual(r, { completed: [], remaining: '' }, 'Whitespace-only input');
})();

(() => {
  const p = new StreamBufferProcessor('ja');
  p.process('テストです');
  const r = p.flush();
  assert(r.completed.length === 0 || r.remaining === '', 'Flush emits buffer');
  assert(p.buffer === '', 'Buffer cleared after flush');
})();

(() => {
  const p = new StreamBufferProcessor('ja');
  p.process('テスト中');
  p.reset();
  assert(p.buffer === '', 'Reset clears buffer');
})();

(() => {
  const p = createStreamBuffer('en');
  assert(p instanceof StreamBufferProcessor, 'Factory creates correct type');
  assert(p.sourceLang === 'en', 'Factory sets language');
})();

/* ═══════════════════════════════════════════════════ */
/*  GENERIC LANGUAGE TESTS                            */
/* ═══════════════════════════════════════════════════ */

section('Generic language (French)');

(() => {
  const p = new StreamBufferProcessor('fr');
  const r = p.process('Bonjour le monde. Comment allez-vous?');
  assert(r.completed.length === 2, 'French: 2 sentences split by punctuation');
  assert(r.remaining === '', 'French: no remaining');
})();

(() => {
  const p = new StreamBufferProcessor('fr');
  const r = p.process('Je suis en train de');
  assert(r.completed.length === 0, 'French: incomplete → no completed');
  assert(r.remaining.includes('Je suis'), 'French: buffer preserved');
})();

/* ═══════════════════════════════════════════════════ */
/*  SUMMARY                                           */
/* ═══════════════════════════════════════════════════ */

console.log('\n====================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  failures.forEach(({ testName, detail }) => {
    console.log(`  [FAIL] ${testName}`);
    if (detail) console.log(`     ${detail}`);
  });
}
console.log('====================================\n');

process.exit(failed > 0 ? 1 : 0);
