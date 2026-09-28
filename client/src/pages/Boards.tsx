import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Project } from '../api';
import { useLiveDoc } from '../collab';
import { FavoriteButton } from '../components/Favorites';
import { Icon } from '../components/Icon';
import { PeerList } from '../components/LiveEditor';
import { Whiteboard } from '../components/Whiteboard';
import { Empty, ErrorState, Field, Loading, Modal, useAction } from '../components/ui';
import { timeAgo } from '../format';
import { useApi } from '../hooks';
import { useSession } from '../session';

interface Board {
  id: string;
  title: string;
  project: { id: string; name: string; color: string } | null;
  owner: { id: string; name: string } | null;
  can_edit: boolean;
  can_delete: boolean;
  updated_at: string;
  archived_at: string | null;
}

export function NewBoardButton({ projectId, className = 'btn primary' }: { projectId?: string; className?: string }) {
  const act = useAction();
  const navigate = useNavigate();
  const { data: projects } = useApi<Project[]>(projectId ? null : '/projects');
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [project, setProject] = useState(projectId ?? '');
  return (
    <>
      <button className={className} onClick={() => setOpen(true)}>
        <Icon name="plus" size={16} /> New whiteboard
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="New whiteboard">
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const b = await act(() => api.post<Board>('/boards', { title, projectId: project || null }));
            if (b) navigate(`/boards/${b.id}`);
          }}
        >
          <Field label="Name">
            <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} placeholder="Q4 planning workshop" autoFocus />
          </Field>
          {!projectId && (
            <Field label="Project" hint="Project whiteboards are shared with the project; others with everyone in the workspace.">
              <select value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">No project (whole workspace)</option>
                {(projects ?? [])
                  .filter((p) => !p.archived_at)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn primary" disabled={!title.trim()}>
              Create
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/** Whiteboards for brainstorming, workshops and planning (Miro, FigJam, Teams Whiteboard). */
export function Boards({ projectId }: { projectId?: string }) {
  const [archived, setArchived] = useState(false);
  const { data, error, reload } = useApi<Board[]>(`/boards?archived=${archived}${projectId ? `&projectId=${projectId}` : ''}`);
  const { me } = useSession();
  const body = error ? (
    <ErrorState error={error} retry={reload} />
  ) : !data ? (
    <Loading />
  ) : !data.length ? (
    <Empty icon="whiteboard" title={archived ? 'No archived whiteboards' : 'No whiteboards yet'}>
      {!archived && 'Brainstorm with sticky notes, sketch a process, or plan a workshop together — everyone edits at once.'}
    </Empty>
  ) : (
    <div className="card-list">
      {data.map((b) => (
        <Link key={b.id} to={`/boards/${b.id}`} className="card pad dash-card">
          <div className="row-gap">
            <Icon name="whiteboard" size={18} />
            <strong className="grow">{b.title}</strong>
          </div>
          <small className="muted">
            {b.project ? (
              <>
                <span className={`project-dot bg-${b.project.color}`} /> {b.project.name} ·{' '}
              </>
            ) : null}
            {b.owner?.name} · updated {timeAgo(b.updated_at)}
          </small>
        </Link>
      ))}
    </div>
  );
  if (projectId) {
    return (
      <div>
        <div className="toolbar">
          <p className="muted grow">Whiteboards shared with this project.</p>
          <NewBoardButton projectId={projectId} className="btn primary sm" />
        </div>
        {body}
      </div>
    );
  }
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Whiteboards</h1>
          <p className="muted">Sticky notes, shapes, arrows and sketches on an endless canvas that your team edits together, live.</p>
        </div>
        {me!.role !== 'guest' && <NewBoardButton />}
      </div>
      <div className="toolbar">
        <label className="check-inline">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived
        </label>
      </div>
      {body}
    </div>
  );
}

export function BoardView() {
  const { id } = useParams();
  const act = useAction();
  const navigate = useNavigate();
  const { data: board, error, reload, setData } = useApi<Board>(`/boards/${id}`);
  const live = useLiveDoc('board', board?.id);
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!board) return <Loading />;
  return (
    <div className="board-page">
      <div className="board-head">
        <Link to={board.project ? `/projects/${board.project.id}?tab=boards` : '/boards'} className="icon-btn" aria-label="Back to whiteboards">
          <Icon name="chevronLeft" />
        </Link>
        {board.can_edit ? (
          <input
            className="board-title"
            defaultValue={board.title}
            key={board.title}
            aria-label="Whiteboard name"
            maxLength={120}
            onBlur={async (e) => {
              const title = e.target.value.trim();
              if (!title || title === board.title) return;
              const b = await act(() => api.patch<Board>(`/boards/${board.id}`, { title }));
              if (b) setData(b);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <h1 className="board-title">{board.title}</h1>
        )}
        <FavoriteButton kind="board" id={board.id} />
        {board.project && (
          <Link to={`/projects/${board.project.id}`} className="pill hide-mobile">
            <span className={`project-dot bg-${board.project.color}`} /> {board.project.name}
          </Link>
        )}
        {!board.can_edit && <span className="pill">View only</span>}
        <span className="grow" />
        {live && <PeerList peers={[...live.peers.values()]} label="Here now" />}
        {live && live.status === 'offline' && <span className="pill status-blocked">Offline</span>}
        {board.can_delete && (
          <button
            className="icon-btn"
            aria-label={board.archived_at ? 'Restore whiteboard' : 'Archive whiteboard'}
            title={board.archived_at ? 'Restore' : 'Archive'}
            onClick={async () => {
              const b = await act(() => api.patch<Board>(`/boards/${board.id}`, { archived: !board.archived_at }), board.archived_at ? 'Whiteboard restored' : 'Whiteboard archived');
              if (b && !board.archived_at) navigate('/boards');
              else if (b) setData(b);
            }}
          >
            <Icon name="flag" size={16} />
          </button>
        )}
      </div>
      {!live || !live.ready ? <Loading label="Opening the whiteboard" /> : <Whiteboard live={live} title={board.title} />}
    </div>
  );
}
