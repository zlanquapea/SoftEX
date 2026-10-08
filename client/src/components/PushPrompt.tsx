import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApi, useRealtime } from '../hooks';
import { enablePush, pushState, type PushState } from '../pwa';
import { Icon } from './Icon';
import { useToast } from './ui';

const KEY = 'kuu:push-prompt';
/** After "Not now", ask again only once this long has passed… */
const QUIET_FOR = 3 * 86_400_000;
/** …and this many notifications have arrived since, so it's clear they'd be useful. */
const AFTER_NOTIFICATIONS = 3;

interface Memory {
  dismissedAt: number;
  missed: number;
}

const recall = (): Memory | null => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
};
const remember = (m: Memory) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* private mode: the prompt just shows again next time */
  }
};

/**
 * Asks to turn on notifications for this device: once soon after signing in on it, and again after a
 * "Not now" when a few days have passed and notifications keep arriving while they're off.
 */
export function PushPrompt() {
  const toast = useToast();
  const { data: config } = useApi<{ enabled: boolean; publicKey?: string }>('/push/config');
  const [state, setState] = useState<PushState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!config) return;
    // The service worker registers after the page loads; wait for it (briefly) so "off" isn't mistaken for "unavailable".
    const ready = 'serviceWorker' in navigator ? Promise.race([navigator.serviceWorker.ready, new Promise((r) => window.setTimeout(r, 5000))]) : Promise.resolve();
    void ready.then(() => pushState(config.enabled)).then(setState);
  }, [config]);

  // First time on this device: ask shortly after the app has loaded.
  useEffect(() => {
    if (state !== 'off' || recall()) return;
    const t = window.setTimeout(() => setOpen(true), 2500);
    return () => window.clearTimeout(t);
  }, [state]);

  // Off for a while and notifications keep coming: ask again.
  useRealtime((e) => {
    if (e.type !== 'notification' || state !== 'off' || open) return;
    const memory = recall();
    if (!memory) return;
    const missed = memory.missed + 1;
    remember({ ...memory, missed });
    if (missed >= AFTER_NOTIFICATIONS && Date.now() - memory.dismissedAt >= QUIET_FOR) setOpen(true);
  });

  if (!open || state !== 'off' || !config?.publicKey) return null;

  const later = () => {
    remember({ dismissedAt: Date.now(), missed: 0 });
    setOpen(false);
  };
  const turnOn = async () => {
    setBusy(true);
    try {
      const ok = await enablePush(config.publicKey!, (sub) => api.post('/me/push', sub));
      const next = await pushState(true);
      setState(next);
      if (ok) {
        toast('Notifications are on for this device');
        setOpen(false);
      } else if (next === 'denied') {
        toast('Notifications are blocked for this site. You can allow them in your browser’s site settings.', 'error');
        later();
      }
    } catch (e) {
      toast((e as Error).message || 'Could not turn on notifications', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="push-prompt card" role="dialog" aria-labelledby="push-prompt-title" aria-describedby="push-prompt-text">
      <span className="push-prompt-icon" aria-hidden="true">
        <Icon name="bell" size={20} />
      </span>
      <div className="push-prompt-body">
        <strong id="push-prompt-title">Turn on notifications?</strong>
        <p id="push-prompt-text" className="muted">
          Get mentions, direct messages and assignments on this device, even when Küü isn’t open. Quiet hours and focus time still apply.
        </p>
        <div className="row-gap">
          <button className="btn primary sm" onClick={turnOn} disabled={busy}>
            {busy ? 'Turning on…' : 'Turn on'}
          </button>
          <button className="btn sm" onClick={later} disabled={busy}>
            Not now
          </button>
        </div>
      </div>
      <button className="icon-btn xs push-prompt-close" onClick={later} aria-label="Close">
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
