import { Stack } from 'expo-router';
import { useTheme } from '@/lib/theme';

export default function AuthLayout() {
  const { c } = useTheme();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.canvas } }} initialRouteName="login" />;
}
