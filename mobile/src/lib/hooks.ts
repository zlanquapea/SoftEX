import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { realtime } from './realtime';

/** Fetch JSON from the API with loading/error state and a reload function. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [refreshing, setRefreshing] = useState(false);
  const current = useRef(path);
  current.current = path;

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const result = await api.get<T>(path);
      if (current.current === path) {
        setData(result);
        setError(null);
      }
    } catch (e) {
      if (current.current === path) setError(e as Error);
    } finally {
      if (current.current === path) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  useEffect(() => {
    setLoading(!!path);
    setData(undefined);
    reload();
  }, [reload, path]);

  /** For pull-to-refresh. */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

  return { data, error, loading, reload, refresh, refreshing, setData };
}

/** Subscribe to realtime events; the handler always sees the latest closure. */
export function useRealtime(handler: (event: any) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => realtime.subscribe((e) => ref.current(e)), []);
}

/** Reload when the user comes back to a screen (after editing something on the next one). */
export function useReloadOnFocus(reload: () => void) {
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      reload();
    }, [reload]),
  );
}

/** Debounce a changing value. */
export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
