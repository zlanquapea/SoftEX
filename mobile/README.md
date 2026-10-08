# Küü for iOS and Android

The native Küü app, built with [Expo](https://expo.dev) and React Native from one TypeScript code base. It has the same screens, features and look as the web app, laid out for phones: Home, Inbox, Chats, My work and More along the bottom, and everything else (projects, goals, dashboards, whiteboards, knowledge, meetings, directory, settings, administration, billing, operator console) one tap away.

It talks to the same server as the web app (`../server`). Nothing in it is a web view.

## What's in the app

| Area | On the phone |
| --- | --- |
| **Sign-in** | Email and password, authenticator codes, required MFA set-up, single sign-on (opens the identity provider in the system browser and hands back with PKCE), sign-up in hosted mode, invitations, password reset and email confirmation links. **Use a different server** under the sign-in form points the app at a self-hosted Küü |
| **Communication** | Channels, DMs and group chats, threads, mentions (`@name`, `@channel`, `@here`), reactions, pins, saved items, polls, voice notes, photos, files and video, forwarding, urgent messages, send later, drafts, remind me, turn a message into a task or decision, typing indicators, AI thread summaries |
| **Work** | My work, tasks (owner, reviewer, collaborators, checklist, subtasks, dependencies, recurrence, labels, custom fields, timer and time entries, comments, attachments), projects in list, board, table, calendar and timeline views, milestones, status updates, risks, automations, intake forms, CSV import, goals and key results, dashboards, workload, timesheet, requests, decisions, Later |
| **Knowledge & meetings** | Nested pages with live co-editing (Yjs), comments and publish to the web; files with versions; meetings with agenda, RSVP, notes, decisions, follow-ups and `.ics` export; **audio** recording and searchable, seekable transcripts |
| **Whiteboards** | Touch canvas with sticky notes, shapes, text, arrows and drawing, pinch to zoom, two-finger pan, live cursors, undo, SVG export to the share sheet |
| **People & admin** | Directory and profiles, check-ins, status and focus time, settings (theme, notifications, quiet hours, security, sessions, API tokens, calendar link, data export, account deletion), the full Administration area, plan and billing, and the operator console |
| **Notifications** | Native push on iOS and Android through Expo's push service. Tapping one opens the message, task or page it is about |

Two things differ on a phone on purpose:

- **Meeting recording is audio only.** Phones can't capture another app's screen, and live captions aren't offered. The server transcribes the recording afterwards, the same as on the web.
- **Plans can't be bought inside the store builds.** App Store and Google Play rules require their own payment system for digital subscriptions bought in an app. Store builds therefore show the plan, usage and payment history, and send admins to the web to change plans. Set `EXPO_PUBLIC_KUU_IN_APP_PAYMENTS=1` to show the mobile money and bank payment form inside the app, for example in builds you distribute yourself. Check the store rules before you turn it on in a store build.

## Run it

You need Node 22 or later and the server running (`npm run dev` at the repository root starts it on `:4000`).

```bash
cd mobile
npm install
EXPO_PUBLIC_KUU_SERVER=http://<your computer's LAN address>:4000 npx expo start
```

- Press `i` for the iOS simulator, `a` for an Android emulator, or `w` for a browser preview.
- Expo Go runs most of the app. Push notifications need a [development build](https://docs.expo.dev/develop/development-builds/introduction/): `npx eas build --profile development`.
- A phone can't reach `localhost` on your computer. Use the computer's LAN address, or a tunnel.
- Plain `http` works in development. Release builds need an `https` server (iOS refuses plain `http` by default).

### Browser preview

The web build is handy for checking layouts. It has to be served from the same origin as the API, because it signs in with the session cookie like the web app does:

```bash
EXPO_PUBLIC_KUU_SAME_ORIGIN=1 npx expo export --platform web
```

Then serve `dist/` and proxy `/api` and `/ws` to the server.

## Settings

Build-time settings are `EXPO_PUBLIC_*` environment variables. Put them in `.env.local` (git-ignored), or in the `env` of a profile in `eas.json`.

| Variable | Default | What it does |
| --- | --- | --- |
| `EXPO_PUBLIC_KUU_SERVER` | `https://kuu.example.com` | The server the app signs in to unless the person picks another one. **Set this to your hosted Küü address for every release build.** |
| `EXPO_PUBLIC_KUU_IN_APP_PAYMENTS` | *(off)* | `1` shows the payment form in Plan & billing. See above |
| `EXPO_PUBLIC_KUU_SAME_ORIGIN` | *(off)* | `1` for the browser preview only: same-origin requests with cookies |

The bundle identifier and Android package are both `com.kuu.app`, and the deep-link scheme is `kuu://`. Change them in `app.json` before the first store release if you need different ones. The SSO hand-back uses `kuu://sso`, so if you change the scheme, change `MOBILE_REDIRECT` in `server/src/routes/sso.ts` too.

## Release builds with EAS

1. Install the CLI and sign in: `npm install -g eas-cli`, then `eas login`.
2. Link the project: `eas init`. This writes `extra.eas.projectId` into `app.json`. Push tokens need this ID.
3. Set the server for release builds: `eas env:create --name EXPO_PUBLIC_KUU_SERVER --value https://your-kuu.example --environment production`, or add it to the `production` profile in `eas.json`.
4. Build:
   - `eas build --platform ios --profile production` (Apple Developer account needed; EAS can create the certificates and provisioning profile for you).
   - `eas build --platform android --profile production` (an AAB for Google Play; EAS can create the upload keystore).
   - The `preview` profile makes an installable APK, and an ad-hoc iOS build, for testers.
5. Submit with `eas submit --platform ios` / `--platform android`, or upload the files yourself.

### Push notifications

The server sends to Expo's push service, which delivers through Apple (APNs) and Google (FCM).

- **iOS:** when `eas build` asks, let it create a push key. Or upload your own APNs key (`.p8`) with `eas credentials`.
- **Android:** create a Firebase project, add an Android app with package `com.kuu.app`, and upload a Firebase **service account key** (FCM v1) with `eas credentials`. You don't need to commit `google-services.json` to get push through Expo.
- **Server:** mobile push is on by default. If you turn on *Enhanced security for push notifications* in your Expo account, set `EXPO_ACCESS_TOKEN` on the server. `SOFTEX_MOBILE_PUSH=off` turns mobile push off.

People are asked for permission after they sign in. They can test push, or turn it off, under *Settings → Notifications*.

## Checks

```bash
npm run typecheck           # TypeScript
npm run export:check        # bundles iOS, Android and web with Metro, which catches import and native-module errors
```

CI runs both (the **Mobile app** job in `.github/workflows/ci.yml`).

## Layout

```
src/app/        screens, one file per route (expo-router); the routes match the web app's URLs, so links and notifications open the same thing
  (auth)/       sign-in, sign-up, password reset, server picker
  (app)/(tabs)/ Home, Inbox, Chats, My work, More
  (app)/        everything else
src/lib/        API client (bearer session token in the secure store), realtime socket, session, theme, push, files, live collaboration
src/ui/         shared components: kit (buttons, sheets, inputs…), icons, Markdown, pickers, charts, whiteboard, message composer…
src/screens/    sign-in flows shared by several routes
```

The web app and the phone app share their design tokens, not their code. The colours in `src/lib/theme.tsx` are the same variables as in `client/src/styles.css`, and the icons are the same SVG paths. If you change one, change the other.
