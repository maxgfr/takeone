/**
 * Cross-origin isolation, for speech to text on several threads: the local
 * server sends the headers itself; on GitHub Pages a service worker (sw.js)
 * adds them, and the page reloads once when it first takes over. Without a
 * service worker (a private window, an old browser) everything still works,
 * on one thread.
 */
const RELOADED = "takeone-isolation-reload";

export function isolate(): void {
  if (globalThis.crossOriginIsolated || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker
    .register("./sw.js", { scope: "./" })
    .then(async (registration) => {
      await navigator.serviceWorker.ready;
      // Reload once, so the page itself comes through the worker with the headers.
      let reloaded = false;
      try {
        reloaded = sessionStorage.getItem(RELOADED) === "1";
        sessionStorage.setItem(RELOADED, "1");
      } catch {
        reloaded = true;
      }
      if (!reloaded && registration.active && !globalThis.crossOriginIsolated) location.reload();
    })
    .catch(() => {
      // No service worker here: one thread.
    });
}
