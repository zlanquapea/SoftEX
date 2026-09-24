import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { realtime } from './realtime';

/** Fetch JSON from the API with loading/error state and a reload function. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(!!path);
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

  return { data, error, loading, reload, setData };
}

/** Subscribe to realtime events; the handler always sees the latest closure. */
export function useRealtime(handler: (event: any) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => realtime.subscribe((e) => ref.current(e)), []);
}

/** Debounce a changing value. */
export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}
