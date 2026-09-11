/**
 * BabelLive — Fullscreen Bridge
 * Injected into MAIN world to patch requestFullscreen/exitFullscreen.
 * Ensures subtitle overlay remains visible during fullscreen transitions
 * by signaling the content script before the browser enters/exits fullscreen.
 */
(() => {
  if (window.__babellive_fullscreen_bridge) return;
  window.__babellive_fullscreen_bridge = true;

  const REQUEST_TYPE = 'babellive:fullscreen-request';
  const READY_TYPE = 'babellive:fullscreen-ready';
  const WAIT_MS = 700;
  let seq = 0;

  function waitForReady(id, action) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onReady, true);
        resolve();
      };
      const onReady = (event) => {
        const data = event.data;
        if (!data || data.type !== READY_TYPE || data.id !== id) return;
        finish();
      };

      window.addEventListener('message', onReady, true);
      window.postMessage({ type: REQUEST_TYPE, id, action }, '*');
      setTimeout(finish, WAIT_MS);
    });
  }

  function patch(proto, name, returnsPromise, action) {
    const original = proto && proto[name];
    if (typeof original !== 'function' || original.__babellivePatched) return;

    const patched = function (...args) {
      const target = this;
      const id = String(++seq);
      const run = () => original.apply(target, args);
      if (returnsPromise) return waitForReady(id, action).then(run);
      waitForReady(id, action).then(run);
      return undefined;
    };

    patched.__babellivePatched = true;
    patched.__babelliveOriginal = original;

    try {
      Object.defineProperty(proto, name, { value: patched, configurable: true, writable: true });
    } catch {
      proto[name] = patched;
    }
  }

  // Patch all fullscreen API variants
  patch(Element.prototype, 'requestFullscreen', true, 'enter');
  patch(Element.prototype, 'webkitRequestFullscreen', false, 'enter');
  patch(Element.prototype, 'mozRequestFullScreen', false, 'enter');
  patch(Element.prototype, 'msRequestFullscreen', false, 'enter');
  patch(Document.prototype, 'exitFullscreen', true, 'exit');
  patch(Document.prototype, 'webkitExitFullscreen', false, 'exit');
  patch(Document.prototype, 'mozCancelFullScreen', false, 'exit');
  patch(Document.prototype, 'msExitFullscreen', false, 'exit');
})();
