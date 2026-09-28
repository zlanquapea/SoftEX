import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Logo } from '../components/Logo';
import { Markdown } from '../components/Markdown';
import { Empty, Loading } from '../components/ui';
import { useApi } from '../hooks';

/** A knowledge page published to the web: read-only, no sign-in (/p/:token). */
export function PublishedPage() {
  const { token } = useParams();
  const { data: page, error } = useApi<{ title: string; body: string; icon: string | null; updated_at: string; workspace_name: string }>(`/public/pages/${token}`);
  useEffect(() => {
    if (page) document.title = `${page.title} · ${page.workspace_name}`;
  }, [page]);
  return (
    <div className="public-shell">
      <header className="public-head">
        <Logo height={24} />
        {page && <span className="muted small">{page.workspace_name}</span>}
      </header>
      <main className="public-main">
        {error ? (
          <Empty icon="alert" title="This page isn’t available">It may have been unpublished, or the link changed.</Empty>
        ) : !page ? (
          <Loading />
        ) : (
          <article className="published-page">
            <h1>
              {page.icon && <span className="page-emoji">{page.icon}</span>} {page.title}
            </h1>
            <p className="muted small">Updated {new Date(page.updated_at).toLocaleDateString()}</p>
            <Markdown text={page.body} />
          </article>
        )}
        <p className="muted small public-foot">Published with Küü</p>
      </main>
    </div>
  );
}
