import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from './api';
import { storage } from './storage';

/**
 * Phone notifications through Expo's push service. The server sends one when the
 * person isn't connected right now (same rules as web push: quiet hours, focus,
 * urgent messages). Tapping a notification opens the screen in `data.url`.
 */

const TOKEN_KEY = 'kuu.pushToken';
const supported = Platform.OS !== 'web' && Device.isDevice;

if (supported) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
}

export type PushState = 'unsupported' | 'off' | 'denied' | 'on';

export async function pushState(): Promise<PushState> {
  if (!supported) return 'unsupported';
  const { status } = await Notifications.getPermissionsAsync();
  if (status === 'denied') return 'denied';
  return status === 'granted' && (await storage.get(TOKEN_KEY)) ? 'on' : 'off';
}

/**
 * Ask for permission (only when `prompt` is set; otherwise only if already granted)
 * and register this phone with the server. Safe to call on every launch.
 */
export async function registerPush(prompt = false): Promise<PushState> {
  if (!supported) return 'unsupported';
  const config = await api.get<{ mobile?: boolean }>('/push/config').catch(() => null);
  if (!config?.mobile) return 'unsupported';
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Messages and updates',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 200, 120, 200],
      lightColor: '#b5461b',
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted' && prompt) status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return status === 'denied' ? 'denied' : 'off';
  const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
  const { data: token } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
  await api.post('/me/mobile-push', { token, platform: Platform.OS === 'ios' ? 'ios' : 'android' });
  await storage.set(TOKEN_KEY, token);
  return 'on';
}

export async function unregisterPush() {
  const token = await storage.get(TOKEN_KEY);
  if (!token) return;
  await storage.del(TOKEN_KEY);
  await api.del('/me/mobile-push', { token }).catch(() => {});
}

/** The in-app path a notification points to. */
export const pushTarget = (response: Notifications.NotificationResponse | null | undefined) => {
  const url = (response?.notification.request.content.data as { url?: unknown } | undefined)?.url;
  return typeof url === 'string' && url.startsWith('/') ? url : null;
};
