import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { api, authHeaders, formWith, session } from '../lib/api';
import { bytes as fmtBytes, timeAgo } from '../lib/format';
import { useApi, useRealtime } from '../lib/hooks';
import { useTheme } from '../lib/theme';
import { Icon } from './Icon';
import { Button, Card, Checkbox, confirm, Muted, Pill, Row, SearchBox, Select, Sheet, T, Toggle, useAction, useToast } from './kit';
import { UpgradeNotice } from './plan';

interface Recording {
  id: string;
  kind: 'audio' | 'screen';
  status: 'recording' | 'ready' | 'stopped';
  mime: string | null;
  size: number;
  duration_sec: number;
  started_by: { id: string; name: string } | null;
  started_at: string;
  ended_at: string | null;
  transcript_status: 'none' | 'live' | 'queued' | 'processing' | 'done' | 'failed';
  transcript_error: string | null;
  segment_count: number;
  media_url: string | null;
  can_delete: boolean;
}
interface RecordingsInfo {
  recordings: Recording[];
  available: boolean;
  can_record: boolean;
  server_transcription: boolean;
  max_bytes: number;
}
interface Segment {
  id: string;
  start_ms: number;
  end_ms?: number;
  text: string;
  speaker_name?: string | null;
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor(s / 60) % 60).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Record a meeting from the phone's microphone and list recordings with their transcripts.
 * Phones record sound only; the server can transcribe the recording once it is saved.
 */
