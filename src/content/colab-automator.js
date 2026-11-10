/**
 * BabelLive — Colab Automator
 * Automatically executes Google Colab notebook cells, dismisses confirmation dialogs,
 * extracts the generated ngrok WebSocket URL from shadow DOM / iframes, and returns to YouTube.
 */

(function () {
  const isIframe = window !== window.top;

  const urlRegex = /(wss:\/\/[a-zA-Z0-9\-\._~%]+(?::\d+)?(?:\/[a-zA-Z0-9\-\._~%]*)*\/ws\/live)/i;
  const ngrokHttpRegex = /(https:\/\/[a-zA-Z0-9\-\._~%]+\.ngrok[a-zA-Z0-9\-\.]*)/i;

  /* ── 1. Iframe Output Scanner ───────────────── */
  if (isIframe) {
    let detectedInFrame = false;
    const frameScanner = setInterval(() => {
      if (detectedInFrame) return;

      const text = document.body ? document.body.innerText || document.body.textContent || '' : '';
      const match = text.match(urlRegex);
      let finalWs = match ? match[1] : null;

      if (!finalWs) {
        const httpMatch = text.match(ngrokHttpRegex);
        if (
          httpMatch &&
          (text.includes('BABELLIVE') ||
            text.includes('AI BACKEND') ||
            text.includes('WebSocket URL'))
        ) {
          finalWs =
            httpMatch[1]
              .replace(/\/+$/, '')
              .replace('https://', 'wss://')
              .replace('http://', 'ws://') + '/ws/live';
        }
      }

      if (finalWs) {
        detectedInFrame = true;
        clearInterval(frameScanner);
        chrome.runtime
          .sendMessage({
            action: 'BABELLIVE_COLAB_READY',
            wsUrl: finalWs,
          })
          .catch(() => {});
      }
    }, 1500);

    setTimeout(() => clearInterval(frameScanner), 360000);
    return;
  }

  /* ── 2. Top Window Context ──────────────────── */
  const urlParams = new URLSearchParams(window.location.search);
  let isAutoRun = urlParams.get('babellive_autorun') === 'true';
  let originalTabId = urlParams.get('source_tab');

  if (isAutoRun) {
    sessionStorage.setItem('babellive_autorun', 'true');
    if (originalTabId) sessionStorage.setItem('babellive_source_tab', originalTabId);
  } else if (sessionStorage.getItem('babellive_autorun') === 'true') {
    isAutoRun = true;
    originalTabId = originalTabId || sessionStorage.getItem('babellive_source_tab');
  }

  if (!isAutoRun) return;

  function queryShadowAll(root, selector) {
    const results = [];
    try {
      results.push(...root.querySelectorAll(selector));
    } catch {}
    const all = root.querySelectorAll('*');
    for (const el of all) {
      if (el.shadowRoot) {
        results.push(...queryShadowAll(el.shadowRoot, selector));
      }
    }
    return results;
  }

  function getDeepText(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || '';
    }
    let text = '';
    if (node.childNodes) {
      for (const child of node.childNodes) {
        text += ' ' + getDeepText(child);
      }
    }
    if (node.shadowRoot) {
      text += ' ' + getDeepText(node.shadowRoot);
    }
    return text;
  }

  function simulateClick(el) {
    if (!el) return;
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((evtType) => {
      el.dispatchEvent(new MouseEvent(evtType, { bubbles: true, cancelable: true, view: window }));
    });
  }

  // Minimalist Studio Floating Status Pill
  const banner = document.createElement('div');
  banner.id = 'babellive-colab-banner';
  banner.style.cssText = `
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2147483647;
    background: rgba(9, 9, 11, 0.94);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
    border-radius: 10px;
    padding: 12px 16px;
    color: #f4f4f5;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 12px;
    backdrop-filter: blur(12px);
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 360px;
    transition: opacity 0.4s ease;
  `;
  banner.innerHTML = `
    <div style="display: flex; align-items: center; gap: 8px; font-weight: 600; color: #fafafa; letter-spacing: -0.01em;">
      <span id="babellive-banner-dot" style="display:inline-block; width:7px; height:7px; border-radius:50%; background:#f59e0b;"></span>
      BabelLive Auto-Runner
    </div>
    <div id="babellive-banner-status" style="color: #a1a1aa; font-size: 11.5px; line-height: 1.45;">
      Preparing Colab runtime execution...
    </div>
  `;
  document.body.appendChild(banner);

  function updateStatus(text, dotColor = '#f59e0b') {
    const el = document.getElementById('babellive-banner-status');
    const dot = document.getElementById('babellive-banner-dot');
    if (el) el.textContent = text;
    if (dot) dot.style.background = dotColor;
  }

  // Auto-dismiss Colab Dialogs
  const dialogDismissInterval = setInterval(() => {
    const allButtons = [
      ...document.querySelectorAll(
        'mwc-button, colab-dialog button, paper-button, button, md-filled-button, md-outlined-button'
      ),
      ...queryShadowAll(
        document,
        'mwc-button, colab-dialog button, paper-button, button, md-filled-button, md-outlined-button'
      ),
    ];

    for (const btn of allButtons) {
      const txt = (btn.textContent || '').trim().toLowerCase();
      const id = (btn.id || '').toLowerCase();

      if (
        id === 'ok' ||
        txt.includes('run anyway') ||
        txt.includes('vẫn chạy') ||
        txt.includes('chạy dù sao')
      ) {
        updateStatus('Confirmed notebook execution...', '#f59e0b');
        simulateClick(btn);
        break;
      }

      if (
        txt.includes('connect to google drive') ||
        txt.includes('kết nối với google drive') ||
        txt.includes('permit this notebook')
      ) {
        updateStatus('Mounting persistent model cache...', '#f59e0b');
        simulateClick(btn);
        break;
      }
    }
  }, 400);
  setTimeout(() => clearInterval(dialogDismissInterval), 120000);

  let runTriggered = false;
  function triggerRunAll() {
    if (runTriggered) return;

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const evtInit = {
      key: 'F9',
      code: 'F9',
      keyCode: 120,
      which: 120,
      ctrlKey: !isMac,
      metaKey: isMac,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    window.dispatchEvent(new KeyboardEvent('keydown', evtInit));
    document.dispatchEvent(new KeyboardEvent('keydown', evtInit));
    if (document.activeElement) {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', evtInit));
    }

    const runtimeBtn = document.querySelector('#runtime-menu-button');
    if (runtimeBtn) {
      simulateClick(runtimeBtn);
      setTimeout(() => {
        const menuItems = [
          ...document.querySelectorAll(
            'colab-menu-item, div[role="menuitem"], .goog-menuitem, md-menu-item'
          ),
          ...queryShadowAll(
            document,
            'colab-menu-item, div[role="menuitem"], .goog-menuitem, md-menu-item'
          ),
        ];
        for (const item of menuItems) {
          const txt = (item.textContent || '').toLowerCase();
          if (txt.includes('run all') || txt.includes('chạy tất cả') || txt.includes('ctrl+f9')) {
            simulateClick(item);
            runTriggered = true;
            updateStatus('Loading Kotoba-Whisper & Qwen2.5-7B (~1–2 min)...', '#f59e0b');
            break;
          }
        }
        document.body.click();
      }, 350);
    }
  }

  let attempts = 0;
  const readyChecker = setInterval(() => {
    attempts++;
    if (document.querySelector('#runtime-menu-button') || attempts > 10) {
      clearInterval(readyChecker);
      setTimeout(triggerRunAll, 1000);
      setTimeout(() => {
        if (!runTriggered) triggerRunAll();
      }, 4000);
    }
  }, 500);

  let detectedWs = false;
  const outputScanner = setInterval(() => {
    if (detectedWs) return;

    const allPageText = getDeepText(document.body);
    const match = allPageText.match(urlRegex);
    let finalWsUrl = match ? match[1] : null;

    if (!finalWsUrl) {
      const httpMatch = allPageText.match(ngrokHttpRegex);
      if (
        httpMatch &&
        (allPageText.includes('BABELLIVE') ||
          allPageText.includes('AI BACKEND') ||
          allPageText.includes('WebSocket URL'))
      ) {
        finalWsUrl =
          httpMatch[1]
            .replace(/\/+$/, '')
            .replace('https://', 'wss://')
            .replace('http://', 'ws://') + '/ws/live';
      }
    }

    if (finalWsUrl) {
      detectedWs = true;
      clearInterval(outputScanner);
      sessionStorage.removeItem('babellive_autorun');

      updateStatus('Backend online — switching back to YouTube...', '#10b981');

      chrome.runtime.sendMessage({
        action: 'BABELLIVE_COLAB_READY',
        wsUrl: finalWsUrl,
        tabId: originalTabId ? parseInt(originalTabId, 10) : null,
      });

      setTimeout(() => {
        if (banner) banner.style.opacity = '0';
      }, 3500);
    }
  }, 1500);

  setTimeout(() => clearInterval(outputScanner), 360000);
})();
