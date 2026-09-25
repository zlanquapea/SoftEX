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

// ---------- Push notifications ----------

export type PushState = 'unsupported' | 'unavailable' | 'denied' | 'off' | 'on';

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';

async function registration() {
  if (!pushSupported()) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

/** Whether this device gets push notifications from Küü. */
export async function pushState(serverEnabled: boolean): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (!serverEnabled) return 'unavailable';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registration();
  if (!reg) return 'unavailable';
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}

function keyBytes(base64url: string) {
  const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** Ask for permission, subscribe with the push service and register the device with Küü. */
export async function enablePush(publicKey: string, save: (sub: PushSubscriptionJSON) => Promise<unknown>) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  await save(sub.toJSON());
  return true;
}

/** Stop push notifications on this device; returns the endpoint so the server can forget it. */
export async function disablePush() {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  return endpoint;
}
