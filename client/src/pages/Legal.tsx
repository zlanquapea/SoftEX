import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { PublicPage, companyName } from '../components/Public';
import { usePublicPricing, type PublicPricing } from './Pricing';

/*
 * Starting-point legal documents for a hosted Küü service. They describe how the
 * software actually handles data, but they are not legal advice: the operator must
 * have them reviewed by a lawyer and fill in company details (SOFTEX_COMPANY_NAME,
 * SOFTEX_COMPANY_ADDRESS, SOFTEX_LEGAL_EMAIL) before launch.
 */

const EFFECTIVE = 'September 25, 2026';

function LegalFrame({ title, children }: { title: string; children: (info: PublicPricing | undefined) => ReactNode }) {
  const { data } = usePublicPricing();
  const unconfigured = data && !data.company.name;
  return (
    <PublicPage title={`${title} · Küü`}>
      <article className="legal">
        {unconfigured && (
          <p className="hint-box warn">
            <Icon name="alert" size={15} /> Draft: the service operator hasn’t added company details yet. Set SOFTEX_COMPANY_NAME, SOFTEX_COMPANY_ADDRESS and
            SOFTEX_LEGAL_EMAIL, and have these terms reviewed by a lawyer before accepting customers.
          </p>
        )}
        <p className="eyebrow">LEGAL</p>
        <h1>{title}</h1>
        <p className="muted">
          Effective {EFFECTIVE} · Version {data?.terms_version ?? '—'}
        </p>
        {children(data)}
      </article>
    </PublicPage>
  );
}

const contactOf = (d?: PublicPricing) => d?.company.email ?? d?.support_email ?? null;

function Contact({ info }: { info?: PublicPricing }) {
  const email = contactOf(info);
  return (
    <p>
      {companyName(info)}
      {info?.company.address ? `, ${info.company.address}` : ''}
      {email && (
        <>
          {' · '}
          <a href={`mailto:${email}`}>{email}</a>
        </>
      )}
    </p>
  );
}

