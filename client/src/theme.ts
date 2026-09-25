import { useEffect, useState } from 'react';

/** Appearance: follow the device, or always light or dark. Saved per device. */
export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'kuu-theme';
const EVENT = 'kuu:theme';

export function getTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}

const deviceIsDark = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;

/** The theme actually showing right now. */
export const effectiveTheme = (choice: ThemeChoice = getTheme()): 'light' | 'dark' => (choice === 'system' ? (deviceIsDark() ? 'dark' : 'light') : choice);

export function setTheme(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* storage unavailable: still apply for this visit */
  }
  if (choice === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', choice);
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** The current choice and the theme showing, kept up to date when either changes. */
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(getTheme);
  const [shown, setShown] = useState(() => effectiveTheme(choice));
  useEffect(() => {
    const update = () => {
      const c = getTheme();
      setChoice(c);
      setShown(effectiveTheme(c));
    };
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    window.addEventListener(EVENT, update);
    media?.addEventListener('change', update);
    return () => {
      window.removeEventListener(EVENT, update);
      media?.removeEventListener('change', update);
    };
  }, []);
  return { choice, shown, setTheme };
}
