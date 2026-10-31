import { Fragment, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs, type Project } from '../api';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { DatePicker, EmptyState, ErrorState, FilterBar, FormField, Loading, Modal, Page, PageHeader, Panel, Pill, SearchField, SwitchField, TabBar, useAction, useConfirm } from '@/components/kit';
import { Badge } from '@/components/ui/badge';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { bytes, dateTime, plainMentions, timeAgo, dateLabel } from '../format';
import { useApi } from '../hooks';
import { usePeople, useSession } from '../session';
import { MediaAttachment, isPlayable } from '../components/Media';
import { FavoriteButton } from '../components/Favorites';
import { IconPicker, PageComments, PublishPanel } from '../components/PageExtras';
import { LiveEditor, PeerList, useEditingNow } from '../components/LiveEditor';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

interface PageSummary {
  id: string;
  title: string;
  status: 'draft' | 'approved';
  project_id: string | null;
  project_name: string | null;
  review_date: string | null;
  needs_review: boolean;
  version: number;
  owner: { id: string; name: string; color: string } | null;
  updated_at: string;
  updated_by: { id: string; name: string } | null;
  excerpt: string;
  parent_id: string | null;
  icon: string | null;
  public: boolean;
}

interface FileSummary {
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
}

export function Knowledge() {
  const [params, setParams] = useSearchParams();
  // Files moved to their own page.
  const toFiles = params.get('tab') === 'files';
  const navigate = useNavigate();
  const { me } = useSession();
  const act = useAction();
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState<'all' | 'approved' | 'draft' | 'review'>('all');
  const [archived, setArchived] = useState(false);
  const pages = useApi<PageSummary[]>(toFiles ? null : `/pages${qs({ archived: archived ? 'true' : undefined })}`);

  const pageIds = new Set((pages.data ?? []).map((p) => p.id));
  const childCount = (id: string) => (pages.data ?? []).filter((p) => p.parent_id === id).length;
  const narrowed = !!filter || status !== 'all';
  const pageList = (pages.data ?? []).filter(
    (p) =>
      (narrowed || !p.parent_id || !pageIds.has(p.parent_id)) &&
      (!filter || `${p.title} ${p.excerpt}`.toLowerCase().includes(filter.toLowerCase())) &&
      (status === 'all' || (status === 'review' ? p.needs_review : p.status === status)),
  );

  if (toFiles) return <Navigate to="/files" replace />;
  return (
    <Page>
      <PageHeader
        title="Knowledge"
        description="Policies, how-tos and decisions — with owners and review dates so they stay trustworthy."
        actions={
          me!.role !== 'guest' && (
            // Straight into an untitled page: name it later, or never.
            <Button
              onClick={async () => {
                const page = await act(() => api.post<{ id: string }>('/pages', {}));
                if (page) navigate(`/knowledge/${page.id}?edit=1&new=1`);
              }}
            >
              <Icon name="plus" data-icon="inline-start" /> New page
            </Button>
          )
        }
      />
      <FilterBar>
        <SearchField className="max-w-sm flex-1" placeholder="Filter pages" value={filter} onChange={setFilter} aria-label="Filter" />
        <NativeSelect value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status">
            <NativeSelectOption value="all">All pages</NativeSelectOption>
            <NativeSelectOption value="approved">Approved</NativeSelectOption>
            <NativeSelectOption value="draft">Drafts</NativeSelectOption>
            <NativeSelectOption value="review">Due for review</NativeSelectOption>
          </NativeSelect>
        <SwitchField label="Archived" checked={archived} onCheckedChange={setArchived} className="w-auto" />
      </FilterBar>

      <>
          {pages.error && <ErrorState error={pages.error} retry={pages.reload} />}
          {!pages.data && !pages.error && <Loading />}
          {pages.data && !pageList.length && (
            <EmptyState icon="book" title="No pages yet">
              Capture how your team works: policies, onboarding guides, runbooks.
            </EmptyState>
          )}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {pageList.map((p) => (
              <Link key={p.id} to={`/knowledge/${p.id}`} className="page-card group/page rounded-[min(var(--radius-4xl),24px)] outline-none focus-visible:ring-3 focus-visible:ring-ring/40">
                <Card size="sm" className="h-full transition-shadow group-hover/page:shadow-md">
                  <CardHeader>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {p.icon ? <span className="text-lg leading-none">{p.icon}</span> : <Icon name="book" size={16} className="text-muted-foreground" />}
                      {p.public && <Icon name="globe" size={14} label="Published" className="text-muted-foreground" />}
                      <span className="flex-1" />
                      {p.status === 'approved' ? <Pill tone="success">Approved</Pill> : <Pill>Draft</Pill>}
                      {p.needs_review && <Pill tone="danger">Review due</Pill>}
                    </div>
                    <CardTitle className="pt-1">{p.title}</CardTitle>
                    <CardDescription className="line-clamp-2">{p.excerpt || 'Empty page'}</CardDescription>
                  </CardHeader>
                  <CardFooter className="mt-auto text-xs text-muted-foreground">
                    {p.project_name ? `${p.project_name} · ` : ''}
                    {p.owner?.name} · updated {timeAgo(p.updated_at)}
                    {!narrowed && childCount(p.id) > 0 && ` · ${childCount(p.id)} sub-page${childCount(p.id) === 1 ? '' : 's'}`}
                  </CardFooter>
                </Card>
              </Link>
            ))}
          </div>
        </>
    </Page>
  );
}

