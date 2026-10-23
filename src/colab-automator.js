/**
 * BabelLive — Colab Automator
 * Automatically executes Google Colab notebook cells, dismisses author run warnings,
 * extracts the generated ngrok WebSocket URL, and activates subtitles on the source tab.
 */

(function () {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('babellive_autorun') !== 'true') return;

  const originalTabId = urlParams.get('source_tab');
  console.log('[BabelLive] Colab automator started for source tab:', originalTabId);

  // 1. Create floating status banner on Colab page
  const banner = document.createElement('div');
  banner.id = 'babellive-colab-banner';
  banner.style.cssText = `
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2147483647;
    background: linear-gradient(135deg, rgba(15, 23, 42, 0.95), rgba(30, 41, 59, 0.95));
    border: 1px solid rgba(139, 92, 246, 0.6);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6), 0 0 16px rgba(139, 92, 246, 0.4);
    border-radius: 10px;
    padding: 12px 18px;
    color: #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    backdrop-filter: blur(12px);
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 400px;
    transition: opacity 0.5s ease;
  `;
  banner.innerHTML = `
    <div style="display: flex; align-items: center; gap: 8px; font-weight: 600; color: #38bdf8;">
      <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:#38bdf8; box-shadow:0 0 8px #38bdf8;"></span>
      BabelLive Automator
    </div>
    <div id="babellive-banner-status" style="color: #94a3b8; font-size: 12px; line-height: 1.4;">
      Preparing to initialize AI runtime...
    </div>
  `;
  document.body.appendChild(banner);

  function updateStatus(text, color = '#94a3b8') {
    const el = document.getElementById('babellive-banner-status');
    if (el) {
      el.textContent = text;
      el.style.color = color;
    }
  }

  // 2. Automatically confirm author warning modal if displayed by Google Colab
  const dismissInterval = setInterval(() => {
    const buttons = document.querySelectorAll('mwc-button, colab-dialog button, paper-button, button');
    for (const btn of buttons) {
      const txt = (btn.textContent || '').trim().toLowerCase();
      if (btn.id === 'ok' || txt.includes('run anyway') || txt.includes('vẫn chạy') || txt.includes('chạy dù sao')) {
        console.log('[BabelLive] Detected warning dialog, auto-clicking Run Anyway...');
        updateStatus('Warning acknowledged. Executing notebook cells...', '#38bdf8');
        btn.click();
        break;
      }
    }
  }, 400);
  setTimeout(() => clearInterval(dismissInterval), 30000);

  // 3. Trigger "Run All" execution
  let runTriggered = false;
  function triggerRunAll() {
    if (runTriggered) return;

    // Method 1: Keyboard shortcut Ctrl+F9 (Command+F9 on macOS)
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'F9',
      code: 'F9',
      keyCode: 120,
      which: 120,
      ctrlKey: !isMac,
      metaKey: isMac,
      bubbles: true,
      cancelable: true
    }));

    // Method 2: Click Runtime menu item directly
    const runtimeBtn = document.querySelector('#runtime-menu-button');
    if (runtimeBtn) {
      runtimeBtn.click();
      setTimeout(() => {
        const menuItems = document.querySelectorAll('colab-menu-item, div[role="menuitem"], .goog-menuitem');
        for (const item of menuItems) {
          const txt = (item.textContent || '').toLowerCase();
          if (txt.includes('run all') || txt.includes('chạy tất cả') || txt.includes('ctrl+f9')) {
            console.log('[BabelLive] Found Run All menu item, triggering execution...');
            item.click();
            runTriggered = true;
            updateStatus('Executing cells (Loading models & starting server)...', '#f59e0b');
            break;
          }
        }
        document.body.click();
      }, 400);
    }
  }

  // Check DOM readiness before triggering Run All
  const checkReadyInterval = setInterval(() => {
    if (document.querySelector('#runtime-menu-button')) {
      clearInterval(checkReadyInterval);
      setTimeout(triggerRunAll, 1200);
    }
  }, 500);
  setTimeout(() => clearInterval(checkReadyInterval), 20000);

  // 4. Continuously scan terminal output for WebSocket URL
  let detectedWs = false;
  const urlRegex = /(wss:\/\/[a-zA-Z0-9\-\._~%]+(?::\d+)?(?:\/[a-zA-Z0-9\-\._~%]*)*\/ws\/live)/i;
  const ngrokHttpRegex = /(https:\/\/[a-zA-Z0-9\-\._~%]+\.ngrok[a-zA-Z0-9\-\.]*)/i;

  const outputScanner = setInterval(() => {
    if (detectedWs) return;

    const pageText = document.body.innerText || '';
    let match = pageText.match(urlRegex);
    let finalWsUrl = match ? match[1] : null;

    if (!finalWsUrl) {
      const httpMatch = pageText.match(ngrokHttpRegex);
      if (httpMatch && (pageText.includes('BABELLIVE') || pageText.includes('AI BACKEND'))) {
        const httpUrl = httpMatch[1].replace(/\/+$/, '');
        finalWsUrl = httpUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws/live';
      }
    }

    if (finalWsUrl) {
      detectedWs = true;
      clearInterval(outputScanner);
      console.log('[BabelLive] Detected WebSocket endpoint:', finalWsUrl);

      updateStatus('Backend active. Switching to YouTube tab...', '#22c55e');

      // Forward detected endpoint to background service worker
      chrome.runtime.sendMessage({
        action: 'BABELLIVE_COLAB_READY',
        wsUrl: finalWsUrl,
        tabId: originalTabId ? parseInt(originalTabId, 10) : null
      });

      // Auto-hide banner after 4 seconds
      setTimeout(() => {
        if (banner) banner.style.opacity = '0';
      }, 4000);
    }
  }, 1500);

  // Scan timeout of 5 minutes
  setTimeout(() => clearInterval(outputScanner), 300000);

})();
