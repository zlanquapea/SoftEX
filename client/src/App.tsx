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
import { Requests } from './pages/Requests';
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
  [/^\/settings/, 'Settings'],
  [/^\/admin/, 'Administration'],
  [/^\/help/, 'Help'],
];

export function App() {
  const { me, loading } = useSession();
  const location = useLocation();

  useEffect(() => {
    const title = TITLES.find(([re]) => re.test(location.pathname))?.[1];
    document.title = title ? `${title} · SoftEX` : 'SoftEX';
  }, [location.pathname]);

  if (loading) return <Loading label="Starting SoftEX" />;

  if (!me) {
    return (
      <Routes>
        <Route path="/register" element={<Register />} />
        <Route path="/invite/:token" element={<AcceptInvite />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password/:token" element={<ResetPassword />} />
        <Route path="*" element={<Login />} />
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
