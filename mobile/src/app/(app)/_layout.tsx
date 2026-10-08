import { Stack } from 'expo-router';
import { ShellProvider } from '@/lib/shell';
import { useTheme } from '@/lib/theme';
import { headerTitleStyle } from '@/ui/header';

export default function AppLayout() {
  const { c } = useTheme();
  return (
    <ShellProvider>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.canvas },
          headerTintColor: c.accentInk,
          headerTitleStyle: { ...headerTitleStyle, color: c.ink },
          headerShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
          contentStyle: { backgroundColor: c.canvas },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="search" options={{ title: 'Search', presentation: 'modal' }} />
      </Stack>
    </ShellProvider>
  );
}
