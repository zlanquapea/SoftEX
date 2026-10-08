import { Stack } from 'expo-router';
import { useState } from 'react';
import { useSession } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import { BoardsList, NewBoardSheet } from '@/ui/boards';
import { IconButton, Muted, Screen, Toggle } from '@/ui/kit';

export default function Boards() {
  const { c } = useTheme();
  const { me } = useSession();
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Stack.Screen options={{ title: 'Whiteboards', headerRight: () => (me!.role !== 'guest' ? <IconButton name="plus" label="New whiteboard" color={c.accentInk} onPress={() => setCreating(true)} /> : null) }} />
      <Screen>
        <Muted size={14}>Sticky notes, shapes, arrows and sketches on an endless canvas that your team edits together, live.</Muted>
        <Toggle label="Show archived" value={archived} onChange={setArchived} />
        <BoardsList archived={archived} />
      </Screen>
      <NewBoardSheet open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
