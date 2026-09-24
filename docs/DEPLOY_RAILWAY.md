# Deploying SoftEX on Railway

SoftEX runs on Railway as **one service** built from the repository's `Dockerfile`, with **one volume** for the database and uploaded files. `railway.json` in the repository sets the builder, the health check (`/api/health`) and the restart policy, so there is nothing to configure for the build itself.

Allow about 15 minutes.

## What you need

- A Railway account on a plan that includes volumes (the Hobby plan or higher).
- Access to the `zlanquapea/SoftEX` GitHub repository.
- Optional, for email: SMTP credentials from a provider such as Postmark, Resend, SendGrid, Mailgun or Amazon SES, and a sender address on a domain you control.
- Optional, for AI features: an Anthropic API key.
- Optional: a domain name, if you want `softex.yourcompany.com` instead of a `*.up.railway.app` address.

## 1. Create the service

1. In Railway, click **New Project → Deploy from GitHub repo** and pick `zlanquapea/SoftEX`. If Railway can't see the repository, click **Configure GitHub App** and grant it access.
2. Railway detects `railway.json` and builds with the Dockerfile. The first build takes a few minutes. It is fine if the first deploy fails before the volume and variables exist; you will redeploy in step 4.

## 2. Add a volume

SoftEX keeps its SQLite database and uploads in `/app/server/data`. Without a volume, **everything is lost on every deploy**.

1. Open the service, then **right-click the canvas → Volume** (or press `⌘K` / `Ctrl+K` and choose *Volume*).
2. Attach it to the SoftEX service with the mount path **`/app/server/data`**.

## 3. Generate a public address

In the service, go to **Settings → Networking → Generate Domain**. When Railway asks for the port, enter **`4000`** (the `PORT` variable in step 4 pins it). Railway gives you an address like `softex-production.up.railway.app`.

## 4. Set the variables

In the service, open **Variables → Raw Editor**, paste the following, and fill in the values:

```env
# Required
PORT=4000
SOFTEX_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
SOFTEX_SECURE_COOKIES=true
SOFTEX_TRUST_PROXY=1
SOFTEX_SECRET_KEY=<paste a long random string, see below>
SOFTEX_REGISTRATION=first
RAILWAY_RUN_UID=0

# Email (optional but recommended: invitations, password resets, meeting invites, digests)
SOFTEX_SMTP_URL=smtps://USERNAME:PASSWORD@smtp.yourprovider.com:465
SOFTEX_MAIL_FROM=SoftEX <softex@yourcompany.com>

# AI features (optional; an admin must still switch them on)
ANTHROPIC_API_KEY=<your key>
```

What each one does:

| Variable | Why |
| --- | --- |
| `PORT` | The port SoftEX listens on. It must match the port you gave the domain in step 3. |
| `SOFTEX_PUBLIC_URL` | The address used in email links and as the single sign-on redirect. `${{RAILWAY_PUBLIC_DOMAIN}}` fills in the domain from step 3. If you add your own domain later, change this to `https://softex.yourcompany.com`. |
| `SOFTEX_SECURE_COOKIES` | Sign-in cookies are only sent over HTTPS. Railway serves HTTPS for you. |
| `SOFTEX_TRUST_PROXY` | Railway puts a proxy in front of the app. `1` tells SoftEX to read the visitor's real address from it, so sign-in rate limits and the audit log work per person. |
| `SOFTEX_SECRET_KEY` | Encrypts stored secrets such as the single sign-on client secret. **Keep it safe and never change it** once set, or saved secrets can't be decrypted. |
| `SOFTEX_REGISTRATION` | `first` lets only the first person create a workspace (you, in step 5); after that, people join by invitation. Use this for a private, internal deployment. For a public service where customers sign themselves up, use `open`, but read *Running SoftEX as a public service* below first. `closed` blocks sign-up entirely. |
| `RAILWAY_RUN_UID` | Railway mounts volumes as root, and SoftEX's image runs as an unprivileged user. `0` lets the app write to the volume. If it is missing, the logs say *SoftEX cannot write to its data directory*. |
| `SOFTEX_SMTP_URL`, `SOFTEX_MAIL_FROM` | Without them, emails are kept in **Administration → Email** but not sent. URL-encode special characters in the password (for example `@` → `%40`). Use port 465 with `smtps://`, or port 587 with `smtp://`. |
| `ANTHROPIC_API_KEY` | Makes Ask SoftEX, summaries and task suggestions available. Every workspace's AI use is billed to this key. |

To make a secret key, run this on your computer and paste the output:

```bash
openssl rand -hex 32
```

Click **Deploy** (or **Apply changes**) to redeploy with the volume and variables.

## 5. First sign-in