export function Terms() {
  return (
    <LegalFrame title="Terms of Service">
      {(info) => {
        const us = companyName(info);
        return (
          <>
            <p>
              These terms are an agreement between you and {us} (“we”, “us”) for the use of Küü, a hosted workspace for team communication, tasks, projects, documents
              and meetings (the “Service”). By creating an account or using the Service you agree to them. If you use the Service for an organisation, you confirm you may
              accept these terms on its behalf, and “you” includes that organisation.
            </p>

            <h2>1. Accounts and workspaces</h2>
            <ul>
              <li>You must give accurate information, confirm your email address and keep your password and authenticator codes secret.</li>
              <li>The person who creates a workspace is its owner. Owners and admins decide who can join, what they can see, and the workspace’s settings.</li>
              <li>You are responsible for activity in your account and workspace. Tell us immediately if you suspect unauthorised access.</li>
              <li>You must be at least 16 years old, or the age of majority where you live if higher, to create an account.</li>
            </ul>

            <h2>2. Plans, trials and payment</h2>
            <ul>
              <li>New workspaces receive a free trial of the Business plan. When it ends, the workspace moves to the Free plan unless you choose a paid plan.</li>
              <li>
                Paid plans are priced per member per month, as shown on the <Link to="/pricing">pricing page</Link> when you pay. Guests are not charged. Prices may change;
                changes apply from your next payment and we will tell you at least 30 days in advance.
              </li>
              <li>
                You pay in advance for the period you choose by mobile money or bank transfer and give us the transaction reference. Your plan starts or extends when we
                confirm the payment. You are responsible for any transfer fees.
              </li>
              <li>
                If a paid period ends without renewal, paid features keep working for a short grace period and then the workspace moves to the Free plan. We do not delete
                content because a plan ended.
              </li>
              <li>Payments are not refundable, except where the law requires it or we cannot provide the Service because of our own fault.</li>
              <li>Plans include usage limits (members, storage and AI requests) described on the pricing page.</li>
            </ul>

            <h2>3. Your content</h2>
            <ul>
              <li>
                You keep all rights to the messages, files, tasks and other content you or your workspace put in the Service (“Customer Content”). You give us permission
                to store, process, back up and display it only as needed to provide, secure and support the Service for you.
              </li>
              <li>Workspace admins can export Customer Content at any time. Owners can delete a workspace, and anyone can delete their own account, from the Service.</li>
              <li>You are responsible for having the right to upload your content, and for complying with laws that apply to it.</li>
            </ul>

            <h2>4. Acceptable use</h2>
            <p>You must not use the Service to:</p>
            <ul>
              <li>break the law, or infringe other people’s rights, including privacy and intellectual property rights;</li>
              <li>send spam, harass or threaten people, or share content that exploits children or promotes violence;</li>
              <li>upload malware, attempt to gain unauthorised access, probe or overload the Service, or get around usage limits or security controls;</li>
              <li>resell the Service without our written agreement.</li>
            </ul>
            <p>
              We may suspend a workspace or account that breaks these rules or puts the Service or other customers at risk. Where we can, we will tell you first and give
              you a chance to fix the problem.
            </p>

            <h2>5. AI features</h2>
            <p>
              Some plans include AI features that summarise or answer questions about content you can already access. AI output can be wrong: check it before relying on
              it. When you use them, the relevant content is sent to our AI provider to generate the response, as described in the <Link to="/privacy">Privacy Policy</Link>
              .
            </p>

            <h2>6. Availability and changes</h2>
            <p>
              We work to keep the Service available and secure, but it is provided “as is” and may occasionally be unavailable for maintenance or reasons outside our
              control. We may improve or change features; if we remove something material from a paid plan, we will tell you in advance.
            </p>

            <h2>7. Liability</h2>
            <p>
              To the extent the law allows, we are not liable for indirect or consequential losses, lost profits or lost data, and our total liability for any claim is
              limited to the amount you paid us for the Service in the 12 months before the claim. Nothing in these terms limits liability that cannot be limited by law.
            </p>

            <h2>8. Ending the agreement</h2>
            <p>
              You can stop using the Service at any time and delete your workspace or account. We may end these terms with 30 days’ notice, or immediately for a serious
              breach. After termination we delete Customer Content as described in the Privacy Policy.
            </p>

            <h2>9. Changes to these terms</h2>
            <p>
              We may update these terms. We will notify workspace owners of material changes at least 30 days before they take effect. Continuing to use the Service after
              that means you accept the new terms.
            </p>

            <h2>10. Governing law</h2>
            <p>These terms are governed by the laws of the Republic of Liberia, and disputes will be handled by the courts of Liberia, unless the law requires otherwise.</p>

            <h2>11. Contact</h2>
            <Contact info={info} />
          </>
        );
      }}
    </LegalFrame>
  );
}