export function MeetingRecordings({ meetingId, meetingTitle }: { meetingId: string; meetingTitle: string }) {
  const { c } = useTheme();
  const act = useAction();
  const toast = useToast();
  const { data, reload } = useApi<RecordingsInfo>(`/meetings/${meetingId}/recordings`);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 500);
  const [asking, setAsking] = useState(false);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [transcribe, setTranscribe] = useState(true);
  const [captions, setCaptions] = useState<Segment[]>([]);
  const started = useRef(0);

  useRealtime((e) => {
    if (e.meetingId !== meetingId) return;
    if (e.type === 'meeting.recording') reload();
    if (e.type === 'meeting.caption') setCaptions((cs) => [...cs, ...e.segments].slice(-40));
  });

  // Rough size check: high-quality AAC is about 16 KB a second.
  useEffect(() => {
    if (recordingId && data && (state.durationMillis / 1000) * 16_000 > data.max_bytes * 0.95) {
      toast('The recording reached the upload size limit, so it was stopped and saved.', 'error');
      void stop(true);
    }
  }, [state.durationMillis]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (language: string) => {
    const perm = await AudioModule.requestRecordingPermissionsAsync();
    if (!perm.granted) return toast('Recording needs permission to use your microphone.', 'error');
    const rec = await act(() => api.post<Recording>(`/meetings/${meetingId}/recordings`, { kind: 'audio', consent: true, language }));
    if (!rec) return;
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    started.current = Date.now();
    setCaptions([]);
    setRecordingId(rec.id);
  };

  const stop = async (save: boolean) => {
    const id = recordingId;
    if (!id) return;
    setRecordingId(null);
    await recorder.stop();
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    const uri = recorder.uri;
    if (!save || !uri) {
      await act(() => api.post(`/recordings/${id}/stop`));
      reload();
      return;
    }
    setSaving(true);
    const ext = Platform.OS === 'web' ? 'webm' : 'm4a';
    const ok = await act(
      () =>
        api.upload(
          `/recordings/${id}/upload`,
          formWith({
            durationSec: String(Math.round((Date.now() - started.current) / 1000)),
            transcribe: String(!!data?.server_transcription && transcribe),
            file: { uri, name: `recording.${ext}`, type: Platform.OS === 'web' ? 'audio/webm' : 'audio/mp4' },
          }),
        ),
      'Recording saved',
    );
    if (!ok && Platform.OS !== 'web' && (await Sharing.isAvailableAsync())) {
      // Keep a copy the person can save rather than losing the meeting.
      toast('The recording could not be uploaded. Save it to your phone instead.', 'error');
      await Sharing.shareAsync(uri, { dialogTitle: `${meetingTitle} recording` });
    }
    setSaving(false);
    reload();
  };

  if (!data) return null;
  const others = data.recordings.filter((r) => r.status === 'recording' && r.id !== recordingId);
  if (!data.recordings.length && !data.can_record) return null;

  return (
    <Card style={{ gap: 10 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T size={17} weight="display">
          Recording & transcript
        </T>
        {data.can_record && data.available && !recordingId && (
          <Pressable
            onPress={() => setAsking(true)}
            disabled={saving}
            accessibilityRole="button"
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 32, borderRadius: 16, borderWidth: 1, borderColor: c.redLine, backgroundColor: c.redSoft }}
          >
            <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: c.red }} />
            <T size={13} weight="bold" tone="red">
              {saving ? 'Saving…' : 'Record'}
            </T>
          </Pressable>
        )}
      </Row>
      {!data.available && data.can_record && <UpgradeNotice feature="recordings" />}
      {others.map((r) => (
        <Row key={r.id} gap={8} style={{ padding: 10, borderRadius: 10, backgroundColor: c.amberSoft }} accessibilityLiveRegion="polite">
          <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: c.red }} />
          <T size={14} tone="amber">
            {r.started_by?.name} is recording this meeting.
          </T>
        </Row>
      ))}
      {recordingId && (
        <View style={{ gap: 8, padding: 12, borderRadius: 12, backgroundColor: c.redSoft, borderWidth: 1, borderColor: c.redLine }} accessibilityLiveRegion="polite">
          <Row>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.red }} />
            <T weight="bold">Recording {clock(state.durationMillis)}</T>
          </Row>
          {data.server_transcription && <Toggle label="Transcribe after saving" value={transcribe} onChange={setTranscribe} />}
          <Row>
            <Button small title="Discard" onPress={async () => (await confirm('Discard this recording?', undefined, 'Discard')) && void stop(false)} />
            <Button small variant="primary" title="Stop and save" onPress={() => void stop(true)} />
          </Row>
        </View>
      )}
      {captions.length > 0 && (
        <View style={{ gap: 4, padding: 10, borderRadius: 10, backgroundColor: c.sunken }} accessibilityLabel="Live captions">
          {captions.slice(-6).map((cap) => (
            <T key={cap.id} size={14}>
              {cap.speaker_name ? <T size={14} weight="bold">{`${cap.speaker_name}: `}</T> : null}
              {cap.text}
            </T>
          ))}
        </View>
      )}
      {data.recordings
        .filter((r) => r.status === 'ready')
        .map((r) => (
          <RecordingItem key={r.id} rec={r} serverTranscription={data.server_transcription} onChange={reload} meetingTitle={meetingTitle} />
        ))}
      {!data.recordings.some((r) => r.status === 'ready') && !recordingId && data.can_record && data.available && (
        <Muted size={13}>Record the meeting from this phone’s microphone{data.server_transcription ? '; the server writes a transcript once it’s saved' : ''}.</Muted>
      )}
      {asking && (
        <StartRecording
          serverTranscription={data.server_transcription}
          onClose={() => setAsking(false)}
          onStart={(language) => {
            setAsking(false);
            void start(language);
          }}
        />
      )}
    </Card>
  );
}

function StartRecording({ serverTranscription, onClose, onStart }: { serverTranscription: boolean; onClose: () => void; onStart: (language: string) => void }) {
  const [language, setLanguage] = useState('en');
  const [consent, setConsent] = useState(false);
  return (
    <Sheet open onClose={onClose} title="Record this meeting" footer={<Button title="Start recording" variant="primary" full disabled={!consent} onPress={() => onStart(language)} />}>
      <Muted>Records this phone’s microphone — ideal for a meeting in one room, or on speakerphone. Small files, even on a slow connection.</Muted>
      <Select
        title="Language spoken"
        value={language}
        onChange={setLanguage}
        options={[
          { id: 'en', label: 'English' },
          { id: 'fr', label: 'French' },
          { id: 'ar', label: 'Arabic' },
          { id: 'es', label: 'Spanish' },
          { id: 'pt', label: 'Portuguese' },
        ]}
      />
      {serverTranscription ? <Muted size={12}>The server can transcribe the recording after you save it.</Muted> : <Muted size={12}>Live captions are available when recording from a browser.</Muted>}
      <Checkbox checked={consent} onChange={setConsent} label="Everyone in this meeting knows it is being recorded and agrees." />
      <Muted size={12}>People invited to the meeting are notified, and anyone viewing it in Küü sees that it is being recorded.</Muted>
    </Sheet>
  );
}

