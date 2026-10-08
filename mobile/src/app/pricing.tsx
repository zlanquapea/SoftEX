import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSession } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import { lrd } from '@/ui/billing';
import { Icon } from '@/ui/Icon';
import { Button, Card, Eyebrow, H1, LinkText, Loading, Muted, Pill, Row, Screen, T } from '@/ui/kit';
import { openLink } from '@/ui/Markdown';
import { FEATURE_ORDER, PlanFeatures, PlanPrice, usd } from '@/ui/plan';
import { usePublicPricing } from '@/screens/auth';

const FAQ = (supportEmail: string | null) => [
  ['What happens when the trial ends?', 'Your workspace moves to the Free plan automatically. Nothing is deleted; paid features pause until you choose a plan.'],
  ['How do I pay?', 'An admin chooses a plan under Administration → Billing on the web, pays by mobile money or bank transfer, and enters the transaction ID. We confirm it and your plan starts — usually within one business day.'],
  ['Is the price per person?', "No. Each plan is one flat monthly price for the whole workspace, up to its member limit. Guests (clients and partners you share specific channels or projects with) don't count toward the limit."],
  ['We have more than 50 people.', `Larger organisations get a custom quote based on usage, onboarding and support needs.${supportEmail ? ` Email ${supportEmail} to talk it through.` : ' Contact us to talk it through.'}`],
  ['Can I leave at any time?', 'Yes. Export your data whenever you like, and owners can delete the workspace permanently from Administration → Workspace.'],
];

export default function Pricing() {
  const { c } = useTheme();
  const { me } = useSession();
  const { data } = usePublicPricing();
  const [open, setOpen] = useState<number | null>(0);
  if (!data) return <Loading />;
  const perYear = (price: number) => price * 12 * data.annual_factor;
  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Pricing', headerStyle: { backgroundColor: c.canvas }, headerTintColor: c.accentInk, headerShadowVisible: false }} />
      <Screen>
        <Eyebrow>Pricing</Eyebrow>
        <H1>Everything your team needs, one simple price</H1>
        <Muted size={15}>
          Chat, projects, knowledge and meetings in one place. One flat price per workspace, not per person. Start with a {data.trial_days}-day free trial of Organization — no payment needed — and keep a free plan for up to 5 members forever.
        </Muted>
        {data.plans.map((p) => (
          <Card key={p.id} style={{ gap: 10, borderColor: p.id === 'organization' ? c.accent : c.line, borderWidth: p.id === 'organization' ? 2 : 1 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T size={19} weight="display">
                {p.name}
              </T>
              {p.id === 'organization' && <Pill label="Includes AI" tone="accent" />}
            </Row>
            <PlanPrice plan={p} />
            <Muted size={12}>
              {p.price == null ? 'Based on usage, onboarding and support needs' : p.price ? `${lrd(p.price, data.lrd_per_usd)}${data.lrd_per_usd ? ' · ' : ''}${usd(perYear(p.price))} a year when paid yearly` : 'Free forever'}
            </Muted>
            <Muted>{p.tagline}</Muted>
            <PlanFeatures plan={p} all={FEATURE_ORDER} />
            {p.price == null
              ? data.support_email && <Button title="Contact us" onPress={() => openLink(`mailto:${data.support_email}?subject=${encodeURIComponent(`Küü ${p.name} quote`)}`)} />
              : !me && <Button variant={p.id === 'organization' ? 'primary' : 'secondary'} full title={p.price ? 'Start free trial' : 'Get started free'} onPress={() => router.push('/register')} />}
          </Card>
        ))}
        <T size={20} weight="display" style={{ marginTop: 8 }}>
          Questions
        </T>
        <Card padded={false} style={{ paddingHorizontal: 14 }}>
          {FAQ(data.support_email).map(([q, a], i) => (
            <View key={q} style={{ borderTopWidth: i ? 1 : 0, borderColor: c.line2 }}>
              <Pressable onPress={() => setOpen(open === i ? null : i)} accessibilityRole="button" accessibilityState={{ expanded: open === i }} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 14 }}>
                <T weight="semibold" style={{ flex: 1 }}>
                  {q}
                </T>
                <Icon name={open === i ? 'chevronDown' : 'chevronRight'} size={16} color={c.muted} />
              </Pressable>
              {open === i && <Muted style={{ paddingBottom: 14 }}>{a}</Muted>}
            </View>
          ))}
        </Card>
        {data.support_email && (
          <Row gap={4} wrap>
            <Muted>More questions?</Muted>
            <LinkText onPress={() => openLink(`mailto:${data.support_email}`)}>{data.support_email}</LinkText>
          </Row>
        )}
      </Screen>
    </>
  );
}