1. Open your public address. Click **Create a workspace**, and register with your own name, email and a strong password. You become the workspace **owner**.
2. Because `SOFTEX_REGISTRATION=first`, nobody else can create a workspace now. Invite your team from **Administration → Invitations**.
3. Recommended right away, all under **Administration**:
   - **Workspace:** turn on *Require multifactor authentication*, set *Keep messages for* if you have a retention policy, and turn on *AI assistance* if you set an API key.
   - **Email:** send yourself an invitation or password reset and confirm it arrives. Failures and retries are listed here.
   - **Audit log:** find your `auth.login` entry and check the IP address is your own public address, not a private one like `10.x.x.x` or `100.64.x.x`. If it is private, set `SOFTEX_TRUST_PROXY=2` and check again.

Do **not** run the demo seed (`npm run seed`) in production; it creates sample accounts with a published password.

## 6. Optional: your own domain

1. In the service, go to **Settings → Networking → Custom Domain**, and enter e.g. `softex.yourcompany.com`.
2. Add the `CNAME` record Railway shows you at your DNS provider, and wait for the certificate to be issued.
3. Change `SOFTEX_PUBLIC_URL` to `https://softex.yourcompany.com` and redeploy.
4. If you use single sign-on, update the redirect URI at your identity provider. It is shown under **Administration → Single sign-on**.

## 7. Optional: single sign-on and provisioning

- **SSO (Google, Microsoft Entra ID, Okta…):** *Administration → Single sign-on*. Register SoftEX with your provider using the redirect URI shown there. This needs `SOFTEX_SECRET_KEY`.
- **SCIM user provisioning:** *Administration → Provisioning → Generate token*, then give your identity provider the base URL `https://<your domain>/scim/v2` and the token. See [API.md](API.md#scim-20-provisioning).

## 8. Optional: malware scanning

Uploads are always blocked for executable types. To also scan with ClamAV:

1. Add a second service to the project from the Docker image `clamav/clamav:stable`. It needs roughly 2–3 GB of memory for its virus database.
2. On the SoftEX service, set `SOFTEX_CLAMAV_HOST=${{clamav.RAILWAY_PRIVATE_DOMAIN}}` (replace `clamav` with that service's name) and `SOFTEX_CLAMAV_PORT=3310`.

When a scanner is configured and unreachable, uploads are refused rather than accepted unscanned.

## Updating

Railway redeploys automatically when `main` changes, because the service is connected to the GitHub repository. Database changes are applied automatically when the new version starts. Services with a volume restart rather than overlap, so expect a few seconds of downtime per deploy.

## Backups

Your data lives in the volume. If your Railway plan offers volume **Backups** (in the volume's settings), schedule them, and take a manual backup before big changes. People can also export what they can access from **Administration → Workspace → Export data**.

## Running SoftEX as a public service

`SOFTEX_REGISTRATION=open` lets anyone on the internet create a workspace. SoftEX keeps workspaces isolated from each other, but it does not yet have the controls a public service needs:

- **No email verification** at sign-up, so anyone can register with an address they don't own.
- **No usage limits per workspace.** There are no limits on AI use, storage or members. Any workspace admin can switch on AI assistance, and it is billed to your `ANTHROPIC_API_KEY`.
- **No billing, plans or trials.**
- **No way to delete a workspace or an account, and no operator console** for seeing or suspending customer workspaces.
- **One server instance** (see below).

Until those are in place, either keep sign-up at `first` or `closed` and create customer workspaces by invitation, or run with `open` **without** `ANTHROPIC_API_KEY` for a closed beta with people you trust.

## Limits of this setup

- **One instance only.** SQLite on a volume can't be shared between replicas, so keep **Replicas** at 1 (`railway.json` sets this). Scaling out needs the planned move to PostgreSQL and object storage.
- **Real-time updates** use WebSockets, which Railway supports without extra configuration.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Build fails mentioning `VOLUME` | You are on an old commit; the Dockerfile no longer declares one. Pull the latest `main`. |
| Logs: *SoftEX cannot write to its data directory* | Set `RAILWAY_RUN_UID=0`, and check that the volume's mount path is `/app/server/data`. |
| Everything disappears after a deploy | The volume is missing or mounted at the wrong path. |
| Signed out immediately after signing in | `SOFTEX_SECURE_COOKIES=true` while opening the site over `http://`. Use the `https://` address. |
| Email links point to `localhost` | Set `SOFTEX_PUBLIC_URL`. |
| *Cross-origin request rejected* | You're opening the app on a different address than it's being served from. Use the address in `SOFTEX_PUBLIC_URL`. |
| Everyone gets *Too many attempts* at once | `SOFTEX_TRUST_PROXY` is missing, so all visitors look like the same address. Set it to `1`. |
| Health check fails | Open the deploy logs. The server must print `SoftEX server listening on …` within 60 seconds. |
