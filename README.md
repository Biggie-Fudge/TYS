# TYS (The Yacht Standard)

Pilot build of the yacht operations app: an onboard iPad station, a phone view for the owner and captain, and the onboarding console. One Node service serves the API and the web app. Data lives in Postgres.

## Run it locally

```
npm install
npm run dev
```

Open http://localhost:3000. With no `DATABASE_URL` set, the server uses a local Postgres-compatible database in `.data/pg` and loads a sample vessel, M/Y Meridian. Sample PINs: captain 1111, engineer 2222, deckhand 3333.

`npm test` runs the sync and API tests. `npm run build` compiles to `dist`.

## Deploy on Render

`render.yaml` describes a web service and a Postgres database. Create a Blueprint from this repo, choose the plans, and deploy.

| Variable | What it does |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Set by the blueprint. |
| `TYS_ACCESS_CODE` | Shared access code every device must enter. The blueprint generates one. Read it in the Render dashboard. |
| `SEED_SAMPLE` | `1` loads the sample vessel into an empty database. Off in the Render blueprint, because the sample PINs are public. Turn it on only for a demo instance. |
| `PGSSL` | Set to `require` only if you connect to Postgres over an external URL. |

## How it works

- **Devices only add records.** Every check, log entry, issue and photo gets its ID on the device and waits in an outbox. `POST /api/vessels/:id/sync` stores each record once, keyed by that ID, so a retried sync cannot create duplicates.
- **The standard changes only by publishing.** The console edits a draft. Publishing creates a new version, and every signed check records the version it ran against.
- **Signed checks are locked.** There is no route that edits a run's results. A captain's countersign is the only thing added afterward.
- **Schedules roll forward.** Signing a weekly, monthly or quarterly check creates the next due date.

```
src/schema.ts   tables
src/sync.ts     the sync endpoint's logic, one handler per record type
src/state.ts    everything a client needs for one vessel
src/app.ts      routes
src/seed.ts     the sample vessel
web/index.html  the web app (iPad, phone, console)
web/sw.js       offline shell (service worker)
```

## Offline

- **Storage.** The state cache and the outbox live in IndexedDB on the device. Each queued record, photos included, is written once under its own key. A half-finished checklist is saved too, so a reload or a closed tab does not lose it.
- **App shell.** `web/sw.js` caches the page, font and icons, so the app opens with no signal. When the network answers within three seconds the newest page is used and the cache is refreshed.
- **Install on the iPad.** Open the site in Safari, tap Share, then Add to Home Screen. Open it once while connected so the shell and the vessel's data are stored.
- **Photos** that have been viewed stay available offline.
- `test/offline.manual.cjs` walks the offline path against a local server: work offline, reload twice, reconnect, confirm one copy on the server.

Bump `V` in `web/sw.js` when the list of shell files changes.

## Not done yet

- **Sign-in.** One shared access code protects the API. There are no per-person logins and the server does not enforce owner, captain and crew roles yet.
- **Photos** are stored in Postgres and served by unguessable link. They move to object storage (R2 or S3) later.
- **Email and PDF.** No overdue alerts, weekly owner email or PDF export yet. Reports show on screen.
- **Active trips** live on the iPad that started them until the trip closes.
- **Not yet tried on a real iPad.** The offline logic is tested headlessly. How long iPad Safari keeps the stored data over weeks without use still needs a real device test.
