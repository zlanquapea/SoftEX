import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { api } from '@/lib/api';
import { useLiveDoc, useLiveState } from '@/lib/collab';
import { useApi } from '@/lib/hooks';
import { useTheme } from '@/lib/theme';
import type { Board } from '@/ui/boards';
import { FavoriteButton } from '@/ui/chat';
import { ActionSheet, AvatarStack, ErrorState, IconButton, Loading, Pill, PromptSheet, Row, useAction } from '@/ui/kit';
import { Whiteboard } from '@/ui/Whiteboard';

export default function BoardView() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const act = useAction();
  const { data: board, error, reload, setData } = useApi<Board>(`/boards/${id}`);
  const live = useLiveDoc('board', board?.id);
  const state = useLiveState(live);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  if (error && !board) return <ErrorState error={error} retry={reload} />;
  if (!board) return <Loading />;
  const peers = state ? state.peers.map((p) => p.user) : [];
  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <Stack.Screen
        options={{
          title: board.title,
          headerRight: () => (
            <Row gap={0}>
              {peers.length > 0 && <AvatarStack users={peers} />}
              {state?.status === 'offline' && <Pill label="Offline" tone="red" />}
              {!board.can_edit && <Pill label="View only" />}
              <FavoriteButton kind="board" id={board.id} />
              <IconButton name="more" label="Whiteboard options" onPress={() => setMenu(true)} />
            </Row>
          ),
        }}
      />
      {!live || !state?.ready ? <Loading label="Opening the whiteboard" /> : <Whiteboard live={live} title={board.title} />}
      <ActionSheet
        open={menu}
        onClose={() => setMenu(false)}
        actions={[
          { label: 'Rename', icon: 'edit', onPress: () => setRenaming(true), hidden: !board.can_edit },
          { label: `Open ${board.project?.name ?? 'project'}`, icon: 'folder', onPress: () => router.push(`/projects/${board.project!.id}`), hidden: !board.project },
          {
            label: board.archived_at ? 'Restore whiteboard' : 'Archive whiteboard',
            icon: 'flag',
            hidden: !board.can_delete,
            onPress: async () => {
              const b = await act(() => api.patch<Board>(`/boards/${board.id}`, { archived: !board.archived_at }), board.archived_at ? 'Whiteboard restored' : 'Whiteboard archived');
              if (b && !board.archived_at) router.back();
              else if (b) setData(b);
            },
          },
        ]}
      />
      <PromptSheet
        open={renaming}
        onClose={() => setRenaming(false)}
        title="Rename whiteboard"
        label="Name"
        initial={board.title}
        onSubmit={async (title) => {
          const b = await act(() => api.patch<Board>(`/boards/${board.id}`, { title }));
          if (b) {
            setData(b);
            setRenaming(false);
          }
        }}
      />
    </View>
  );
}
