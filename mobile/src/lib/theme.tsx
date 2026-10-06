import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { storage } from './storage';

/** The same colour tokens as the web app (client/src/styles.css), for light and dark. */
const light = {
  brandTerracotta: '#b5461b',
  brandCream: '#fef6eb',
  brandPeach: '#ea9c5e',
  ink: '#2b1d16',
  ink2: '#4b3a30',
  muted: '#7a695e',
  line: '#eadfd1',
  line2: '#f3eadf',
  lineStrong: '#e0d0bd',
  surface: '#fffcf7',
  surface2: '#fcf6ee',
  canvas: '#fef6eb',
  sunken: '#f3eadf',
  nav: '#2e1a12',
  nav2: '#3d241a',
  navLine: '#4a2e22',
  navText: '#f6e9dc',
  navMuted: '#b9a08d',
  navAccent: '#ea9c5e',
  accent: '#b5461b',
  accent2: '#c4552a',
  accentSoft: '#fbe6d9',
  accentInk: '#8f3413',
  accentLine: '#f1c7ad',
  accentWash: '#fdf0e7',
  onAccent: '#ffffff',
  hover: 'rgba(181, 70, 27, 0.06)',
  blue: '#4e83e5',
  blueSoft: '#e7efff',
  blueInk: '#2c5fbf',
  blueLine: '#c7d8fb',
  green: '#3f9a6d',
  greenSoft: '#e4f5ec',
  greenLine: '#bfe3cf',
  amber: '#c9861a',
  amberSoft: '#fdf1dc',
  amberInk: '#8a5a0b',
  amberLine: '#f0d7a3',
  red: '#c93a3a',
  redSoft: '#fde6e3',
  redLine: '#f4c3c3',
  dotAway: '#b8a595',
  wbFill: '#ffffff',
  overlay: 'rgba(46, 26, 18, 0.45)',
  shadow: '#5a2d14',
};

export type Palette = typeof light;

const dark: Palette = {
  ...light,
  ink: '#ededec',
  ink2: '#c8c6c3',
  muted: '#9b9894',
  line: '#2e2d2b',
  line2: '#252423',
  lineStrong: '#3d3b39',
  surface: '#1c1c1b',
  surface2: '#232322',
  canvas: '#131312',
  sunken: '#161615',
  nav: '#0e0e0d',
  nav2: '#232322',
  navLine: '#2a2928',
  navText: '#ededec',
  navMuted: '#8f8b86',
  navAccent: '#f08c5a',
  accent: '#d4602e',
  accent2: '#e06d3a',
  accentSoft: 'rgba(232, 118, 70, 0.14)',
  accentInk: '#f59a70',
  accentLine: 'rgba(232, 118, 70, 0.4)',
  accentWash: 'rgba(232, 118, 70, 0.06)',
  hover: 'rgba(255, 255, 255, 0.05)',
  blue: '#6c9cf2',
  blueSoft: 'rgba(108, 156, 242, 0.14)',
  blueInk: '#9dbdf7',
  blueLine: 'rgba(108, 156, 242, 0.35)',
  green: '#4fbf8a',
  greenSoft: 'rgba(79, 191, 138, 0.13)',
  greenLine: 'rgba(79, 191, 138, 0.35)',
  amber: '#e2a444',
  amberSoft: 'rgba(226, 164, 68, 0.13)',
  amberInk: '#efc27a',
  amberLine: 'rgba(226, 164, 68, 0.38)',
  red: '#ef6b6b',
  redSoft: 'rgba(239, 107, 107, 0.13)',
  redLine: 'rgba(239, 107, 107, 0.38)',
  dotAway: '#6f6b67',
  wbFill: '#232322',
  overlay: 'rgba(0, 0, 0, 0.6)',
  shadow: '#000000',
};

/** Avatar, label and project colours. */
export const SWATCH: Record<string, string> = {
  purple: '#7567e8',
  blue: '#4e83e5',
  green: '#49a77a',
  coral: '#e8766a',
  gold: '#d9a441',
  sky: '#4bb2d8',
  mint: '#3fb59a',
  lilac: '#a38bdc',
  orange: '#ec8e45',
};
export const swatch = (name: string | null | undefined) => (name && (SWATCH[name] ?? (name.startsWith('#') ? name : undefined))) || SWATCH.purple;

export const fonts = {
  display: 'Manrope_700Bold',
  displayHeavy: 'Manrope_800ExtraBold',
  displaySemi: 'Manrope_600SemiBold',
  body: 'DMSans_400Regular',
  medium: 'DMSans_500Medium',
  semibold: 'DMSans_600SemiBold',
  bold: 'DMSans_700Bold',
};

export const radius = { lg: 14, md: 9, sm: 6, pill: 999 };

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'kuu.theme';

interface ThemeValue {
  c: Palette;
  dark: boolean;
  choice: ThemeChoice;
  setChoice: (choice: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeValue>({ c: light, dark: false, choice: 'system', setChoice: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const device = useColorScheme();
  const [choice, setChoiceState] = useState<ThemeChoice>('system');
  useEffect(() => {
    storage.get(KEY).then((v) => (v === 'light' || v === 'dark') && setChoiceState(v));
  }, []);
  const value = useMemo<ThemeValue>(() => {
    const isDark = choice === 'system' ? device === 'dark' : choice === 'dark';
    return {
      c: isDark ? dark : light,
      dark: isDark,
      choice,
      setChoice: (next) => {
        setChoiceState(next);
        if (next === 'system') storage.del(KEY);
        else storage.set(KEY, next);
      },
    };
  }, [choice, device]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);

/** Build a StyleSheet from the current palette, memoised per theme. */
export function useStyles<T>(make: (c: Palette) => T): T {
  const { c } = useTheme();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => make(c), [c]);
}
