import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Message } from '@/lib/api';
import { useApi, useRealtime } from '@/lib/hooks';
import { useTheme } from '@/lib/theme';
import { ForwardSheet, ThreadAi } from '@/ui/chat';
import { ErrorState, Loading, Muted } from '@/ui/kit';
import { Composer, DecisionSheet, MessageItem, TaskFromMessageSheet, useMessageActions } from '@/ui/messages';
import type { ChannelDetail } from '../channels/[id]';

/** A message and its replies, with a reply box — the web's thread panel as its own screen. */
export default function Thread() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { data, error, reload } = useApi<{ root: Message; replies: Message[]; channel: { id: string; name: string } }>(`/messages/${id}/thread`);
  const { data: channel } = useApi<ChannelDetail>(data ? `/channels/${data.root.channel_id}` : null);
  const [taskFrom, setTaskFrom] = useState<Message | null>(null);
  const [decisionFrom, setDecisionFrom] = useState<Message | null>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const scroller = useRef<ScrollView>(null);
  const actions = useMessageActions({ setTaskFrom, setDecisionFrom, setForwarding, onSaved: () => reload() });
  useRealtime((e) => {
    if ((e.type === 'message.created' && (e.message.parent_id === data?.root.id || e.message.id === data?.root.id)) || (e.type === 'message.updated' && data && (e.parentId === data.root.id || e.messageId === data.root.id))) reload();
  });
  useEffect(() => {
    setTimeout(() => scroller.current?.scrollToEnd({ animated: true }), 100);
  }, [data?.replies.length]);
  if (error && !data) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading />;
  const isAnnouncement = channel?.kind === 'announcement';
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.canvas }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 44 : 0}>
      <Stack.Screen options={{ title: channel?.kind === 'dm' ? 'Thread' : `Thread in #${data.channel.name}` }} />
      <ScrollView ref={scroller} contentContainerStyle={{ paddingVertical: 8 }} keyboardShouldPersistTaps="handled">
        {data.replies.length > 0 && (
          <View style={{ paddingHorizontal: 14, paddingBottom: 8 }}>
            <ThreadAi messageId={data.root.id} excluded={!!channel?.ai_excluded} />
          </View>
        )}
        <MessageItem message={data.root} grouped={false} isAnnouncement={!!isAnnouncement} canPost actions={actions} inThread />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8 }}>
          <Muted size={12}>
            {data.replies.length} repl{data.replies.length === 1 ? 'y' : 'ies'}
          </Muted>
          <View style={{ flex: 1, height: 1, backgroundColor: c.line }} />
        </View>
        {data.replies.map((r) => (
          <MessageItem key={r.id} message={r} grouped={false} isAnnouncement={false} canPost actions={actions} inThread />
        ))}
      </ScrollView>
      <View style={{ paddingBottom: insets.bottom, backgroundColor: c.surface }}>
        <Composer channelId={data.root.channel_id} parentId={data.root.id} placeholder="Reply…" members={channel?.members ?? []} onSent={reload} />
      </View>
      <TaskFromMessageSheet message={taskFrom} projectId={channel?.project?.id} onClose={() => setTaskFrom(null)} />
      <ForwardSheet message={forwarding} onClose={() => setForwarding(null)} />
      <DecisionSheet message={decisionFrom} onClose={() => setDecisionFrom(null)} />
    </KeyboardAvoidingView>
  );
}