function Player({ rec, onTime, seekTo }: { rec: Recording; onTime: (ms: number) => void; seekTo: number | null }) {
  const { c } = useTheme();
  const source = { uri: `${session.server}${rec.media_url ?? ''}`, headers: authHeaders() };
  const audio = useAudioPlayer(rec.kind === 'audio' ? source : null);
  const status = useAudioPlayerStatus(audio);
  const video = useVideoPlayer(rec.kind === 'screen' ? source : null);
  useEffect(() => {
    if (rec.kind === 'audio') onTime(status.currentTime * 1000);
  }, [status.currentTime]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (seekTo === null) return;
    if (rec.kind === 'audio') {
      audio.seekTo(seekTo / 1000);
      audio.play();
    } else {
      video.currentTime = seekTo / 1000;
      video.play();
    }
  }, [seekTo]); // eslint-disable-line react-hooks/exhaustive-deps
  if (rec.kind === 'screen')
    return (
      <View style={{ width: '100%', aspectRatio: 16 / 9, borderRadius: 12, overflow: 'hidden', backgroundColor: '#000' }}>
        <VideoView player={video} style={{ flex: 1 }} nativeControls contentFit="contain" />
      </View>
    );
  return (
    <Row gap={10} style={{ padding: 8, borderRadius: 999, backgroundColor: c.surface2, borderWidth: 1, borderColor: c.line }}>
      <Pressable
        onPress={() => (status.playing ? audio.pause() : audio.play())}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? 'Pause' : 'Play'}
        style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}
      >
        <Icon name={status.playing ? 'square' : 'play'} size={15} color="#fff" />
      </Pressable>
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: c.line, overflow: 'hidden' }}>
          <View style={{ width: `${status.duration ? (status.currentTime / status.duration) * 100 : 0}%`, height: 4, backgroundColor: c.accent }} />
        </View>
        <Muted size={11}>
          {clock(status.currentTime * 1000)} / {clock((status.duration || rec.duration_sec) * 1000)}
        </Muted>
      </View>
    </Row>
  );
}

