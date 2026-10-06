import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Small key/value store. On phones it is the device keychain / keystore, so the
 * session token never sits in plain files; the web preview falls back to localStorage.
 */
const web = Platform.OS === 'web';

export const storage = {
  async get(key: string): Promise<string | null> {
    try {
      return web ? globalThis.localStorage?.getItem(key) ?? null : await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string) {
    try {
      if (web) globalThis.localStorage?.setItem(key, value);
      else await SecureStore.setItemAsync(key, value);
    } catch {
      /* storage unavailable: keep going for this run */
    }
  },
  async del(key: string) {
    try {
      if (web) globalThis.localStorage?.removeItem(key);
      else await SecureStore.deleteItemAsync(key);
    } catch {
      /* ignore */
    }
  },
};
