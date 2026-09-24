import { useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs, type Project } from '../api';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { useShell } from '../components/Layout';
import { Markdown } from '../components/Markdown';
import { Empty, ErrorState, Field, Loading, Modal, Tabs, useAction } from '../components/ui';
import { bytes, dateTime, plainMentions, timeAgo } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';

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
  const tab = (params.get('tab') as 'pages' | 'files') ?? 'pages';
  const { openCreate } = useShell();
  const { me } = useSession();
  const act = useAction();
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState<'all' | 'approved' | 'draft' | 'review'>('all');
  const [archived, setArchived] = useState(false);
  const pages = useApi<PageSummary[]>(tab === 'pages' ? `/pages${qs({ archived: archived ? 'true' : undefined })}` : null);
  const files = useApi<FileSummary[]>(tab === 'files' ? `/files${qs({ archived: archived ? 'true' : undefined })}` : null);
  const upload = useRef<HTMLInputElement>(null);
  const [linking, setLinking] = useState(false);
  const [link, setLink] = useState({ name: '', url: '' });

  const pageList = (pages.data ?? []).filter(
    (p) =>
      (!filter || `${p.title} ${p.excerpt}`.toLowerCase().includes(filter.toLowerCase())) &&
      (status === 'all' || (status === 'review' ? p.needs_review : p.status === status)),
  );
  const fileList = (files.data ?? []).filter((f) => !filter || `${f.name} ${f.label}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Knowledge</h1>
          <p className="muted">Policies, how-tos, decisions and files — with owners and review dates so they stay trustworthy.</p>
        </div>
        {me!.role !== 'guest' && (
          <div className="row-gap">
            {tab === 'files' ? (
              <>
                <button className="btn" onClick={() => setLinking(true)}>
                  <Icon name="link" size={16} /> Link file
                </button>
                <button className="btn primary" onClick={() => upload.current?.click()}>
                  <Icon name="upload" size={16} /> Upload
                </button>
                <input
                  ref={upload}
                  type="file"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const form = new FormData();
                    form.append('file', f);
                    await act(() => api.upload('/files', form), 'File uploaded');
                    e.target.value = '';
                    files.reload();
                  }}
                />
              </>
            ) : (
              <button className="btn primary" onClick={() => openCreate('page')}>
                <Icon name="plus" size={16} /> New page
              </button>
            )}
          </div>
        )}
      </div>
      <Tabs value={tab} onChange={(t) => setParams(t === 'pages' ? {} : { tab: t })} tabs={[{ id: 'pages', label: 'Pages' }, { id: 'files', label: 'Files' }]} />
      <div className="toolbar">
        <input className="filter" placeholder={`Filter ${tab}`} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter" />
        {tab === 'pages' && (
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status">
            <option value="all">All pages</option>
            <option value="approved">Approved</option>
            <option value="draft">Drafts</option>
            <option value="review">Due for review</option>
          </select>
        )}
        <label className="check-inline">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived
        </label>
      </div>

      {tab === 'pages' && (
        <>
          {pages.error && <ErrorState error={pages.error} retry={pages.reload} />}
          {!pages.data && !pages.error && <Loading />}
          {pages.data && !pageList.length && (
            <Empty icon="book" title="No pages yet">
              Capture how your team works: policies, onboarding guides, runbooks.
            </Empty>
          )}
          <div className="page-grid">
            {pageList.map((p) => (
              <Link key={p.id} to={`/knowledge/${p.id}`} className="page-card">
                <div className="row-gap">
                  <Icon name="book" />
                  {p.status === 'approved' ? <span className="pill status-done">Approved</span> : <span className="pill">Draft</span>}
                  {p.needs_review && <span className="pill status-blocked">Review due</span>}
                </div>
                <h3>{p.title}</h3>
                <p className="muted">{p.excerpt || 'Empty page'}</p>
                <small className="muted">
                  {p.project_name ? `${p.project_name} · ` : ''}
                  {p.owner?.name} · updated {timeAgo(p.updated_at)}
                </small>
              </Link>
            ))}
          </div>
        </>
      )}

      {tab === 'files' && (
        <>
          {files.error && <ErrorState error={files.error} retry={files.reload} />}
          {!files.data && !files.error && <Loading />}
          {files.data && !fileList.length && <Empty icon="file" title="No files here" />}
          {fileList.length > 0 && (
            <table className="table card">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="hide-mobile">Owner</th>
                  <th className="hide-mobile">Size</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {fileList.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <Link to={`/files/${f.id}`} className="row-gap">
                        <Icon name={f.external_url ? 'link' : 'file'} size={16} /> {f.name}
                      </Link>
                      {f.label && <span className="pill">{f.label}</span>}
                    </td>
                    <td className="hide-mobile">{f.owner?.name}</td>
                    <td className="hide-mobile">{f.external_url ? 'Link' : `${bytes(f.size)} · v${f.version}`}</td>
                    <td>{timeAgo(f.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <Modal open={linking} onClose={() => setLinking(false)} title="Link an external file">
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await act(() => api.post('/files/link', link), 'Link added');
            if (ok) {
              setLinking(false);
              setLink({ name: '', url: '' });
              files.reload();
            }
          }}
        >
          <Field label="Name">
            <input required value={link.name} onChange={(e) => setLink({ ...link, name: e.target.value })} />
          </Field>
          <Field label="URL">
            <input required type="url" value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} placeholder="https://…" />
          </Field>
          <div className="form-actions">
            <button className="btn primary">Add link</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

interface PageFull extends PageSummary {
  body: string;
  project: { id: string; name: string; color: string } | null;
  versions: { version: number; title: string; created_at: string; edited_by_name: string }[];
  discussions: { id: string; body: string; created_at: string; channel_id: string; channel_name: string; user_name: string }[];
  can_edit: boolean;
  archived_at: string | null;
}

export function PageView() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { me, people } = useSession();
  const act = useAction();
  const { data: page, error, reload } = useApi<PageFull>(`/pages/${id}`);
  const editing = params.get('edit') === '1';
  const [draft, setDraft] = useState<{ title: string; body: string } | null>(null);
  const [preview, setPreview] = useState(false);
  const [version, setVersion] = useState<{ version: number; title: string; body: string } | null>(null);
  const [showVersions, setShowVersions] = useState(false);

  if (error) return <ErrorState error={error} retry={reload} />;
  if (!page) return <Loading />;
  const current = draft ?? { title: page.title, body: page.body };

  const save = async () => {
    const ok = await act(() => api.patch(`/pages/${page.id}`, current), 'Page saved');
    if (ok) {
      setDraft(null);
      setParams({});
      reload();
    }
  };
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
    <div className="page narrow">
      <div className="crumbs">
        <Link to="/knowledge">Knowledge</Link>
        {page.project && (
          <>
            {' / '}
            <Link to={`/projects/${page.project.id}?tab=resources`}>{page.project.name}</Link>
          </>
        )}
      </div>
      {editing ? (
        <div className="editor card">
          <input className="title-input" value={current.title} onChange={(e) => setDraft({ ...current, title: e.target.value })} aria-label="Page title" />
          <div className="segmented" role="group">
            <button className={!preview ? 'active' : ''} onClick={() => setPreview(false)}>
              Write
            </button>
            <button className={preview ? 'active' : ''} onClick={() => setPreview(true)}>
              Preview
            </button>
          </div>
          {preview ? (
            <Markdown text={current.body} />
          ) : (
            <textarea
              className="page-editor"
              value={current.body}
              onChange={(e) => setDraft({ ...current, body: e.target.value })}
              rows={20}
              aria-label="Page content"
              placeholder={'# Heading\n\nWrite with **Markdown**. Link tasks and discussions by pasting their SoftEX links.\n\n- [ ] Checklists work too'}
            />
          )}
          <div className="form-actions">
            <button
              className="btn"
              onClick={() => {
                setDraft(null);
                setParams({});
              }}
            >
              Cancel
            </button>
            <button className="btn primary" onClick={save}>
              Save version {page.version + (draft ? 1 : 0)}
            </button>
          </div>
        </div>
      ) : (
        <article className="card doc">
          <div className="doc-head">
            <div className="row-gap wrap">
              {page.status === 'approved' ? <span className="pill status-done">Approved</span> : <span className="pill">Draft</span>}
              {page.needs_review && <span className="pill status-blocked">Review due</span>}
              {page.archived_at && <span className="pill">Archived</span>}
            </div>
            <h1>{page.title}</h1>
            <p className="muted small">
              Owner <strong>{page.owner?.name}</strong> · version {page.version} · updated {timeAgo(page.updated_at)} by {page.updated_by?.name}
              {page.review_date && ` · review by ${new Date(`${page.review_date}T00:00`).toLocaleDateString()}`}
            </p>
            <div className="row-gap wrap">
              {page.can_edit && (
                <button className="btn sm" onClick={() => setParams({ edit: '1' })}>
                  <Icon name="edit" size={14} /> Edit
                </button>
              )}
              <button className="btn sm" onClick={() => setShowVersions((v) => !v)}>
                <Icon name="clock" size={14} /> History ({page.versions.length})
              </button>
              {page.owner && page.owner.id !== me!.user.id && (
                <button className="btn sm" onClick={askOwner}>
                  <Icon name="chat" size={14} /> Ask the owner
                </button>
              )}
            </div>
          </div>
          {page.body ? <Markdown text={page.body} /> : <p className="muted">This page is empty.</p>}
        </article>
      )}

      {showVersions && (
        <div className="card">
          <h2>Version history</h2>
          <ul className="timeline">
            {page.versions.map((v) => (
              <li key={v.version}>
                <button className="link-btn" onClick={async () => setVersion(await api.get(`/pages/${page.id}/versions/${v.version}`))}>
                  Version {v.version}
                </button>{' '}
                · {v.edited_by_name} · {dateTime(v.created_at)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {page.can_edit && !editing && (
        <div className="card form">
          <h2>Page settings</h2>
          <div className="form-row">
            <Field label="Status">
              <select
                value={page.status}
                onChange={async (e) => {
                  await act(() => api.patch(`/pages/${page.id}`, { status: e.target.value }), e.target.value === 'approved' ? 'Page approved' : 'Marked as draft');
                  reload();
                }}
              >
                <option value="draft">Draft</option>
                <option value="approved">Approved</option>
              </select>
            </Field>
            <Field label="Review date" hint="The owner is reminded on Home when it is due.">
              <input
                type="date"
                value={page.review_date ?? ''}
                onChange={async (e) => {
                  await act(() => api.patch(`/pages/${page.id}`, { reviewDate: e.target.value || null }));
                  reload();
                }}
              />
            </Field>
            <Field label="Owner">
              <select
                value={page.owner?.id ?? ''}
                onChange={async (e) => {
                  await act(() => api.patch(`/pages/${page.id}`, { ownerId: e.target.value }), 'Owner changed');
                  reload();
                }}
              >
                {people
                  .filter((p) => p.role !== 'guest')
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          {(page.owner?.id === me!.user.id || me!.role === 'admin' || me!.role === 'owner') && (
            <button
              className="btn sm danger-text"
              onClick={async () => {
                await act(() => api.post(`/pages/${page.id}/archive`, { archived: !page.archived_at }), page.archived_at ? 'Page restored' : 'Page archived');
                page.archived_at ? reload() : navigate('/knowledge');
              }}
            >
              {page.archived_at ? 'Restore page' : 'Archive page'}
            </button>
          )}
        </div>
      )}

      {page.discussions.length > 0 && (
        <div className="card">
          <h2>Related discussions</h2>
          {page.discussions.map((d) => (
            <Link key={d.id} to={`/channels/${d.channel_id}?message=${d.id}`} className="list-row">
              <Icon name="chat" />
              <span className="grow">
                <strong>
                  {d.user_name} in #{d.channel_name}
                </strong>
                <small className="muted block">{plainMentions(d.body).slice(0, 160)}</small>
              </span>
              <small className="muted">{timeAgo(d.created_at)}</small>
            </Link>
          ))}
        </div>
      )}

      <Modal open={!!version} onClose={() => setVersion(null)} title={version ? `Version ${version.version}: ${version.title}` : ''} wide>
        {version && (
          <>
            <Markdown text={version.body} />
            {page.can_edit && version.version !== page.version && (
              <div className="form-actions">
                <button
                  className="btn primary"
                  onClick={async () => {
                    await act(() => api.post(`/pages/${page.id}/restore-version`, { version: version.version }), 'Version restored');
                    setVersion(null);
                    reload();
                  }}
                >
                  Restore this version
                </button>
              </div>
            )}
          </>
        )}
      </Modal>
    </div>
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
  const { data: file, error, reload } = useApi<FileFull>(`/files/${id}`);
  const input = useRef<HTMLInputElement>(null);
  const { data: projects } = useApi<Project[]>('/projects');
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!file) return <Loading />;
  const previewable = !file.external_url && file.mime && (file.mime.startsWith('image/') || file.mime.startsWith('text/'));
  const src = `/api/files/${file.id}/download?inline=1`;
  return (
    <div className="page narrow">
      <div className="crumbs">
        <Link to="/knowledge?tab=files">Files</Link>
      </div>
      <div className="card">
        <div className="file-head">
          <span className="project-icon lg bg-blue">
            <Icon name={file.external_url ? 'link' : 'file'} size={22} />
          </span>
          <div className="grow">
            <h1>{file.name}</h1>
            <p className="muted small">
              <Avatar user={file.owner} size="xs" /> {file.owner?.name} · {file.external_url ? 'External link' : `version ${file.version} · ${bytes(file.size)}`} · updated{' '}
              {timeAgo(file.updated_at)}
            </p>
            <p className="small">
              {file.project && (
                <Link to={`/projects/${file.project.id}?tab=resources`} className="pill">
                  <Icon name="folder" size={11} /> {file.project.name}
                </Link>
              )}
              {file.channel && (
                <Link to={`/channels/${file.channel.id}`} className="pill">
                  <Icon name="hash" size={11} /> {file.channel.kind === 'dm' ? 'Direct message' : file.channel.name}
                </Link>
              )}
              {file.task && (
                <Link to={`/tasks/${file.task.id}`} className="pill">
                  <Icon name="task" size={11} /> {file.task.title}
                </Link>
              )}
            </p>
          </div>
          <div className="row-gap">
            {file.external_url ? (
              <a className="btn primary" href={file.external_url} target="_blank" rel="noopener noreferrer">
                Open link
              </a>
            ) : (
              <a className="btn primary" href={`/api/files/${file.id}/download`}>
                <Icon name="download" size={16} /> Download
              </a>
            )}
          </div>
        </div>
        {previewable && (
          <div className="file-preview">
            {file.mime!.startsWith('image/') ? <img src={src} alt={file.name} /> : <iframe src={src} title={`Preview of ${file.name}`} sandbox="" />}
          </div>
        )}
      </div>
      {!file.external_url && (
        <div className="card">
          <div className="section-heading compact">
            <h2>Versions</h2>
            {file.can_edit && (
              <>
                <button className="btn sm" onClick={() => input.current?.click()}>
                  <Icon name="upload" size={14} /> Upload new version
                </button>
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
            )}
          </div>
          <ul className="timeline">
            {file.versions.map((v) => (
              <li key={v.version}>
                <a href={`/api/files/${file.id}/download?version=${v.version}`}>Version {v.version}</a> · {bytes(v.size)} · {v.uploaded_by_name} · {dateTime(v.created_at)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {file.can_edit && (
        <div className="card form">
          <h2>File settings</h2>
          <div className="form-row">
            <Field label="Label">
              <input
                defaultValue={file.label}
                placeholder="e.g. Final, Contract, Brand"
                onBlur={async (e) => {
                  if (e.target.value === file.label) return;
                  await act(() => api.patch(`/files/${file.id}`, { label: e.target.value }), 'Label saved');
                  reload();
                }}
              />
            </Field>
            <Field label="Project">
              <select
                value={file.project_id ?? ''}
                onChange={async (e) => {
                  await act(() => api.patch(`/files/${file.id}`, { projectId: e.target.value || null }), 'File moved');
                  reload();
                }}
              >
                <option value="">No project</option>
                {(projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <button
            className="btn sm danger-text"
            onClick={async () => {
              await act(() => api.post(`/files/${file.id}/archive`, { archived: !file.archived_at }), file.archived_at ? 'File restored' : 'File archived');
              file.archived_at ? reload() : navigate('/knowledge?tab=files');
            }}
          >
            {file.archived_at ? 'Restore file' : 'Archive file'}
          </button>
        </div>
      )}
    </div>
  );
}