export function Privacy() {
  return (
    <LegalFrame title="Privacy Policy">
      {(info) => {
        const us = companyName(info);
        return (
          <>
            <p>
              This policy explains what personal information {us} (“we”) handles when you use Küü, why, and your choices. For content inside a workspace, the
              organisation that owns the workspace decides how it is used; we process it on their behalf to provide the Service.
            </p>

            <h2>1. Information we handle</h2>
            <ul>
              <li>
                <b>Account details:</b> your name, email address, password (stored only as a secure hash), job title, time zone, working hours, profile colour and
                notification preferences. If you turn on two-step sign-in, a secret for your authenticator app.
              </li>
              <li>
                <b>Workspace content:</b> messages, files, tasks, projects, pages, meeting notes, decisions and other content you and your colleagues add.
              </li>
              <li>
                <b>Usage and security records:</b> sign-in sessions (with the device type and IP address, so you can see where you’re signed in), IP addresses on
                audit events, and records of actions such as invitations, role changes, exports and AI use.
              </li>
              <li>
                <b>Device notifications:</b> if you turn on notifications on a device, the address your browser’s push service gives us for that device. The push
                service (for example Google, Apple, Mozilla or Microsoft) delivers the notification; its content is encrypted so the push service can’t read it.
              </li>
              <li>
                <b>Billing details:</b> the plan chosen, amounts, and the payment reference, payer name and phone number you give us when you pay by mobile money or bank
                transfer. We do not receive or store card numbers or mobile money PINs.
              </li>
              <li>
                <b>Messages to us:</b> what you send when you contact support.
              </li>
            </ul>

            <h2>2. How we use it</h2>
            <ul>
              <li>To provide the Service: show your workspace, deliver messages and notifications, send the emails you or your workspace trigger, and run features you use.</li>
              <li>To keep it secure: authenticate you, prevent abuse, investigate problems and keep audit records.</li>
              <li>To bill: confirm payments, send receipts and reminders about trials and renewals.</li>
              <li>To communicate important changes to the Service, these policies or your account.</li>
            </ul>
            <p>We do not sell personal information, and we do not use workspace content for advertising or to train AI models.</p>

            <h2>3. Who we share it with</h2>
            <ul>
              <li>
                <b>People in your workspace</b>, according to its settings and your role. Workspace admins can see member lists, audit records and exports.
              </li>
              <li>
                <b>Service providers</b> that run the Service for us under contract: our hosting provider (servers and storage), our email delivery provider, your
                browser’s push service when you turn on device notifications and, when a workspace uses AI features, our AI provider (Anthropic), which receives only
                the content needed for the request you make.
              </li>
              <li>
                <b>Authorities</b>, when the law requires it. Where allowed, we will tell the affected workspace first.
              </li>
            </ul>
            <p>Our providers may process data outside Liberia. We choose providers that protect data with appropriate security and contractual safeguards.</p>

            <h2>4. How long we keep it</h2>
            <ul>
              <li>Workspace content is kept until it is deleted by people in the workspace, by a retention policy the workspace sets, or when the workspace is deleted.</li>
              <li>
                When an owner deletes a workspace, its content and files are removed from the Service immediately. We keep daily backups for about a week to recover from
                mistakes and failures; copies in backups are removed as those backups expire.
              </li>
              <li>
                When you delete your account, we erase your name, email address, credentials and personal settings. Messages and work you shared with colleagues stay with
                the workspace, shown as “Deleted user”.
              </li>
              <li>Billing records are kept as long as tax and accounting laws require.</li>
            </ul>

            <h2>5. Your choices and rights</h2>
            <ul>
              <li>Update your profile and notification settings at any time in Settings.</li>
              <li>Export the data you can access from Settings → Security, and ask us for a copy of your personal information.</li>
              <li>Delete your account from Settings → Security, or ask us to correct or delete information about you.</li>
              <li>For content in a workspace, contact the workspace’s owner or admins first, since they control it.</li>
            </ul>

            <h2>6. Security</h2>
            <p>
              We protect data with encrypted connections, hashed passwords and tokens, optional and enforceable two-step sign-in, fine-grained permissions and audit
              logs. No system is perfectly secure; if a breach affects your personal information we will tell you and the relevant authorities as the law requires.
            </p>

            <h2>7. Cookies</h2>
            <p>
              We use one essential cookie to keep you signed in, and your browser stores drafts and recently loaded pages so the app works offline. We do not use
              advertising or cross-site tracking cookies.
            </p>

            <h2>8. Children</h2>
            <p>The Service is not intended for children under 16, and we do not knowingly collect their information.</p>

            <h2>9. Changes</h2>
            <p>We will post updates here and tell workspace owners about material changes before they take effect.</p>

            <h2>10. Contact</h2>
            <Contact info={info} />
          </>
        );
      }}
    </LegalFrame>
  );
}
