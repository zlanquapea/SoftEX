import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { Layout } from './components/Layout';
import { TaskDetail } from './components/TaskDrawer';
import { Loading } from './components/ui';
import { AcceptInvite, ForgotPassword, Login, MfaSetup, Register, ResetPassword } from './pages/Auth';
import { Admin } from './pages/Admin';
import { ChannelView, ChannelsBrowser, Chats } from './pages/Chats';
import { Decisions } from './pages/Decisions';
import { Directory, PersonView } from './pages/Directory';
import { Help } from './pages/Help';
import { Home } from './pages/Home';
import { Inbox } from './pages/Inbox';
import { FileView, Knowledge, PageView } from './pages/Knowledge';
import { MeetingDetail, Meetings } from './pages/Meetings';
import { MyWork } from './pages/MyWork';
import { ProjectDetail, Projects } from './pages/Projects';
import { Later, Workload } from './pages/Planning';
import { Requests } from './pages/Requests';
import { Pricing, VerifyEmail, usePublicPricing } from './pages/Pricing';
import { Landing } from './pages/Landing';
import { Privacy, Terms } from './pages/Legal';
import { Operator } from './pages/Operator';
import { Settings } from './pages/Settings';
import { useSession } from './session';

function TaskPage() {
  const { id } = useParams();
  return (
    <div className="page narrow">
      <TaskDetail taskId={id!} key={id} onDeleted={() => history.back()} />
    </div>
  );
}

const TITLES: [RegExp, string][] = [
  [/^\/$/, 'Home'],
  [/^\/inbox/, 'Inbox'],
  [/^\/chats/, 'Chats'],
  [/^\/channels/, 'Channels'],
  [/^\/my-work/, 'My work'],
  [/^\/projects/, 'Projects'],
  [/^\/tasks/, 'Task'],
  [/^\/knowledge|^\/files/, 'Knowledge'],
  [/^\/meetings/, 'Meetings'],
  [/^\/directory|^\/people/, 'Directory'],
  [/^\/decisions/, 'Decisions'],
  [/^\/requests/, 'Requests'],
  [/^\/workload/, 'Workload'],
  [/^\/later/, 'Later'],
  [/^\/pricing/, 'Pricing'],
  [/^\/operator/, 'Operator console'],
  [/^\/settings/, 'Settings'],
  [/^\/admin/, 'Administration'],
  [/^\/help/, 'Help'],
];

/** Signed-out visitors to "/" see the product website on hosted servers, and the sign-in page otherwise. */
function PublicHome() {
  const { data, error } = usePublicPricing();
  if (error) return <Login />;
  if (!data) return <Loading />;
  return data.mode === 'saas' ? <Landing /> : <Login />;
}

export function App() {
  const { me, loading } = useSession();
  const location = useLocation();

  useEffect(() => {
    const title = TITLES.find(([re]) => re.test(location.pathname))?.[1];
    document.title = title ? `${title} · Küü` : 'Küü';
  }, [location.pathname]);

  if (loading) return <Loading label="Starting Küü" />;

  if (!me) {
    return (
      <Routes>
        <Route path="/register" element={<Register />} />
        <Route path="/invite/:token" element={<AcceptInvite />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password/:token" element={<ResetPassword />} />
        <Route path="/verify-email/:token" element={<VerifyEmail />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<PublicHome />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  // Pages that stand on their own even when signed in.
  if (/^\/(verify-email\/|terms$|privacy$)/.test(location.pathname)) {
    return (
      <Routes>
        <Route path="/verify-email/:token" element={<VerifyEmail />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/privacy" element={<Privacy />} />
      </Routes>
    );
  }
  if (me.mfa_setup_required) return <MfaSetup required />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/chats" element={<Chats />} />
        <Route path="/channels" element={<ChannelsBrowser />} />
        <Route path="/channels/:id" element={<ChannelView />} />
        <Route path="/my-work" element={<MyWork />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/tasks/:id" element={<TaskPage />} />
        <Route path="/knowledge" element={<Knowledge />} />
        <Route path="/knowledge/:id" element={<PageView />} />
        <Route path="/files/:id" element={<FileView />} />
        <Route path="/meetings" element={<Meetings />} />
        <Route path="/meetings/:id" element={<MeetingDetail />} />
        <Route path="/directory" element={<Directory />} />
        <Route path="/people/:id" element={<PersonView />} />
        <Route path="/decisions" element={<Decisions />} />
        <Route path="/requests" element={<Requests />} />
        <Route path="/workload" element={<Workload />} />
        <Route path="/later" element={<Later />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/operator" element={<Operator />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/help" element={<Help />} />
        <Route path="/invite/:token" element={<AcceptInvite />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/register" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
