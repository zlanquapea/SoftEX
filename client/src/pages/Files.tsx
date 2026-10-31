import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { LimitNotice, usePlanUsage } from '../components/Plan';
import { EmptyState, ErrorState, FilterBar, FormField, LoadingRows, Modal, Page, PageHeader, Pill, SearchField, SwitchField, useAction } from '@/components/kit';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { bytes, timeAgo } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';

export interface FileSummary {
  id: string;
  name: string;
  label: string;
  external_url: string | null;
  project_id: string | null;
  channel_id: string | null;
  task_id: string | null;
  version: number;
  mime: string | null;
  size: number | null;
  owner: { id: string; name: string; color: string } | null;
  updated_at: string;
  archived_at: string | null;
  /** Where the file lives: the chat or channel it was shared in, its project or task. */
  place?: { kind: 'chat' | 'channel' | 'project' | 'task' | 'team' | 'library'; name: string; link: string };
}

type Where = 'all' | 'chat' | 'channel' | 'project' | 'mine';
type Kind = 'all' | 'image' | 'document' | 'pdf' | 'sheet' | 'media' | 'link';

const KINDS: { value: Kind; label: string }[] = [
  { value: 'all', label: 'Any type' },
  { value: 'image', label: 'Images' },
  { value: 'document', label: 'Documents' },
  { value: 'pdf', label: 'PDFs' },
  { value: 'sheet', label: 'Spreadsheets' },
  { value: 'media', label: 'Audio and video' },
  { value: 'link', label: 'Links' },
];

/** What sort of file this is, from its type, or its name when the type is unknown. */
export function fileKind(f: Pick<FileSummary, 'mime' | 'name' | 'external_url'>): Exclude<Kind, 'all'> | 'other' {
  if (f.external_url) return 'link';
  const mime = f.mime ?? '';
  const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return 'media';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (/sheet|excel|csv/.test(mime) || ['xls', 'xlsx', 'csv', 'ods', 'numbers'].includes(ext)) return 'sheet';
  if (/word|document|text|rtf|presentation|powerpoint/.test(mime) || ['doc', 'docx', 'txt', 'md', 'rtf', 'odt', 'ppt', 'pptx', 'key', 'pages'].includes(ext)) return 'document';
  return 'other';
}

const KIND_ICON: Record<string, string> = { link: 'link', image: 'eye', media: 'play', pdf: 'transcript', sheet: 'table', document: 'transcript', other: 'file' };

/** "in #general", "with Maya Singh", "in Brand refresh". */
export function placeLabel(place: NonNullable<FileSummary['place']>) {
  if (place.kind === 'channel') return `#${place.name}`;
  if (place.kind === 'chat') return `Chat with ${place.name}`;
  if (place.kind === 'team') return `${place.name} team`;
  return place.name;
}

/** One file in a list: what it is, where it was shared, by whom and when. */
export function FileRow({ f }: { f: FileSummary }) {
  const kind = fileKind(f);
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
        <Icon name={KIND_ICON[kind]} size={18} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <Link to={`/files/${f.id}`} className="truncate font-medium hover:underline">
            {f.name}
          </Link>
          {f.label && <Pill className="shrink-0">{f.label}</Pill>}
        </div>
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          {f.place && f.place.kind !== 'library' && (
            <>
              <Link to={f.place.link} className="max-w-56 truncate hover:underline">
                {placeLabel(f.place)}
              </Link>
              <span aria-hidden>·</span>
            </>
          )}
          {f.owner && <span className="truncate">{f.owner.name}</span>}
          <span aria-hidden>·</span>
          <span>{f.external_url ? 'Link' : bytes(f.size)}</span>
          <span aria-hidden>·</span>
          <span>{timeAgo(f.updated_at)}</span>
        </p>
      </div>
      {f.owner && <Avatar user={f.owner} size="sm" className="max-sm:hidden" />}
    </li>
  );
}

