/**
 * BabelLive — Content Script
 * Detects <video> elements, injects draggable subtitle overlay,
 * renders streaming dual-language subtitles, and syncs settings.
 */

(() => {
  if (window.__babellive_content_injected) return;
  window.__babellive_content_injected = true;

  const OVERLAY_CSS_URL = chrome.runtime.getURL('overlay.css');
  const STORAGE_KEY = 'babellive_settings';

  /* ── Default settings ──────────────────────── */
  const DEFAULTS = {
    enabled: false,
    sourceLang: 'ja',
    targetLang: 'vi',
    subtitlePreset: 'anime',
    fontSize: 22,
    bilingual: true,
    engine: 'cloud',
    demoMode: false,
  };

  let isRunning = false;
  let settings = { ...DEFAULTS, enabled: false };
  let overlays = new Map(); // video element → overlay DOM
  let demoInterval = null;

  /* ── Inject overlay CSS ────────────────────── */
  function injectCSS() {
    if (document.querySelector('link[data-babellive-css]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = OVERLAY_CSS_URL;
    link.dataset.babelliveCss = 'true';
    (document.head || document.documentElement).appendChild(link);
  }

  /* ── Find proper video player container ─────── */
  function getPlayerContainer(video) {
    if (!video) {
      console.log(`[BabelLive-Content] Search for player: No video provided, mounting to body`);
      return document.body;
    }

    // 1. YouTube player
    const ytPlayer = video.closest('.html5-video-player') || document.getElementById('movie_player');
    if (ytPlayer) {
      console.log(`[BabelLive-Content] Search for player: Found YouTube player (#movie_player / .html5-video-player)`);
      return ytPlayer;
    }

    // Fallback if somehow missing
    console.log(`[BabelLive-Content] Search for player: Not found, falling back to document.body`);
    return document.body;
  }

  /* ── Create overlay DOM for a video ────────── */
  function createOverlay(video) {
    const existing = overlays.get(video);
    if (existing && existing.overlay.isConnected) {
      return existing;
    }

    const container = getPlayerContainer(video);

    // If overlay already created but detached from DOM (e.g. YouTube SPA update)
    if (existing && !existing.overlay.isConnected) {
      container.appendChild(existing.overlay);
      return existing;
    }

    // Overlay wrapper
    const overlay = document.createElement('div');
    overlay.className = `babellive-overlay babellive-preset-${settings.subtitlePreset}`;
    if (!isRunning && !settings.demoMode) overlay.classList.add('hidden');

    // Subtitle block (draggable)
    const block = document.createElement('div');
    block.className = 'babellive-subtitle-block empty';

    // Original text row
    const original = document.createElement('div');
    original.className = 'babellive-original';
    if (!settings.bilingual) original.classList.add('hidden');
    original.textContent = '';

    // Translated text row
    const translated = document.createElement('div');
    translated.className = 'babellive-translated';
    translated.style.fontSize = `${settings.fontSize}px`;
    translated.textContent = '';

    // Mini-bar
    const minibar = document.createElement('div');
    minibar.className = 'babellive-minibar';
    minibar.innerHTML = `
      <button class="babellive-minibar-btn" data-action="pin" title="Pin position">
        <svg viewBox="0 0 14 14" fill="none"><path d="M7 1v5M5 3h4M4 6h6v2l-1 4H5L4 8V6z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="babellive-minibar-btn" data-action="copy" title="Copy subtitle">
        <svg viewBox="0 0 14 14" fill="none"><rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M10 4V2.5A1.5 1.5 0 008.5 1h-6A1.5 1.5 0 001 2.5v6A1.5 1.5 0 002.5 10H4" stroke="currentColor" stroke-width="1.2"/></svg>
      </button>
      <button class="babellive-minibar-btn" data-action="increase" title="Increase font">
        <svg viewBox="0 0 14 14" fill="none"><path d="M7 3v8M3 7h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
      <button class="babellive-minibar-btn" data-action="decrease" title="Decrease font">
        <svg viewBox="0 0 14 14" fill="none"><path d="M3 7h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    `;

    block.appendChild(minibar);
    block.appendChild(original);
    block.appendChild(translated);
    overlay.appendChild(block);

    // Insert overlay into video player container
    container.appendChild(overlay);

    // Setup drag
    setupDrag(block, overlay);

    // Setup minibar actions
    setupMinibar(minibar, original, translated);

    const data = { overlay, block, original, translated };
    overlays.set(video, data);
    return data;
  }

  /* ── Drag and Drop ─────────────────────────── */
  function setupDrag(block, overlay) {
    let isDragging = false;
    let startX, startY, startLeft, startBottom;

    block.addEventListener('mousedown', (e) => {
      if (e.target.closest('.babellive-minibar-btn')) return;
      isDragging = true;
      block.classList.add('dragging');
      startX = e.clientX;
      startY = e.clientY;
      const rect = overlay.getBoundingClientRect();
      const parentRect = overlay.parentElement.getBoundingClientRect();
      startLeft = rect.left - parentRect.left;
      startBottom = parentRect.bottom - rect.bottom;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      overlay.style.left = `${startLeft + dx}px`;
      overlay.style.bottom = `${startBottom - dy}px`;
      overlay.style.width = 'auto';
      overlay.style.alignItems = 'flex-start';
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        block.classList.remove('dragging');
      }
    });
  }

  /* ── Mini-bar actions ──────────────────────── */
  function setupMinibar(minibar, original, translated) {
    minibar.addEventListener('click', (e) => {
      const btn = e.target.closest('.babellive-minibar-btn');
      if (!btn) return;
      const action = btn.dataset.action;

      switch (action) {
        case 'copy': {
          const text = [original.textContent, translated.textContent].filter(Boolean).join('\n');
          navigator.clipboard.writeText(text).catch(() => {});
          btn.style.color = '#22c55e';
          setTimeout(() => { btn.style.color = ''; }, 1000);
          break;
        }
        case 'increase': {
          settings.fontSize = Math.min(36, settings.fontSize + 2);
          translated.style.fontSize = `${settings.fontSize}px`;
          saveSettingsToStorage();
          break;
        }
        case 'decrease': {
          settings.fontSize = Math.max(14, settings.fontSize - 2);
          translated.style.fontSize = `${settings.fontSize}px`;
          saveSettingsToStorage();
          break;
        }
        case 'pin': {
          btn.classList.toggle('pinned');
          if (btn.classList.contains('pinned')) {
            btn.style.color = '#8b5cf6';
          } else {
            btn.style.color = '';
          }
          break;
        }
      }
    });
  }

  /* ── Apply settings to all overlays ────────── */
  function applySettings() {
    scanForVideos();
    const isVisible = Boolean(isRunning || settings.demoMode);

    overlays.forEach(({ overlay, block, original, translated }) => {
      // Show/hide
      overlay.classList.toggle('hidden', !isVisible);

      // Preset class
      overlay.className = overlay.className.replace(/babellive-preset-\w+/, '').trim();
      overlay.classList.add(`babellive-preset-${settings.subtitlePreset}`);

      // Bilingual
      original.classList.toggle('hidden', !settings.bilingual);

      // Font size
      translated.style.fontSize = `${settings.fontSize}px`;
    });

    // YouTube live captions hook
    setupYouTubeCaptionHook();

    // Demo mode
    if (settings.demoMode) {
      startDemo();
    } else {
      stopDemo();
    }
  }

  /* ── YouTube Live Captions Hook ────────────── */
  function setupYouTubeCaptionHook() {
    const ytPlayer = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    if (!ytPlayer) return;

    if (isRunning && !settings.demoMode) {
      ytPlayer.classList.add('babellive-hide-native-cc');
      // Auto-click CC button if disabled to start receiving YouTube live ASR (in case it helps underlying stream)
      const ccBtn = ytPlayer.querySelector('.ytp-subtitles-button[aria-pressed="false"]');
      if (ccBtn) {
        ccBtn.click();
      }
    } else {
      ytPlayer.classList.remove('babellive-hide-native-cc');
    }
    
    // (Removed: Duplicate DOM MutationObserver for .ytp-caption-segment that conflicted with Audio STT)
  }

  /* ── Render subtitle ───────────────────────── */
  function renderSubtitle(video, originalText, translatedText) {
    let data = overlays.get(video);
    if (!data || !data.overlay.isConnected) data = createOverlay(video);

    console.log(`[BabelLive-Content] DOM Render Event: Assigning text to subtitle elements. Original: "${originalText}", Translated: "${translatedText}"`);
    const { original, translated, block, overlay } = data;

    if (!originalText && !translatedText) {
      block.classList.add('empty');
      return;
    }

    overlay.classList.remove('hidden');
    block.classList.remove('empty');

    // Fade out old
    block.classList.remove('babellive-fade-in');
    block.classList.add('babellive-fade-out');

    setTimeout(() => {
      original.textContent = originalText || '';
      translated.textContent = translatedText || '';
      block.classList.remove('babellive-fade-out');
      block.classList.add('babellive-fade-in');
    }, 150);

    // Auto-hide after 7 seconds of inactivity
    if (data.hideTimer) clearTimeout(data.hideTimer);
    data.hideTimer = setTimeout(() => {
      block.classList.add('empty');
    }, 7000);
  }

  /* ── Clear subtitles ───────────────────────── */
  function clearSubtitles(video) {
    const data = overlays.get(video);
    if (!data) return;
    data.original.textContent = '';
    data.translated.textContent = '';
    data.block.classList.add('empty');
    if (data.hideTimer) clearTimeout(data.hideTimer);
  }

  /* ── Demo Mode ─────────────────────────────── */
  const DEMO_SUBTITLES = [
    { original: 'これは字幕のテストです', translated: 'Đây là bài kiểm tra phụ đề' },
    { original: 'リアルタイム翻訳が始まります', translated: 'Bắt đầu dịch thuật thời gian thực' },
    { original: 'バベルライブへようこそ！', translated: 'Chào mừng đến với BabelLive!' },
    { original: '映画のように美しい字幕', translated: 'Phụ đề đẹp như phim điện ảnh' },
    { original: 'アニメスタイルの翻訳', translated: 'Dịch thuật phong cách anime' },
    { original: '日本語から越南語への翻訳', translated: 'Dịch từ tiếng Nhật sang tiếng Việt' },
    { original: 'AIが自動的に翻訳します', translated: 'AI sẽ tự động dịch cho bạn' },
    { original: 'ドラッグして位置を変更できます', translated: 'Kéo thả để thay đổi vị trí' },
  ];

  function getActiveVideos() {
    const main = Array.from(document.querySelectorAll('.html5-main-video, #movie_player video'));
    return main.length > 0 ? main : [null]; // fallback to null for document.body mounting (Demo Mode)
  }

  function startDemo() {
    if (demoInterval) return;
    let index = 0;

    const runCycle = () => {
      const videos = getActiveVideos();
      if (videos.length === 0) return;

      videos.forEach((v) => {
        const data = createOverlay(v);
        data.overlay.classList.remove('hidden');
      });

      const sub = DEMO_SUBTITLES[index % DEMO_SUBTITLES.length];
      videos.forEach((v) => renderSubtitle(v, sub.original, sub.translated));
      index++;
    };

    // First render immediately
    runCycle();

    demoInterval = setInterval(runCycle, 2800);
  }

  function stopDemo() {
    if (demoInterval) {
      clearInterval(demoInterval);
      demoInterval = null;
    }
  }

  /* ── Video detection ───────────────────────── */
  function scanForVideos() {
    let videos = Array.from(document.querySelectorAll('.html5-main-video, #movie_player video'));
    if (videos.length === 0) videos = [null]; // mount to body if no video
    videos.forEach((video) => {
      const existing = overlays.get(video);
      if (!existing || !existing.overlay.isConnected) {
        createOverlay(video);
      }
    });
  }

  // Observe ytd-watch-flexy for dynamic video loading to avoid heavy body mutations
  let flexyObserver = null;
  function observeFlexy() {
    const flexy = document.querySelector('ytd-watch-flexy');
    if (flexy && !flexyObserver) {
      flexyObserver = new MutationObserver(() => {
        scanForVideos();
      });
      flexyObserver.observe(flexy, { childList: true, subtree: true });
    }
  }

  // YouTube SPA navigation events
  window.addEventListener('yt-navigate-finish', () => {
    setTimeout(() => {
      observeFlexy();
      scanForVideos();
      applySettings();
    }, 500);
  });
  window.addEventListener('yt-player-updated', () => {
    setTimeout(scanForVideos, 300);
  });

  /* ── Storage sync ──────────────────────────── */
  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      if (result[STORAGE_KEY]) {
        // Do NOT inherit running state from local storage
        const { enabled, ...prefs } = result[STORAGE_KEY];
        settings = { ...DEFAULTS, ...prefs, enabled: isRunning };
      }
    } catch (e) {
      console.warn('[BabelLive] loadSettings error', e);
    }
  }

  async function saveSettingsToStorage() {
    try {
      // Never persist enabled: true to local storage
      const { enabled, ...prefs } = settings;
      await chrome.storage.local.set({ [STORAGE_KEY]: { ...prefs, enabled: false } });
    } catch (e) {
      console.warn('[BabelLive] saveSettings error', e);
    }
  }

  /* ── Message handling ──────────────────────── */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const msgType = message.type || message.action;
    switch (msgType) {
      case 'BABELLIVE_PING':
        sendResponse({ ok: true, version: '1.0.0', isRunning });
        return false;

      case 'START_LIVE_SESSION':
      case 'BABELLIVE_START':
        isRunning = true;
        settings.enabled = true;
        if (message.settings) {
          const { enabled, ...prefs } = message.settings;
          settings = { ...settings, ...prefs, enabled: true };
        }
        applySettings();
        sendResponse({ ok: true, isRunning: true });
        break;

      case 'STOP_LIVE_SESSION':
      case 'BABELLIVE_STOP':
        isRunning = false;
        settings.enabled = false;
        applySettings();
        const vids = document.querySelectorAll('video');
        vids.forEach((v) => clearSubtitles(v));
        sendResponse({ ok: true, isRunning: false });
        break;

      case 'BABELLIVE_SETTINGS_UPDATE': {
        const { enabled, ...prefs } = message.settings || {};
        settings = { ...DEFAULTS, ...prefs, enabled: isRunning };
        applySettings();
        sendResponse({ ok: true });
        break;
      }

      case 'BABELLIVE_SUBTITLE':
      case 'BABELLIVE_SUBTITLE_BROADCAST': {
        console.log(`[BabelLive-Content] Received ${message.type}:`, { original: message.original, translated: message.translated });
        if (!isRunning && !settings.demoMode) {
          sendResponse({ ok: false, skipped: true });
          return false;
        }
        const videos = getActiveVideos();
        videos.forEach((v) => {
          renderSubtitle(v, message.original, message.translated);
        });
        sendResponse({ ok: true });
        break;
      }

      case 'BABELLIVE_CLEAR': {
        const videos = document.querySelectorAll('video');
        videos.forEach((v) => clearSubtitles(v));
        sendResponse({ ok: true });
        break;
      }
    }
    return false;
  });

  // Listen for storage changes (e.g. from popup in another tab)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      const { enabled, ...prefs } = changes[STORAGE_KEY].newValue || {};
      settings = { ...DEFAULTS, ...prefs, enabled: isRunning };
      applySettings();
    }
  });

  /* ── Init ──────────────────────────────────── */
  async function init() {
    injectCSS();
    await loadSettings();
    scanForVideos();
    applySettings();
    observeFlexy();

    console.log('[BabelLive] Content script initialized on', window.location.hostname);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
