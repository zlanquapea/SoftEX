import { useEffect, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { usePublicPricing, type PublicPricing } from '../pages/Pricing';
import { useSession } from '../session';

/** Name shown as the business behind the service (falls back to the product name). */
export const companyName = (info?: PublicPricing) => info?.company.name ?? 'SoftEX';

export function PublicHeader() {
  const { me } = useSession();
  return (
    <header className="public-head">
      <Link to="/" className="brand dark" aria-label="SoftEX home">
        <span className="brand-mark">S</span>
        <span>SoftEX</span>
      </Link>
      <nav className="public-nav" aria-label="Website">
        <a href="/#features">Features</a>
        <NavLink to="/pricing">Pricing</NavLink>
        <a href="/#faq">FAQ</a>
      </nav>
      <span className="grow" />
      {me ? (
        <Link className="btn primary sm" to="/">
          Open SoftEX
        </Link>
      ) : (
        <>
          <Link to="/login" className="public-signin">
            Sign in
          </Link>
          <Link className="btn primary sm" to="/register">
            Start free trial
          </Link>
        </>
      )}
    </header>
  );
}

export function PublicFooter() {
  const { data } = usePublicPricing();
  const contact = data?.support_email ?? data?.company.email;
  return (
    <footer className="public-foot">
      <div className="public-foot-grid">
        <div>
          <div className="brand dark">
            <span className="brand-mark">S</span>
            <span>SoftEX</span>
          </div>
          <p className="muted small">One calm workspace for your team’s conversations, projects, knowledge and meetings.</p>
        </div>
        <div>
          <h4>Product</h4>
          <a href="/#features">Features</a>
          <Link to="/pricing">Pricing</Link>
          <Link to="/register">Start free trial</Link>
          <Link to="/login">Sign in</Link>
        </div>
        <div>
          <h4>Company</h4>
          {contact && <a href={`mailto:${contact}`}>Contact us</a>}
          <Link to="/terms">Terms of Service</Link>
          <Link to="/privacy">Privacy Policy</Link>
        </div>
      </div>
      <p className="muted small public-copy">
        © {new Date().getFullYear()} {companyName(data)}
        {data?.company.address ? ` · ${data.company.address}` : ''}
      </p>
    </footer>
  );
}

/** Frame for the public website pages: header, content, footer, and a page title. */
export function PublicPage({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = title;
  }, [title]);
  return (
    <div className="public-site">
      <div className="public-page">
        <PublicHeader />
        {children}
      </div>
      <PublicFooter />
    </div>
  );
}