/** Every file you can open, wherever it was shared: chats, channels, projects and tasks. */
export function Files() {
  const { me } = useSession();
  const act = useAction();
  const [search, setSearch] = useState('');
  const [where, setWhere] = useState<Where>('all');
  const [kind, setKind] = useState<Kind>('all');
  const [archived, setArchived] = useState(false);
  const { data, error, reload } = useApi<FileSummary[]>(`/files${qs({ archived: archived ? 'true' : undefined })}`);
  const upload = useRef<HTMLInputElement>(null);
  const { usage, reload: reloadUsage } = usePlanUsage();
  // At the storage limit uploads are refused, so say so up front instead of after picking a file.
  const storageFull = !!usage && usage.storage_limit != null && usage.storage_bytes >= usage.storage_limit;
  const [linking, setLinking] = useState(false);
  const [link, setLink] = useState({ name: '', url: '' });

  const words = search.trim().toLowerCase();
  const list = (data ?? []).filter(
    (f) =>
      (!words || `${f.name} ${f.label} ${f.owner?.name ?? ''} ${f.place?.name ?? ''}`.toLowerCase().includes(words)) &&
      (kind === 'all' || fileKind(f) === kind) &&
      (where === 'all' ||
        (where === 'mine' ? f.owner?.id === me!.user.id : where === 'project' ? f.place?.kind === 'project' || f.place?.kind === 'task' : f.place?.kind === where)),
  );

  return (
    <Page>
      <PageHeader
        title="Files"
        description="Everything shared with you, in one place — whichever chat, channel or project it was shared in."
        actions={
          me!.role !== 'guest' && (
            <>
              <Button variant="outline" onClick={() => setLinking(true)}>
                <Icon name="link" data-icon="inline-start" /> Link file
              </Button>
              <Button onClick={() => upload.current?.click()} disabled={storageFull} title={storageFull ? 'Storage is full — delete files or upgrade to upload more' : undefined}>
                <Icon name="upload" data-icon="inline-start" /> Upload
              </Button>
              <input
                ref={upload}
                type="file"
                hidden
                aria-label="Upload a file"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const form = new FormData();
                  form.append('file', f);
                  await act(() => api.upload('/files', form), 'File uploaded');
                  e.target.value = '';
                  reload();
                  reloadUsage();
                }}
              />
            </>
          )
        }
      />
      <LimitNotice kind="storage" usage={usage} />
      <FilterBar>
        <SearchField value={search} onChange={setSearch} placeholder="Search files" className="flex-1 sm:max-w-xs" />
        <NativeSelect size="sm" value={where} onChange={(e) => setWhere(e.target.value as Where)} aria-label="Shared in">
          <NativeSelectOption value="all">Shared anywhere</NativeSelectOption>
          <NativeSelectOption value="chat">In chats</NativeSelectOption>
          <NativeSelectOption value="channel">In channels</NativeSelectOption>
          <NativeSelectOption value="project">In projects and tasks</NativeSelectOption>
          <NativeSelectOption value="mine">Uploaded by me</NativeSelectOption>
        </NativeSelect>
        <NativeSelect size="sm" value={kind} onChange={(e) => setKind(e.target.value as Kind)} aria-label="File type">
          {KINDS.map((k) => (
            <NativeSelectOption key={k.value} value={k.value}>
              {k.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <SwitchField label="Archived" checked={archived} onCheckedChange={setArchived} />
      </FilterBar>

      {error && <ErrorState error={error} retry={reload} />}
      {!data && !error && <LoadingRows />}
      {data && !list.length && (
        <EmptyState icon="files" title={data.length ? 'No files match' : 'No files yet'}>
          {data.length ? 'Try another search or filter.' : 'Files shared in chats, channels and projects show up here.'}
        </EmptyState>
      )}
      {list.length > 0 && (
        <Card className="py-0">
          <ul className="divide-y" aria-label="Files">
            {list.map((f) => (
              <FileRow key={f.id} f={f} />
            ))}
          </ul>
        </Card>
      )}

      <Modal open={linking} onClose={() => setLinking(false)} title="Link an external file">
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await act(() => api.post('/files/link', link), 'Link added');
            if (ok) {
              setLinking(false);
              setLink({ name: '', url: '' });
              reload();
            }
          }}
        >
          <FormField label="Name">
            <Input required value={link.name} onChange={(e) => setLink({ ...link, name: e.target.value })} />
          </FormField>
          <FormField label="URL">
            <Input required type="url" value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} placeholder="https://…" />
          </FormField>
          <div className="flex justify-end">
            <Button type="submit">Add link</Button>
          </div>
        </form>
      </Modal>
    </Page>
  );
}
