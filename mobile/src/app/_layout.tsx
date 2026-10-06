import { DMSans_400Regular, DMSans_500Medium, DMSans_600SemiBold, DMSans_700Bold } from '@expo-google-fonts/dm-sans';
import { Manrope_600SemiBold, Manrope_700Bold, Manrope_800ExtraBold } from '@expo-google-fonts/manrope';
import { useFonts } from 'expo-font';
import * as Notifications from 'expo-notifications';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider as NavThemeProvider, router } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { pushTarget, registerPush } from '@/lib/push';
import { SessionProvider, useSession } from '@/lib/session';
import { fonts, ThemeProvider, useTheme } from '@/lib/theme';
import { MfaRequired } from '@/screens/auth';
import { ToastProvider } from '@/ui/kit';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [loaded] = useFonts({ DMSans_400Regular, DMSans_500Medium, DMSans_600SemiBold, DMSans_700Bold, Manrope_600SemiBold, Manrope_700Bold, Manrope_800ExtraBold });
  return (
    <ThemeProvider>
      <SessionProvider>
        <ToastProvider>{loaded ? <Root /> : null}</ToastProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}

function Root() {
  const { me, loading } = useSession();
  const { c, dark } = useTheme();
  const pending = useRef<string | null>(null);

  useEffect(() => {
    if (!loading) SplashScreen.hideAsync().catch(() => {});
  }, [loading]);

  // Register this phone for notifications once signed in (asks only if not decided yet).
  useEffect(() => {
    if (me && !me.mfa_setup_required) registerPush(true).catch(() => {});
  }, [me?.user.id, me?.workspace.id, me?.mfa_setup_required]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tapping a notification opens what it is about; one tapped before sign-in opens afterwards.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const open = (url: string | null) => {
      if (!url) return;
      if (me) router.push(url as never);
      else pending.current = url;
    };
    open(pushTarget(Notifications.getLastNotificationResponse()));
    const sub = Notifications.addNotificationResponseReceivedListener((r) => open(pushTarget(r)));
    return () => sub.remove();
  }, [me]);
  useEffect(() => {
    if (me && pending.current) {
      const url = pending.current;
      pending.current = null;
      setTimeout(() => router.push(url as never), 300);
    }
  }, [me]);

  if (loading) return null;
  if (me?.mfa_setup_required) return <MfaRequired />;

  const nav = dark ? DarkTheme : DefaultTheme;
  return (
    <NavThemeProvider value={{ ...nav, colors: { ...nav.colors, background: c.canvas, card: c.surface, text: c.ink, border: c.line, primary: c.accent } }}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: c.canvas },
          headerTitleStyle: { fontFamily: fonts.display },
        }}
      >
        <Stack.Protected guard={!me}>
          <Stack.Screen name="(auth)" />
        </Stack.Protected>
        <Stack.Protected guard={!!me}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>
        <Stack.Screen name="invite/[token]" />
        <Stack.Screen name="verify-email/[token]" />
        <Stack.Screen name="reset-password/[token]" />
      </Stack>
    </NavThemeProvider>
  );
}
