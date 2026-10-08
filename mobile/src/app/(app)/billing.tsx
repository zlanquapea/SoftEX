import { Stack } from 'expo-router';
import { useSession } from '@/lib/session';
import { BillingSettings } from '@/ui/billing';
import { Muted, Screen } from '@/ui/kit';

export default function Billing() {
  const { can } = useSession();
  return (
    <>
      <Stack.Screen options={{ title: 'Plan & billing' }} />
      <Screen>{can('admin') ? <BillingSettings /> : <Muted>Only workspace admins can see billing.</Muted>}</Screen>
    </>
  );
}
