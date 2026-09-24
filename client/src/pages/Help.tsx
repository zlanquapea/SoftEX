import { Link } from 'react-router-dom';

export function Help() {
  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>Help</h1>
          <p className="muted">How SoftEX keeps conversation, decisions and delivery connected.</p>
        </div>
      </div>
      <div className="card doc markdown">
        <h3>Everyday workflows</h3>
        <ul>
          <li>
            <strong>Turn a discussion into delivery.</strong> Hover any message and choose the task icon to create a task with one owner and a due date. Use the menu to{' '}
            <em>Record decision</em>. Both stay linked to the original message.
          </li>
          <li>
            <strong>Run a project meeting.</strong> Schedule from a project or channel, add an agenda, start the video link, take notes, and add decisions and follow-up tasks.
            Ending the meeting shares everything with participants.
          </li>
          <li>
            <strong>Find a policy.</strong> Press <kbd>⌘ K</kbd> / <kbd>Ctrl K</kbd> anywhere. Approved pages show first, with their owner and review date. Use <em>Ask the owner</em> to
            start a conversation that links back to the page.
          </li>
          <li>
            <strong>Bring in a partner.</strong> Admins and leads invite guests from <Link to="/admin?tab=invitations">Administration</Link>. Guests only see the channels and projects
            you share, have a sponsor, and their access expires automatically.
          </li>
        </ul>
        <h3>Staying focused</h3>
        <ul>
          <li>Set your status to <em>Focusing</em> from the profile menu, or configure quiet hours in <Link to="/settings">Settings</Link>. Notifications still reach your Inbox, but only urgent ones interrupt you.</li>
          <li>Mute channels or switch them to mentions-only from the channel header.</li>
          <li>Customize Home to hide sections you do not need — urgent assigned work always stays visible.</li>
        </ul>
        <h3>Formatting</h3>
        <p>
          Messages and pages support <code>**bold**</code>, <code>*italic*</code>, <code>`code`</code>, lists, <code>&gt; quotes</code>, <code>[links](https://…)</code> and
          <code>@mentions</code>.
        </p>
        <h3>Privacy</h3>
        <p>Private channels, private projects and their files never appear in search, activity feeds, notifications or exports for people who are not members.</p>
      </div>
    </div>
  );
}
