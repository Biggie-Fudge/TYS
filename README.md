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
| `SEED_SAMPLE` | `1` loads the sample vessel into an empty database. Remove it before onboarding real vessels. |
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
```

## Not done yet

- **Sign-in.** One shared access code protects the API. There are no per-person logins and the server does not enforce owner, captain and crew roles yet.
- **Offline storage.** The outbox lives in browser local storage, which is small. Moving it to IndexedDB, with an installable offline shell, is the next step for real time at sea.
- **Photos** are stored in Postgres and served by unguessable link. They move to object storage (R2 or S3) later.
- **Email and PDF.** No overdue alerts, weekly owner email or PDF export yet. Reports show on screen.
- **Active trips** live on the iPad that started them until the trip closes.