function RecordingItem({ rec, serverTranscription, onChange, meetingTitle }: { rec: Recording; serverTranscription: boolean; onChange: () => void; meetingTitle: string }) {
  const { c } = useTheme();
  const act = useAction();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [now, setNow] = useState(0);
  const [seek, setSeek] = useState<number | null>(null);
  const { data: transcript } = useApi<{ source: 'live' | 'server'; segments: Segment[] }>(open ? `/recordings/${rec.id}/transcript` : null, [rec.transcript_status]);
  const shown = (transcript?.segments ?? []).filter((s) => !q || s.text.toLowerCase().includes(q.toLowerCase()));
  const statusText: Record<Recording['transcript_status'], string> = {
    none: 'No transcript',
    live: 'Live captions',
    queued: 'Transcript queued…',
    processing: 'Transcribing…',
    done: 'Transcript ready',
    failed: 'Transcription failed',
  };
  const shareText = async () => {
    const text = `${meetingTitle}\n\n${(transcript?.segments ?? []).map((s) => `[${clock(s.start_ms)}] ${s.speaker_name ? `${s.speaker_name}: ` : ''}${s.text}`).join('\n')}\n`;
    const name = `${meetingTitle.replace(/[^\w\- ]+/g, '').trim() || 'meeting'} transcript.txt`;
    if (Platform.OS === 'web') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      a.download = name;
      a.click();
      return;
    }
    const file = new File(Paths.cache, name);
    file.write(text);
    await Sharing.shareAsync(file.uri, { mimeType: 'text/plain', dialogTitle: name });
  };
  const download = async () => {
    const url = `${session.server}${rec.media_url}?download=1`;
    if (Platform.OS === 'web') return void globalThis.open?.(url, '_blank');
    const file = await File.downloadFileAsync(url, new File(Paths.cache, `${meetingTitle.replace(/[^\w\- ]+/g, '').trim() || 'meeting'}.${rec.kind === 'screen' ? 'webm' : 'm4a'}`), { headers: authHeaders(), idempotent: true });
    await Sharing.shareAsync(file.uri);
  };
  return (
    <View style={{ gap: 8, paddingTop: 10, borderTopWidth: 1, borderColor: c.line2 }}>
      <Row wrap gap={6}>
        <Icon name={rec.kind === 'screen' ? 'video' : 'mic'} size={16} color={c.ink2} />
        <T weight="bold">{clock(rec.duration_sec * 1000)}</T>
        <Muted size={12} style={{ flex: 1 }}>
          by {rec.started_by?.name} · {timeAgo(rec.started_at)} · {fmtBytes(rec.size)}
        </Muted>
        <Pill label={statusText[rec.transcript_status]} tone={rec.transcript_status === 'failed' ? 'red' : rec.transcript_status === 'done' ? 'green' : 'neutral'} />
      </Row>
      <Player rec={rec} onTime={setNow} seekTo={seek} />
      <Row wrap>
        {(rec.segment_count > 0 || rec.transcript_status === 'done') && <Button small icon="transcript" title={open ? 'Hide transcript' : 'Transcript'} onPress={() => setOpen((o) => !o)} />}
        {serverTranscription && !['queued', 'processing'].includes(rec.transcript_status) && (
          <Button small title={rec.transcript_status === 'done' ? 'Transcribe again' : 'Transcribe'} onPress={async () => (await act(() => api.post(`/recordings/${rec.id}/transcribe`), 'Transcription started')) && onChange()} />
        )}
        <Button small icon="download" title="Save" onPress={() => act(download)} />
        {rec.can_delete && (
          <Button
            small
            variant="danger"
            icon="trash"
            title="Delete"
            onPress={async () => {
              if (!(await confirm('Delete this recording and its transcript?', 'This cannot be undone.', 'Delete'))) return;
              if (await act(() => api.del(`/recordings/${rec.id}`), 'Recording deleted')) onChange();
            }}
          />
        )}
      </Row>
      {open && transcript && (
        <View style={{ gap: 8 }}>
          <SearchBox value={q} onChangeText={setQ} placeholder="Search the transcript" />
          <Row style={{ justifyContent: 'space-between' }}>
            <Muted size={12} style={{ flex: 1 }}>
              {transcript.source === 'server' ? 'Full transcript' : 'Live captions from the recording device'} · may contain recognition mistakes
            </Muted>
            <Button small title="Share as text" onPress={() => act(shareText)} />
          </Row>
          {shown.map((s) => {
            const current = now >= s.start_ms && now < (s.end_ms ?? s.start_ms) + 500;
            return (
              <Row key={s.id} gap={8} style={{ alignItems: 'flex-start', padding: 6, borderRadius: 8, backgroundColor: current ? c.accentSoft : 'transparent' }}>
                <Pressable onPress={() => setSeek(s.start_ms)} accessibilityLabel={`Play from ${clock(s.start_ms)}`} hitSlop={6}>
                  <T size={12} weight="bold" tone="accent">
                    {clock(s.start_ms)}
                  </T>
                </Pressable>
                <T size={14} style={{ flex: 1 }}>
                  {s.speaker_name ? <T size={14} weight="bold">{`${s.speaker_name}: `}</T> : null}
                  {s.text}
                </T>
              </Row>
            );
          })}
          {!shown.length && <Muted>{q ? 'No matches.' : 'Nothing was transcribed.'}</Muted>}
        </View>
      )}
    </View>
  );
}
