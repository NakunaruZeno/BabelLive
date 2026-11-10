/**
 * BabelLive — Content Script
 * Mounts a non-intrusive, draggable dual-language subtitle overlay inside the YouTube video player.
 * Handles streaming interim/final captions, fullscreen transitions, and quick minibar controls.
 */

(() => {
  if (window.self !== window.top) return;
  if (window.__babellive_content_injected) return;
  window.__babellive_content_injected = true;

  const OVERLAY_CSS_URL = chrome.runtime.getURL('content/overlay.css');
  const STORAGE_KEY = 'babellive_settings';

  const DEFAULTS = {
    enabled: false,
    sourceLang: 'ja',
    targetLang: 'vi',
    subtitlePreset: 'anime',
    fontSize: 22,
    bilingual: true,
    demoMode: false,
    pinned: false,
    posX: null, // percentage (10-90) or null for default center
    posBottom: null, // percentage (4-85) or null for default 10%
  };

  let isRunning = false;
  let settings = { ...DEFAULTS };
  const overlays = new Map(); // videoElement | 'body' -> overlayState
  let demoInterval = null;

  /* ── Inject Stylesheet ─────────────────────── */
  function injectCSS() {
    if (document.querySelector('link[data-babellive-css]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = OVERLAY_CSS_URL;
    link.dataset.babelliveCss = 'true';
    (document.head || document.documentElement).appendChild(link);
  }

  /* ── Locate Video Container ────────────────── */
  function getPlayerContainer(video) {
    if (document.fullscreenElement) {
      return document.fullscreenElement;
    }
    if (video) {
      const ytPlayer =
        video.closest('.html5-video-player') || document.getElementById('movie_player');
      if (ytPlayer) return ytPlayer;
    }
    return (
      document.getElementById('movie_player') ||
      document.querySelector('.html5-video-player') ||
      document.body
    );
  }

  /* ── Apply Custom Position ─────────────────── */
  function applyOverlayPosition(overlay) {
    if (settings.posX != null && settings.posBottom != null) {
      overlay.style.left = `${settings.posX}%`;
      overlay.style.bottom = `${settings.posBottom}%`;
      overlay.style.transform = 'translateX(-50%)';
      overlay.style.width = 'auto';
    } else {
      overlay.style.left = '50%';
      overlay.style.bottom = '10%';
      overlay.style.transform = 'translateX(-50%)';
      overlay.style.width = 'auto';
    }
  }

  /* ── Build Overlay DOM ─────────────────────── */
  function createOverlay(video) {
    const key = video || 'body';
    const existing = overlays.get(key);
    const container = getPlayerContainer(video);

    if (existing) {
      if (existing.overlay.parentElement !== container) {
        container.appendChild(existing.overlay);
      }
      return existing;
    }

    const overlay = document.createElement('div');
    overlay.className = `babellive-overlay babellive-preset-${settings.subtitlePreset}`;
    if (!isRunning && !settings.demoMode) overlay.classList.add('hidden');
    applyOverlayPosition(overlay);

    const stack = document.createElement('div');
    stack.className = 'babellive-subtitle-stack empty';
    if (settings.pinned) stack.classList.add('is-pinned');

    const minibar = document.createElement('div');
    minibar.className = 'babellive-minibar';
    minibar.innerHTML = `
      <button class="babellive-minibar-btn ${settings.pinned ? 'active' : ''}" data-action="pin" title="Lock subtitle position" aria-label="Lock subtitle position">
        <svg viewBox="0 0 16 16" fill="none"><rect x="4" y="7" width="8" height="6" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      </button>
      <button class="babellive-minibar-btn" data-action="reset" title="Reset to center" aria-label="Reset to center">
        <svg viewBox="0 0 16 16" fill="none"><path d="M3 8a5 5 0 101.5-3.5M3 2.5v2.5h2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <span class="babellive-minibar-sep"></span>
      <button class="babellive-minibar-btn" data-action="decrease" title="Decrease font size" aria-label="Decrease font size">
        <svg viewBox="0 0 16 16" fill="none"><path d="M4 8h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      </button>
      <button class="babellive-minibar-btn" data-action="increase" title="Increase font size" aria-label="Increase font size">
        <svg viewBox="0 0 16 16" fill="none"><path d="M8 4v8M4 8h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      </button>
      <span class="babellive-minibar-sep"></span>
      <button class="babellive-minibar-btn" data-action="copy" title="Copy subtitle" aria-label="Copy subtitle">
        <svg viewBox="0 0 16 16" fill="none"><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 5.5V4a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5" stroke="currentColor" stroke-width="1.3"/></svg>
      </button>
    `;

    const blocksContainer = document.createElement('div');
    blocksContainer.className = 'babellive-blocks';

    const statusToast = document.createElement('div');
    statusToast.className = 'babellive-status-toast hidden';

    stack.appendChild(minibar);
    stack.appendChild(blocksContainer);
    overlay.appendChild(statusToast);
    overlay.appendChild(stack);
    container.appendChild(overlay);

    setupDrag(stack, overlay);
    setupMinibar(minibar, stack, overlay, blocksContainer);

    const data = {
      overlay,
      stack,
      minibar,
      blocksContainer,
      statusToast,
      toastTimer: null,
      activeBlock: null,
      lastFinalText: null,
      lastFinalOriginal: null,
      hideTimer: null,
    };
    overlays.set(key, data);
    return data;
  }

  function showOverlayToast(text, mode = 'info', durationMs = 2600) {
    getActiveVideos().forEach((v) => {
      const data = createOverlay(v);
      const { overlay, statusToast } = data;
      if (!statusToast) return;
      overlay.classList.remove('hidden');
      statusToast.textContent = text;
      statusToast.dataset.mode = mode;
      statusToast.classList.remove('hidden');

      if (data.toastTimer) clearTimeout(data.toastTimer);
      data.toastTimer = setTimeout(() => {
        statusToast.classList.add('hidden');
      }, durationMs);
    });
  }

  /* ── Clamped Drag & Drop ───────────────────── */
  function setupDrag(stack, overlay) {
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startCenterX = 0;
    let startBottomPx = 0;
    let parentRect = null;

    stack.addEventListener('mousedown', (e) => {
      if (settings.pinned) return;
      if (e.target.closest('.babellive-minibar')) return;
      const parent = overlay.parentElement;
      if (!parent) return;

      isDragging = true;
      stack.classList.add('dragging');
      startX = e.clientX;
      startY = e.clientY;
      parentRect = parent.getBoundingClientRect();
      const rect = overlay.getBoundingClientRect();
      startCenterX = rect.left + rect.width / 2 - parentRect.left;
      startBottomPx = parentRect.bottom - rect.bottom;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging || !parentRect || parentRect.width === 0 || parentRect.height === 0) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const newCenterX = startCenterX + dx;
      const newBottomPx = startBottomPx - dy;

      const xPct = Math.max(12, Math.min(88, (newCenterX / parentRect.width) * 100));
      const bottomPct = Math.max(4, Math.min(82, (newBottomPx / parentRect.height) * 100));

      settings.posX = Math.round(xPct * 10) / 10;
      settings.posBottom = Math.round(bottomPct * 10) / 10;
      applyOverlayPosition(overlay);
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        stack.classList.remove('dragging');
        saveSettingsToStorage();
      }
    });
  }

  /* ── Minibar Controls ──────────────────────── */
  function setupMinibar(minibar, stack, overlay, blocksContainer) {
    minibar.addEventListener('click', (e) => {
      const btn = e.target.closest('.babellive-minibar-btn');
      if (!btn) return;
      const action = btn.dataset.action;

      switch (action) {
        case 'pin': {
          settings.pinned = !settings.pinned;
          btn.classList.toggle('active', settings.pinned);
          stack.classList.toggle('is-pinned', settings.pinned);
          saveSettingsToStorage();
          break;
        }
        case 'reset': {
          settings.posX = null;
          settings.posBottom = null;
          applyOverlayPosition(overlay);
          saveSettingsToStorage();
          break;
        }
        case 'copy': {
          const blocks = Array.from(blocksContainer.querySelectorAll('.babellive-subtitle-block'));
          if (blocks.length === 0) return;
          const lastBlock = blocks[blocks.length - 1];
          const original = lastBlock.querySelector('.babellive-original');
          const translated = lastBlock.querySelector('.babellive-translated');
          const text = [
            settings.bilingual ? original?.textContent : null,
            translated?.textContent,
          ]
            .filter(Boolean)
            .join('\n');

          navigator.clipboard.writeText(text).catch(() => {});
          btn.classList.add('copied');
          setTimeout(() => btn.classList.remove('copied'), 900);
          break;
        }
        case 'increase': {
          settings.fontSize = Math.min(36, settings.fontSize + 2);
          applyFontSizeAndBilingual();
          saveSettingsToStorage();
          break;
        }
        case 'decrease': {
          settings.fontSize = Math.max(14, settings.fontSize - 2);
          applyFontSizeAndBilingual();
          saveSettingsToStorage();
          break;
        }
      }
    });
  }

  function applyFontSizeAndBilingual() {
    overlays.forEach(({ overlay }) => {
      overlay
        .querySelectorAll('.babellive-original')
        .forEach((el) => el.classList.toggle('hidden', !settings.bilingual));
      overlay
        .querySelectorAll('.babellive-translated')
        .forEach((el) => (el.style.fontSize = `${settings.fontSize}px`));
    });
  }

  /* ── Apply Settings Across Overlays ────────── */
  function applySettings() {
    scanForVideos();
    const isVisible = Boolean(isRunning || settings.demoMode);

    overlays.forEach(({ overlay, stack, minibar }) => {
      overlay.classList.toggle('hidden', !isVisible);
      overlay.className = overlay.className.replace(/babellive-preset-\w+/g, '').trim();
      overlay.classList.add(`babellive-preset-${settings.subtitlePreset}`);
      if (!isVisible) overlay.classList.add('hidden');

      stack.classList.toggle('is-pinned', Boolean(settings.pinned));
      const pinBtn = minibar?.querySelector('[data-action="pin"]');
      if (pinBtn) pinBtn.classList.toggle('active', Boolean(settings.pinned));

      applyOverlayPosition(overlay);
    });

    applyFontSizeAndBilingual();
    setupYouTubeCaptionHook();

    if (settings.demoMode) {
      startDemo();
    } else {
      stopDemo();
    }
  }

  function setupYouTubeCaptionHook() {
    const ytPlayer =
      document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    if (!ytPlayer) return;

    if (isRunning && !settings.demoMode) {
      ytPlayer.classList.add('babellive-hide-native-cc');
    } else {
      ytPlayer.classList.remove('babellive-hide-native-cc');
    }
  }

  /* ── Subtitle Rendering ────────────────────── */
  function createSubtitleBlock() {
    const block = document.createElement('div');
    block.className = 'babellive-subtitle-block babellive-fade-in';

    const original = document.createElement('div');
    original.className = 'babellive-original';
    if (!settings.bilingual) original.classList.add('hidden');

    const translated = document.createElement('div');
    translated.className = 'babellive-translated';
    translated.style.fontSize = `${settings.fontSize}px`;

    block.appendChild(original);
    block.appendChild(translated);

    return { block, original, translated };
  }

  function renderSubtitle(video, originalText, translatedText, isInterim = false) {
    if (!originalText && !translatedText) return;

    const data = createOverlay(video);
    const { overlay, stack, blocksContainer } = data;

    const cleanOrig = (originalText || '').trim().replace(/\.+$/, '');
    const cleanTrans = (translatedText || '').trim().replace(/\.+$/, '');

    // Deduplicate consecutive identical final utterances
    if (
      !isInterim &&
      data.lastFinalText &&
      (cleanTrans === data.lastFinalText || cleanOrig === data.lastFinalOriginal)
    ) {
      return;
    }

    overlay.classList.remove('hidden');
    stack.classList.remove('empty');

    const maxBlocks = 2;
    const existingBlocks = blocksContainer.querySelectorAll('.babellive-subtitle-block');
    if (existingBlocks.length >= maxBlocks && !data.activeBlock) {
      existingBlocks[0].remove();
    }

    if (!data.activeBlock) {
      const newBlockData = createSubtitleBlock();
      blocksContainer.appendChild(newBlockData.block);
      data.activeBlock = newBlockData;
    }

    const { block, original, translated } = data.activeBlock;

    original.textContent = originalText || '';
    if (!isInterim || translatedText) {
      translated.textContent = translatedText || '';
    }

    if (isInterim) {
      block.classList.add('interim-predicting');
      if (originalText && !originalText.endsWith('...')) {
        original.textContent = `${originalText}...`;
      }
      if (translatedText && !translatedText.endsWith('...')) {
        translated.textContent = `${translatedText}...`;
      }
    } else {
      block.classList.remove('interim-predicting');
      data.lastFinalText = cleanTrans;
      data.lastFinalOriginal = cleanOrig;
      data.activeBlock = null;
    }

    if (data.hideTimer) clearTimeout(data.hideTimer);
    data.hideTimer = setTimeout(() => {
      const blocks = blocksContainer.querySelectorAll('.babellive-subtitle-block');
      blocks.forEach((b) => {
        b.classList.remove('babellive-fade-in');
        b.classList.add('babellive-fade-out');
      });
      setTimeout(() => {
        blocksContainer.innerHTML = '';
        data.lastFinalText = null;
        data.lastFinalOriginal = null;
        data.activeBlock = null;
        stack.classList.add('empty');
      }, 280);
    }, 6500);
  }

  function clearSubtitles(video) {
    const key = video || 'body';
    const data = overlays.get(key);
    if (!data) return;
    if (data.hideTimer) clearTimeout(data.hideTimer);
    data.blocksContainer.innerHTML = '';
    data.stack.classList.add('empty');
    data.activeBlock = null;
    data.lastFinalText = null;
    data.lastFinalOriginal = null;
  }

  /* ── Demo Mode ─────────────────────────────── */
  const DEMO_SUBTITLES = [
    {
      original: '皆さんこんばんは！配信始まりますよ',
      translated: 'Chào buổi tối mọi người! Buổi stream bắt đầu rồi đây',
    },
    {
      original: 'リアルタイム音声認識とAI翻訳が稼働中です',
      translated: 'Nhận diện giọng nói và dịch thuật AI thời gian thực đang hoạt động',
    },
    {
      original: '字幕をドラッグして好きな位置に固定できます',
      translated: 'Bạn có thể kéo thả phụ đề và khóa ở bất kỳ vị trí nào',
    },
    {
      original: '映画館のように読みやすい字幕デザイン',
      translated: 'Thiết kế phụ đề sắc nét, dễ đọc như trong rạp chiếu phim',
    },
  ];

  function getActiveVideos() {
    const main = Array.from(document.querySelectorAll('.html5-main-video, #movie_player video'));
    return main.length > 0 ? main : [null];
  }

  function startDemo() {
    if (demoInterval) return;
    let index = 0;

    const runCycle = () => {
      const videos = getActiveVideos();
      const sub = DEMO_SUBTITLES[index % DEMO_SUBTITLES.length];
      videos.forEach((v) => renderSubtitle(v, sub.original, sub.translated, false));
      index++;
    };

    runCycle();
    demoInterval = setInterval(runCycle, 3000);
  }

  function stopDemo() {
    if (demoInterval) {
      clearInterval(demoInterval);
      demoInterval = null;
      if (!isRunning) {
        getActiveVideos().forEach((v) => clearSubtitles(v));
      }
    }
  }

  /* ── Video & Fullscreen Watchers ───────────── */
  function scanForVideos() {
    getActiveVideos().forEach((video) => {
      createOverlay(video);
    });
  }

  let flexyObserver = null;
  function observeFlexy() {
    const flexy = document.querySelector('ytd-watch-flexy');
    if (flexy && !flexyObserver) {
      flexyObserver = new MutationObserver(() => scanForVideos());
      flexyObserver.observe(flexy, { childList: true, subtree: true });
    }
  }

  document.addEventListener('fullscreenchange', () => {
    scanForVideos();
  });

  // Keyboard shortcut: Alt+B toggles bilingual mode when overlay is active
  document.addEventListener('keydown', (e) => {
    if (!isRunning && !settings.demoMode) return;
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyB') {
      const activeTag = document.activeElement?.tagName;
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || document.activeElement?.isContentEditable) {
        return;
      }
      e.preventDefault();
      settings.bilingual = !settings.bilingual;
      applyFontSizeAndBilingual();
      saveSettingsToStorage();
      showOverlayToast(
        settings.bilingual ? 'BabelLive · Bilingual ON' : 'BabelLive · Translation Only',
        'info',
        1600
      );
    }
  });

  window.addEventListener('yt-navigate-finish', () => {
    setTimeout(() => {
      observeFlexy();
      scanForVideos();
      applySettings();
    }, 400);
  });

  window.addEventListener('yt-player-updated', () => {
    setTimeout(scanForVideos, 250);
  });

  /* ── Storage Sync ──────────────────────────── */
  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      if (result[STORAGE_KEY]) {
        const { enabled, ...prefs } = result[STORAGE_KEY];
        settings = { ...DEFAULTS, ...prefs, enabled: isRunning };
      }
    } catch {}
  }

  async function saveSettingsToStorage() {
    try {
      const { enabled, ...prefs } = settings;
      await chrome.storage.local.set({ [STORAGE_KEY]: { ...prefs, enabled: false } });
    } catch {}
  }

  /* ── Runtime Messaging ─────────────────────── */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msgType = message.type || message.action;
    switch (msgType) {
      case 'BABELLIVE_PING':
        sendResponse({ ok: true, version: '1.1.0', isRunning });
        return false;

      case 'START_LIVE_SESSION':
      case 'BABELLIVE_START':
        isRunning = true;
        settings.enabled = true;
        if (message.settings) {
          const { enabled, ...prefs } = message.settings;
          settings = { ...settings, ...prefs, enabled: true };
        }
        scanForVideos();
        applySettings();
        showOverlayToast('BabelLive · Connecting to AI stream...', 'starting', 3500);
        sendResponse({ ok: true, isRunning: true });
        return false;

      case 'BABELLIVE_CAPTURE_READY':
        isRunning = true;
        settings.enabled = true;
        applySettings();
        showOverlayToast('BabelLive · Live subtitles active', 'live', 2400);
        sendResponse({ ok: true });
        return false;

      case 'BABELLIVE_CAPTURE_ERROR':
        isRunning = false;
        settings.enabled = false;
        showOverlayToast(`BabelLive · ${message.error || 'Connection error'}`, 'error', 4000);
        sendResponse({ ok: true });
        return false;

      case 'BABELLIVE_CAPTURE_ENDED':
      case 'STOP_LIVE_SESSION':
      case 'BABELLIVE_STOP':
        isRunning = false;
        settings.enabled = false;
        applySettings();
        getActiveVideos().forEach((v) => clearSubtitles(v));
        sendResponse({ ok: true, isRunning: false });
        return false;

      case 'BABELLIVE_SETTINGS_UPDATE': {
        const { enabled, ...prefs } = message.settings || {};
        settings = { ...DEFAULTS, ...prefs, enabled: isRunning };
        applySettings();
        sendResponse({ ok: true });
        return false;
      }

      case 'BABELLIVE_SUBTITLE':
      case 'BABELLIVE_SUBTITLE_BROADCAST': {
        isRunning = true;
        settings.enabled = true;
        getActiveVideos().forEach((v) => {
          renderSubtitle(v, message.original, message.translated, message.isInterim);
        });
        sendResponse({ ok: true });
        return false;
      }

      case 'BABELLIVE_CLEAR': {
        getActiveVideos().forEach((v) => clearSubtitles(v));
        sendResponse({ ok: true });
        return false;
      }
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      const { enabled, ...prefs } = changes[STORAGE_KEY].newValue || {};
      settings = { ...DEFAULTS, ...prefs, enabled: isRunning };
      applySettings();
    }
  });

  async function init() {
    injectCSS();
    await loadSettings();
    scanForVideos();
    applySettings();
    observeFlexy();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