interface PageFull extends PageSummary {
  body: string;
  project: { id: string; name: string; color: string } | null;
  versions: { version: number; title: string; created_at: string; edited_by_name: string }[];
  discussions: { id: string; body: string; created_at: string; channel_id: string; channel_name: string; user_name: string }[];
  can_edit: boolean;
  archived_at: string | null;
  breadcrumbs: { id: string; title: string; icon: string | null }[];
  children: { id: string; title: string; icon: string | null }[];
  comment_count: number;
  public_url: string | null;
}

export function PageView() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { me } = useSession();
  const people = usePeople();
  const act = useAction();
  const { data: page, error, reload } = useApi<PageFull>(`/pages/${id}`);
  const editing = params.get('edit') === '1';
  const [version, setVersion] = useState<{ version: number; title: string; body: string } | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [sharing, setSharing] = useState(false);
  const { data: allPages } = useApi<PageSummary[]>(page?.can_edit ? '/pages' : null);
  const editingNow = useEditingNow(id!);

  if (error) return <ErrorState error={error} retry={reload} />;
  if (!page) return <Loading />;
  const addSubPage = async () => {
    const child = await act(() => api.post<{ id: string }>('/pages', { title: 'Untitled', parentId: page.id }));
    if (child) navigate(`/knowledge/${child.id}?edit=1`);
  };
  // Pages this one may move under: not itself, and not one of its own descendants.
  const descendants = new Set<string>([page.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of allPages ?? []) {
      if (p.parent_id && descendants.has(p.parent_id) && !descendants.has(p.id)) {
        descendants.add(p.id);
        grew = true;
      }
    }
  }
  const askOwner = async () => {
    if (!page.owner || page.owner.id === me!.user.id) return;
    const dm = await act(() => api.post<{ id: string }>('/dms', { userIds: [page.owner!.id] }));
    if (dm) {
      try {
        localStorage.setItem(`softex.draft.${dm.id}.root`, `Question about [${page.title}](/knowledge/${page.id}): `);
      } catch {
        /* ignore */
      }
      navigate(`/channels/${dm.id}`);
    }
  };

  return (
    <Page width="narrow">
      <Breadcrumb className="crumbs">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link to="/knowledge" />}>Knowledge</BreadcrumbLink>
          </BreadcrumbItem>
          {page.project && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbLink render={<Link to={`/projects/${page.project.id}?tab=resources`} />}>{page.project.name}</BreadcrumbLink>
              </BreadcrumbItem>
            </>
          )}
          {page.breadcrumbs.map((b) => (
            <Fragment key={b.id}>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbLink render={<Link to={`/knowledge/${b.id}`} />}>
                  {b.icon && `${b.icon} `}
                  {b.title}
                </BreadcrumbLink>
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      {editing ? (
        <LiveEditor
          page={page}
          fresh={params.get('new') === '1'}
          onClose={() => {
            setParams({});
            reload();
          }}
          onSaved={() => {
            setParams({});
            reload();
          }}
        />
      ) : (
        <Card className="doc">
          <CardHeader className="gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {page.status === 'approved' ? <Pill tone="success">Approved</Pill> : <Pill>Draft</Pill>}
              {page.needs_review && <Pill tone="danger">Review due</Pill>}
              {page.archived_at && <Pill>Archived</Pill>}
            </div>
            <h1 className="doc-title flex flex-wrap items-center gap-2 font-heading text-3xl font-semibold tracking-tight">
              {page.can_edit ? (
                <IconPicker
                  value={page.icon}
                  onChange={async (icon) => {
                    await act(() => api.patch(`/pages/${page.id}`, { icon }));
                    reload();
                  }}
                />
              ) : (
                page.icon && <span aria-hidden="true">{page.icon}</span>
              )}
              {page.title} <FavoriteButton kind="page" id={page.id} />
            </h1>
            <p className="text-xs text-muted-foreground">
              Owner <strong className="text-foreground">{page.owner?.name}</strong> · version {page.version} · updated {timeAgo(page.updated_at)} by {page.updated_by?.name}
              {page.review_date && ` · review by ${dateLabel(page.review_date)}`}
            </p>
            {editingNow.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <PeerList peers={editingNow} label="Editing now" />
                {page.can_edit && (
                  <Button variant="outline" size="xs" onClick={() => setParams({ edit: '1' })}>
                    Join them
                  </Button>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {page.can_edit && (
                <Button variant="outline" size="sm" onClick={() => setParams({ edit: '1' })}>
                  <Icon name="edit" data-icon="inline-start" /> Edit
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setShowVersions((v) => !v)} aria-expanded={showVersions}>
                <Icon name="clock" data-icon="inline-start" /> History ({page.versions.length})
              </Button>
              <a href="#comments" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                <Icon name="chat" data-icon="inline-start" />
                Comments{page.comment_count ? ` (${page.comment_count})` : ''}
              </a>
              {page.can_edit && (
                <Button variant="outline" size="sm" onClick={addSubPage}>
                  <Icon name="plus" data-icon="inline-start" /> Sub-page
                </Button>
              )}
              {page.can_edit && me!.role !== 'guest' && (
                <Button size="sm" variant={page.public ? 'secondary' : 'outline'} onClick={() => setSharing(true)}>
                  <Icon name="globe" data-icon="inline-start" /> {page.public ? 'Published' : 'Publish'}
                </Button>
              )}
              {page.owner && page.owner.id !== me!.user.id && (
                <Button variant="ghost" size="sm" onClick={askOwner}>
                  <Icon name="chat" data-icon="inline-start" /> Ask the owner
                </Button>
              )}
            </div>
          </CardHeader>
          <Separator />
          <CardContent className="flex flex-col gap-6">
            {page.body ? <Markdown text={page.body} /> : <p className="text-sm text-muted-foreground">This page is empty.</p>}
            {page.children.length > 0 && (
              <nav className="flex flex-col gap-1" aria-label="Sub-pages">
                <h3 className="text-sm font-semibold">Sub-pages</h3>
                {page.children.map((c) => (
                  <Link key={c.id} to={`/knowledge/${c.id}`} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted">
                    {c.icon ? <span aria-hidden="true">{c.icon}</span> : <Icon name="file" size={16} className="text-muted-foreground" />} {c.title}
                  </Link>
                ))}
              </nav>
            )}
          </CardContent>
        </Card>
      )}
      {!editing && <PageComments pageId={page.id} canModerate={page.can_edit} onChange={reload} />}
      <PublishPanel open={sharing} onClose={() => setSharing(false)} pageId={page.id} isPublic={page.public} url={page.public_url} onChange={reload} />

      {showVersions && (
        <Panel title="Version history">
          <ol className="flex flex-col divide-y text-sm">
            {page.versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center gap-2 py-2">
                <Button variant="link" size="inline" onClick={async () => setVersion(await api.get(`/pages/${page.id}/versions/${v.version}`))}>
                  Version {v.version}
                </Button>
                <span className="text-muted-foreground">
                  · {v.edited_by_name} · {dateTime(v.created_at)}
                </span>
              </li>
            ))}
          </ol>
        </Panel>
      )}

      {page.can_edit && !editing && (
        <Panel
          title="Page settings"
          footer={
            (page.owner?.id === me!.user.id || me!.role === 'admin' || me!.role === 'owner') && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={async () => {
                  await act(() => api.post(`/pages/${page.id}/archive`, { archived: !page.archived_at }), page.archived_at ? 'Page restored' : 'Page archived');
                  page.archived_at ? reload() : navigate('/knowledge');
                }}
              >
                {page.archived_at ? 'Restore page' : 'Archive page'}
              </Button>
            )
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Status">
              <NativeSelect
                value={page.status}
                onChange={async (e) => {
                  await act(() => api.patch(`/pages/${page.id}`, { status: e.target.value }), e.target.value === 'approved' ? 'Page approved' : 'Marked as draft');
                  reload();
                }}
              >
                <NativeSelectOption value="draft">Draft</NativeSelectOption>
                <NativeSelectOption value="approved">Approved</NativeSelectOption>
              </NativeSelect>
            </FormField>
            <FormField label="Review date" hint="The owner is reminded on Home when it is due.">
              <DatePicker
                value={page.review_date}
                placeholder="No review date"
                onChange={async (v) => {
                  await act(() => api.patch(`/pages/${page.id}`, { reviewDate: v }));
                  reload();
                }}
              />
            </FormField>
            <FormField label="Inside" hint="Nest this page under another.">
              <NativeSelect
                value={page.parent_id ?? ''}
                onChange={async (e) => {
                  await act(() => api.patch(`/pages/${page.id}`, { parentId: e.target.value || null }), 'Page moved');
                  reload();
                }}
              >
                <NativeSelectOption value="">Top level</NativeSelectOption>
                {(allPages ?? [])
                  .filter((p) => !descendants.has(p.id))
                  .map((p) => (
                    <NativeSelectOption key={p.id} value={p.id}>
                      {p.title}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
            </FormField>
            <FormField label="Owner">
              <NativeSelect
                value={page.owner?.id ?? ''}
                onChange={async (e) => {
                  await act(() => api.patch(`/pages/${page.id}`, { ownerId: e.target.value }), 'Owner changed');
                  reload();
                }}
              >
                {people
                  .filter((p) => p.role !== 'guest')
                  .map((p) => (
                    <NativeSelectOption key={p.id} value={p.id}>
                      {p.name}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
            </FormField>
          </div>
        </Panel>
      )}

      {page.discussions.length > 0 && (
        <Panel title="Related discussions" contentClassName="flex flex-col gap-1">
          {page.discussions.map((d) => (
            <Link key={d.id} to={`/channels/${d.channel_id}?message=${d.id}`} className="-mx-2 flex items-start gap-3 rounded-xl p-2 hover:bg-muted/60">
              <Icon name="chat" size={16} className="mt-0.5 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col text-sm">
                <strong className="font-medium">
                  {d.user_name} in #{d.channel_name}
                </strong>
                <span className="line-clamp-2 text-xs text-muted-foreground">{plainMentions(d.body).slice(0, 160)}</span>
              </span>
              <span className="text-xs text-muted-foreground">{timeAgo(d.created_at)}</span>
            </Link>
          ))}
        </Panel>
      )}

      <Modal open={!!version} onClose={() => setVersion(null)} title={version ? `Version ${version.version}: ${version.title}` : ''} wide>
        {version && (
          <div className="flex flex-col gap-4">
            <Markdown text={version.body} />
            {page.can_edit && version.version !== page.version && (
              <div className="flex justify-end">
                <Button
                  onClick={async () => {
                    await act(() => api.post(`/pages/${page.id}/restore-version`, { version: version.version }), 'Version restored');
                    setVersion(null);
                    reload();
                  }}
                >
                  Restore this version
                </Button>
              </div>
            )}
          </div>
        )}
      </Modal>
    </Page>
  );
}

interface FileFull extends FileSummary {
  versions: { version: number; mime: string; size: number; created_at: string; uploaded_by_name: string }[];
  project: { id: string; name: string } | null;
  channel: { id: string; name: string; kind: string } | null;
  task: { id: string; title: string } | null;
  can_edit: boolean;
}

export function FileView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const act = useAction();
  const confirm = useConfirm();
  const { me, can } = useSession();
  const { data: file, error, reload } = useApi<FileFull>(`/files/${id}`);
  const input = useRef<HTMLInputElement>(null);
  const { data: projects } = useApi<Project[]>('/projects');
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!file) return <Loading />;
  const previewable = !file.external_url && file.mime && (file.mime.startsWith('image/') || file.mime.startsWith('text/') || isPlayable(file.mime));
  const src = `/api/files/${file.id}/download?inline=1`;
  return (
    <Page width="narrow">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link to="/files" />}>Files</BreadcrumbLink>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <Card>
        <CardContent className="flex flex-wrap items-start gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-info-soft text-info">
            <Icon name={file.external_url ? 'link' : 'file'} size={22} />
          </span>
          <div className="flex min-w-0 flex-1 basis-60 flex-col gap-1.5">
            <h1 className="font-heading text-2xl font-semibold tracking-tight break-words">{file.name}</h1>
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <Avatar user={file.owner} size="xs" /> {file.owner?.name} · {file.external_url ? 'External link' : `version ${file.version} · ${bytes(file.size)}`} · updated{' '}
              {timeAgo(file.updated_at)}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {file.project && (
                <Badge variant="outline" render={<Link to={`/projects/${file.project.id}?tab=resources`} />}>
                  <Icon name="folder" /> {file.project.name}
                </Badge>
              )}
              {file.channel && (
                <Badge variant="outline" render={<Link to={`/channels/${file.channel.id}`} />}>
                  <Icon name="hash" /> {file.channel.kind === 'dm' ? 'Direct message' : file.channel.name}
                </Badge>
              )}
              {file.task && (
                <Badge variant="outline" render={<Link to={`/tasks/${file.task.id}`} />}>
                  <Icon name="task" /> {file.task.title}
                </Badge>
              )}
            </div>
          </div>
          {file.external_url ? (
            <a href={file.external_url} target="_blank" rel="noopener noreferrer" className={buttonVariants()}>
              <Icon name="link" data-icon="inline-start" />
              Open link
            </a>
          ) : (
            <a href={`/api/files/${file.id}/download`} className={buttonVariants()}>
              <Icon name="download" data-icon="inline-start" />
              Download
            </a>
          )}
        </CardContent>
        {previewable && (
          <CardFooter className="justify-center border-t bg-muted/40 pt-4">
            {file.mime!.startsWith('image/') ? (
              <img src={src} alt={file.name} className="max-h-[70vh] max-w-full rounded-lg object-contain" />
            ) : isPlayable(file.mime) ? (
              <MediaAttachment file={file} />
            ) : (
              <iframe src={src} title={`Preview of ${file.name}`} sandbox="" className="h-[60vh] w-full rounded-lg border bg-background" />
            )}
          </CardFooter>
        )}
      </Card>
      {!file.external_url && (
        <Panel
          title="Versions"
          action={
            file.can_edit && (
              <>
                <Button variant="outline" size="sm" onClick={() => input.current?.click()}>
                  <Icon name="upload" data-icon="inline-start" /> Upload new version
                </Button>
                <input
                  ref={input}
                  type="file"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const form = new FormData();
                    form.append('file', f);
                    await act(() => api.upload(`/files/${file.id}/versions`, form), 'New version uploaded');
                    e.target.value = '';
                    reload();
                  }}
                />
              </>
            )
          }
        >
          <ol className="flex flex-col divide-y text-sm">
            {file.versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center gap-2 py-2">
                <a className="font-medium text-primary hover:underline" href={`/api/files/${file.id}/download?version=${v.version}`}>
                  Version {v.version}
                </a>
                <span className="text-muted-foreground">
                  · {bytes(v.size)} · {v.uploaded_by_name} · {dateTime(v.created_at)}
                </span>
              </li>
            ))}
          </ol>
        </Panel>
      )}
      {file.can_edit && (
        <Panel
          title="File settings"
          footer={
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  await act(() => api.post(`/files/${file.id}/archive`, { archived: !file.archived_at }), file.archived_at ? 'File restored' : 'File archived');
                  file.archived_at ? reload() : navigate('/files');
                }}
              >
                {file.archived_at ? 'Restore file' : 'Archive file'}
              </Button>
              {!file.external_url && (file.owner?.id === me?.user.id || can('admin')) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Delete “${file.name}”?`,
                      description: `This deletes the file and all ${file.versions.length} version${file.versions.length === 1 ? '' : 's'} permanently, freeing their storage. Archiving keeps it (and its storage) instead.`,
                      confirmLabel: 'Delete permanently',
                      destructive: true,
                    });
                    if (ok && (await act(() => api.del(`/files/${file.id}`), 'File deleted'))) navigate('/files');
                  }}
                >
                  <Icon name="trash" data-icon="inline-start" /> Delete file
                </Button>
              )}
            </div>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Label">
              <Input
                defaultValue={file.label}
                placeholder="e.g. Final, Contract, Brand"
                onBlur={async (e) => {
                  if (e.target.value === file.label) return;
                  await act(() => api.patch(`/files/${file.id}`, { label: e.target.value }), 'Label saved');
                  reload();
                }}
              />
            </FormField>
            <FormField label="Project">
              <NativeSelect
                value={file.project_id ?? ''}
                onChange={async (e) => {
                  await act(() => api.patch(`/files/${file.id}`, { projectId: e.target.value || null }), 'File moved');
                  reload();
                }}
              >
                <NativeSelectOption value="">No project</NativeSelectOption>
                {(projects ?? []).map((p) => (
                  <NativeSelectOption key={p.id} value={p.id}>
                    {p.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormField>
          </div>
        </Panel>
      )}
    </Page>
  );
}
