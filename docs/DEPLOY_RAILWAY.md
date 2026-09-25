# Deploying SoftEX on Railway

SoftEX runs on Railway as **one service** built from the repository's `Dockerfile`, with **one volume** for the database and uploaded files. `railway.json` in the repository sets the builder, the health check (`/api/health`) and the restart policy, so there is nothing to configure for the build itself.

This guide sets SoftEX up as a **hosted service (SaaS)**: customers sign up themselves, get a 30-day Business trial, can stay on the Free plan forever, and pay for Standard or Business with Orange Money, MTN Mobile Money or bank transfer. If you only want a private server for one organisation, see [Private deployment](#private-deployment-for-one-organisation) at the end.

Allow about 20 minutes.

## What you need

- A Railway account on a plan that includes volumes (the Hobby plan or higher).
- Access to the `zlanquapea/SoftEX` GitHub repository.
- **Email sending (required for SaaS):** SMTP credentials from a provider such as Postmark, Resend, SendGrid, Mailgun or Amazon SES, and a sender address on a domain you control. New customers must confirm their email address before they can invite people or pay, so email has to work.
- **Where customers pay you:** your Orange Money and/or MTN MoMo merchant or wallet numbers, and bank account details.
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
# Server
PORT=4000
SOFTEX_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
SOFTEX_SECURE_COOKIES=true
SOFTEX_TRUST_PROXY=1
SOFTEX_SECRET_KEY=<paste a long random string, see below>
RAILWAY_RUN_UID=0

# Hosted service (SaaS)
SOFTEX_MODE=saas
SOFTEX_REGISTRATION=open
SOFTEX_OPERATOR_EMAILS=you@yourcompany.com
SOFTEX_SUPPORT_EMAIL=billing@yourcompany.com
SOFTEX_PRICE_STANDARD=1.50
SOFTEX_PRICE_BUSINESS=3
SOFTEX_LRD_PER_USD=190
SOFTEX_COMPANY_NAME=Your Company Ltd
SOFTEX_COMPANY_ADDRESS=Broad Street, Monrovia, Liberia
SOFTEX_LEGAL_EMAIL=legal@yourcompany.com
SOFTEX_PAYMENT_INSTRUCTIONS=**Orange Money:** send to 0770 000 000 (Your Company Ltd)\n\n**MTN MoMo:** send to 0880 000 000 (Your Company Ltd)\n\n**Bank transfer:** Ecobank Liberia, account name Your Company Ltd, account number 0000000000

# Email (required for SaaS)
SOFTEX_SMTP_URL=smtps://USERNAME:PASSWORD@smtp.yourprovider.com:465
SOFTEX_MAIL_FROM=SoftEX <softex@yourcompany.com>

# AI features for the Business plan (optional)
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
| `SOFTEX_MODE` | `saas` turns on plans, the 30-day trial, usage limits, email confirmation, billing and the operator console. |
| `SOFTEX_REGISTRATION` | `open` lets anyone create a workspace from the sign-up page, which is what a SaaS needs. |
| `SOFTEX_OPERATOR_EMAILS` | Your own email address (comma-separate several). These accounts get the **Operator console**, where you confirm payments and manage customers. Operators must turn on multifactor authentication. |
| `SOFTEX_SUPPORT_EMAIL` | Shown to customers on the pricing and billing pages. |
| `SOFTEX_PRICE_STANDARD`, `SOFTEX_PRICE_BUSINESS` | Price per member per month, in US dollars. Defaults are $1.50 and $3. Paying 12 months at once gets two months free. |
| `SOFTEX_LRD_PER_USD` | Optional exchange rate. When set, prices also show an approximate amount in Liberian dollars. Update it when the rate moves. |
| `SOFTEX_COMPANY_NAME`, `SOFTEX_COMPANY_ADDRESS`, `SOFTEX_LEGAL_EMAIL` | Your business details. They appear on the website footer and in the Terms of Service and Privacy Policy at `/terms` and `/privacy`. Those pages are **drafts**: have a lawyer review them before you take customers. |
| `SOFTEX_PAYMENT_INSTRUCTIONS` | What customers see when they pay: your mobile money numbers and bank details. Markdown is allowed; write `\n` for a new line. |
| `RAILWAY_RUN_UID` | Railway mounts volumes as root, and SoftEX's image runs as an unprivileged user. `0` lets the app write to the volume. If it is missing, the logs say *SoftEX cannot write to its data directory*. |
| `SOFTEX_SMTP_URL`, `SOFTEX_MAIL_FROM` | Without them, emails are kept in **Administration → Email** but not sent, so customers can't confirm their address. URL-encode special characters in the password (for example `@` → `%40`). Use port 465 with `smtps://`, or port 587 with `smtp://`. |
| `ANTHROPIC_API_KEY` | Makes Ask SoftEX, summaries and task suggestions available on the Business plan and during trials. Every workspace's AI use is billed to this key, so it is capped: 50 requests per member per month on Business, and 100 requests in total per trial (`SOFTEX_TRIAL_AI_REQUESTS`). |

To make a secret key, run this on your computer and paste the output:

```bash
openssl rand -hex 32
```

Click **Deploy** (or **Apply changes**) to redeploy with the volume and variables.

## 5. Set up your operator account

1. Open your public address and click **Create a workspace**. Sign up with the email address you put in `SOFTEX_OPERATOR_EMAILS`. This is your company's own workspace.
2. Open the confirmation email and click the link. If it doesn't arrive, check the SMTP settings and **Administration → Email**.
3. Go to **Settings → Security** and turn on multifactor authentication. The operator console won't open without it.
4. Open the workspace menu (top left) → **Operator console**.
5. Your own workspace starts on a trial like everyone else's. To keep it on Business, open **Workspaces**, click it, set **Plan** to *Business* and **Paid through** to a date far in the future, and save.
6. Check that the proxy setting works. In **Administration → Audit log**, find your `auth.login` entry and check the IP address is your own public address, not a private one like `10.x.x.x` or `100.64.x.x`. If it is private, set `SOFTEX_TRUST_PROXY=2` and check again.
7. Sign out and open your address: signed-out visitors see the product website, with pricing at `/pricing`, and the terms and privacy policy at `/terms` and `/privacy`. Sign-in is at `/login`. Share the address on your social media and in your email signature.

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

Railway redeploys automatically when `main` changes, because the service is connected to the GitHub repository. Database changes are applied automatically when the new version starts. Services with a volume restart rather than overlap, so expect a few seconds of downtime per deploy. After moving to PostgreSQL and object storage (see *Growing* below), deploys have no downtime.

## Backups

**With SQLite (the default), SoftEX backs itself up.** Once a day it takes a consistent copy of the database, checks it with SQLite's integrity check, compresses it and keeps the newest 7. Change this with `SOFTEX_BACKUP_HOURS` and `SOFTEX_BACKUP_KEEP`, or turn it off with `SOFTEX_BACKUPS=off`.

- **Where they go.** With object storage set up (`SOFTEX_S3_*`, see *Growing* below), backups go to the bucket under `backups/`, away from the server. Without it they stay in `/app/server/data/backups` on the volume, which protects against mistakes but not against losing the volume. In that case, download one every week or so.
- **Check them.** **Operator console → Backups** shows the last backup, warns when one has failed or none has run for a day, and lets you **Back up now** (do this before big changes) or **Download** a copy. Every download is recorded in the activity log, because a backup holds every workspace.
- **Restore.** Set the variable `SOFTEX_RESTORE_BACKUP` to the backup's file name (for example `softex-2026-09-25T02-00-00-000Z.db.gz`) and redeploy. SoftEX checks the backup, keeps the current database beside it as `softex.db.before-restore-…`, and starts from the backup. Then delete the variable; it won't restore the same backup twice either way.
- **Also:** if your Railway plan offers volume **Backups**, turn them on as a second layer. People can export what they can access from **Settings → Security → Export my data**.

**With PostgreSQL**, use the database's own backups: open the Postgres service → **Backups**. Test a restore into a new database from time to time.

## Running the service day to day

**Plans**

| | Free | Standard | Business |
| --- | --- | --- | --- |
| Price per member / month | $0 | `SOFTEX_PRICE_STANDARD` ($1.50) | `SOFTEX_PRICE_BUSINESS` ($3) |
| Members | Up to 10 | Unlimited | Unlimited |
| Storage | 2 GB | 10 GB + 5 GB per member | 20 GB + 10 GB per member |
| Chat, tasks, projects, knowledge, meetings, decisions | ✓ | ✓ | ✓ |
| Timeline, workload, automations, guests, insights, API and webhooks | | ✓ | ✓ |
| AI, single sign-on, SCIM, retention and legal hold | | | ✓ |

New workspaces get a 30-day Business trial (`SOFTEX_TRIAL_DAYS`). When a trial or paid period ends, the workspace moves to Free after a 7-day grace period for paid plans. Nothing is deleted; paid features pause until they pay. Owners and admins get reminders by email and in the app 7 days and 1 day before a trial ends, 7 days before a paid period ends, when a payment is overdue, and when the workspace moves to Free.

**Confirming payments.** When a customer pays, they enter the transaction ID in **Administration → Billing**, and you get an email. In **Operator console → Payments to confirm**, check the payment really arrived in your Orange Money, MTN MoMo or bank account (match the reference and the amount), then click **Confirm**. The customer's plan starts or extends immediately, and they get a receipt by email. If the money didn't arrive, click **Reject** and give a reason; they're told by email.

**Other operator tools**

- **Workspaces:** search by name or owner email. You can extend a trial, grant or correct a plan by hand (discounts, partners, refunds), or suspend a workspace that breaks your terms. Suspension signs everyone out until you restore it.
- **Activity log:** a permanent record of payments, plan changes, suspensions and deleted workspaces.

You see sizes, dates and counts only. The console never shows customers' messages, files or tasks.

**Customers leaving.** Owners can delete their workspace (Administration → Workspace → Delete workspace), and anyone can delete their own account (Settings → Security). Both are permanent and recorded in the activity log.

**Card payments.** Stripe doesn't accept businesses registered in Liberia. If you later register a company in a supported country, or get merchant API access from Orange Money or MTN MoMo, automatic payment confirmation can be added on top of the current billing system.

## Private deployment for one organisation

To run SoftEX just for your own organisation, leave out the *Hosted service (SaaS)* variables and set `SOFTEX_REGISTRATION=first`. The first person to sign up creates the only workspace, everyone else joins by invitation, and there are no plans or limits. Email is then optional.

## Growing: several servers

The setup above runs one server with its data in a SQLite file on the volume. That comfortably handles an early customer base. When you need more capacity or no downtime during deploys, move to **PostgreSQL** and **object storage**, and run several copies (replicas) of SoftEX:

1. **Add PostgreSQL:** in the project, click **New → Database → PostgreSQL**.
2. **Create object storage for files.** Any S3-compatible service works. Cloudflare R2 has a free tier and no download fees:
   1. In Cloudflare, go to **R2 → Create bucket** (for example `softex-files`).
   2. Go to **R2 → Manage API tokens → Create API token** with *Object Read & Write* on that bucket, and copy the access key ID and secret.
   3. Note your account ID, which is shown on the R2 overview page.
3. **Add these variables to the SoftEX service:**

   ```env
   SOFTEX_DATABASE_URL=${{Postgres.DATABASE_URL}}
   SOFTEX_S3_BUCKET=softex-files
   SOFTEX_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   SOFTEX_S3_REGION=auto
   SOFTEX_S3_ACCESS_KEY_ID=<access key id>
   SOFTEX_S3_SECRET_ACCESS_KEY=<secret access key>
   ```

   (`Postgres` is the name of the database service. Use yours if you renamed it.) For AWS S3, leave out the endpoint and set the bucket's region. For MinIO, also set `SOFTEX_S3_FORCE_PATH_STYLE=true`.
4. **Move existing data, if you already have customers.** Switching the variables starts with an empty PostgreSQL database and empty storage. Nothing is copied from the SQLite file automatically. Do this before launch, or plan a migration.
5. **Remove the volume and `RAILWAY_RUN_UID`.** With PostgreSQL and object storage, nothing needs to survive on the server's own disk.
6. **Raise the replicas:** in the service, go to **Settings → Deploy → Replicas** and choose 2 or more.

What SoftEX does when several servers share one database:

- Live updates, sign-outs and "who's online" pass between servers through PostgreSQL (`LISTEN/NOTIFY`), so a message posted on one server reaches people connected to another.
- Background jobs (emails, reminders, webhooks, billing notices) run on one server at a time, using a database lock.
- Sign-in rate limits are stored in the database, so they apply across all servers.
- Database changes on upgrade run once, even when several servers start together.

Railway deploys new versions without downtime once the service has no volume.

## Limits

- **SQLite:** one server only, with its data on the volume. Use PostgreSQL to run several.
- **General API rate limit:** the limit of 1,200 requests per minute per IP address is counted separately on each server. Sign-in limits are shared.
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
| Customers can't invite people or pay | They haven't confirmed their email address. They can resend the link from the banner at the top of the page. If emails never arrive, check `SOFTEX_SMTP_URL`. |
| *Operator console* is missing from the menu | Your email address must be listed in `SOFTEX_OPERATOR_EMAILS`, and `SOFTEX_MODE` must be `saas`. Redeploy after changing variables. |
| Logs: *SoftEX could not start: the database is not reachable* | Check `SOFTEX_DATABASE_URL`. With Railway's reference variable, the PostgreSQL service must be in the same project. |
| Files uploaded before moving to S3 are missing | Local files aren't copied to the bucket automatically; copy the contents of `/app/server/data/uploads` into the bucket (same file names) before removing the volume. |
| Phone notifications don't arrive | People turn them on per device in **Settings → Notifications & focus**. On iPhone and iPad, SoftEX must first be added to the Home Screen and opened from there. Alerts only go out while the person isn't using SoftEX, and not during their quiet hours or focus time unless the message is urgent. |
| Operator console shows *The last backup failed* | Read the error shown there. The usual cause is a full volume: lower `SOFTEX_BACKUP_KEEP`, grow the volume, or move files and backups to S3 storage. |
| Health check fails | Open the deploy logs. The server must print `SoftEX server listening on …` within 60 seconds. |
