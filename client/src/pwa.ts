/** Service worker registration and offline helpers. */

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support is optional */
    });
  });
}

/** Remove cached workspace data (on sign-out or when the session ends). */
export async function clearOfflineData() {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'clear-data' });
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('softex-api-')).map((k) => caches.delete(k)));
    }
  } catch {
    /* ignore */
  }
}
