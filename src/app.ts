import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { DB } from './db.js';
import { applyRecords, pinHash, FREQ_DAYS } from './sync.js';
import { getState } from './state.js';

const str = (v: unknown, max = 300) => String(v ?? '').trim().slice(0, max);
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

function cleanDraft(input: unknown) {
  if (!Array.isArray(input)) throw new Error('draft must be a list of checklists');
  return input.slice(0, 200).map((c: any) => ({
    id: str(c.id, 80) || randomUUID(), name: str(c.name, 200) || 'Untitled checklist', freq: str(c.freq, 40) || 'Weekly',
    role: str(c.role, 40) || 'Deckhand', countersign: !!c.countersign, event: str(c.event, 20),
    items: (Array.isArray(c.items) ? c.items : []).slice(0, 300).map((i: any) => ({
      id: str(i.id, 80) || randomUUID(), text: str(i.text, 300), type: ['check', 'reading', 'note', 'photo'].includes(i.type) ? i.type : 'check',
      unit: str(i.unit, 20), min: i.min === null || i.min === '' || isNaN(Number(i.min)) ? null : Number(i.min), max: i.max === null || i.max === '' || isNaN(Number(i.max)) ? null : Number(i.max),
    })),
  }));
}

export async function publish(db: DB, vid: string) {
  return db.tx(async (q) => {
    const v = (await q.query('select version, draft from vessels where id=$1', [vid])).rows[0];
    if (!v) throw new Error('unknown vessel');
    const next = v.version + 1, lists: any[] = v.draft;
    await q.query('update vessels set checklists=draft, version=$2, published_at=now() where id=$1', [vid, next]);
    await q.query('insert into standard_versions(vessel_id,version,checklists) values($1,$2,$3::jsonb)', [vid, next, JSON.stringify(lists)]);
    // Keep the schedule in step with the new standard.
    const open = (await q.query('select id, checklist_id from dues where vessel_id=$1 and run_id is null', [vid])).rows;
    for (const d of open) if (!lists.some((c) => c.id === d.checklist_id)) await q.query('delete from dues where id=$1', [d.id]);
    for (const c of lists) {
      if (c.event || !FREQ_DAYS[c.freq] || open.some((d) => d.checklist_id === c.id)) continue;
      await q.query('insert into dues(id,vessel_id,checklist_id,due_at) values($1,$2,$3,now())', [randomUUID(), vid, c.id]);
    }
    await q.query('insert into activity(id,vessel_id,at,text) values($1,$2,now(),$3)', [randomUUID(), vid, `Standard v${next} published`]);
    return next;
  });
}

export function createApp(db: DB, opts: { accessCode?: string; webDir?: string } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '12mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // Photo ids are random UUIDs, so the link itself is the key. This lets <img> tags load them.
  app.get('/api/photos/:id', wrap(async (req, res) => {
    const p = (await db.query('select mime, data from photos where id=$1', [req.params.id])).rows[0];
    if (!p) return res.status(404).end();
    res.set('Content-Type', p.mime).set('Cache-Control', 'private, max-age=31536000, immutable').set('X-Content-Type-Options', 'nosniff')
      .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'").send(Buffer.from(p.data));
  }));

  // Placeholder gate for the pilot: one shared access code. Real per-person sign-in replaces it.
  app.use('/api', (req, res, next) => {
    const want = opts.accessCode;
    if (!want) return next();
    const got = Buffer.from(String(req.get('x-tys-code') || '')), exp = Buffer.from(want);
    if (got.length === exp.length && timingSafeEqual(got, exp)) return next();
    res.status(401).json({ error: 'Enter the access code.' });
  });

  app.get('/api/vessels', wrap(async (_req, res) => {
    res.json((await db.query('select id, name, type, version from vessels order by created_at')).rows);
  }));

  app.post('/api/vessels', wrap(async (req, res) => {
    const name = str(req.body?.name, 120);
    if (!name) return res.status(400).json({ error: 'A vessel needs a name.' });
    const id = randomUUID();
    await db.query('insert into vessels(id,name,type,year,port,owner) values($1,$2,$3,$4,$5,$6)',
      [id, name, str(req.body.type), str(req.body.year, 10), str(req.body.port), str(req.body.owner)]);
    res.status(201).json({ id });
  }));

  const vessel = express.Router({ mergeParams: true });
  vessel.use((req, res, next) => {
    db.query('select 1 from vessels where id=$1', [req.params.vid])
      .then((r) => (r.rows.length ? next() : res.status(404).json({ error: 'Unknown vessel.' })))
      .catch(next);
  });
  app.use('/api/vessels/:vid', vessel);

  vessel.get('/state', wrap(async (req, res) => res.json(await getState(db, req.params.vid))));

  vessel.post('/sync', wrap(async (req, res) => {
    const records = req.body?.records;
    if (!Array.isArray(records) || records.length > 500) return res.status(400).json({ error: 'Send up to 500 records per sync.' });
    const result = await applyRecords(db, req.params.vid, records);
    res.json({ ...result, state: await getState(db, req.params.vid) });
  }));

  vessel.put('/', wrap(async (req, res) => {
    const b = req.body || {}, name = str(b.name, 120);
    if (!name) return res.status(400).json({ error: 'A vessel needs a name.' });
    await db.query('update vessels set name=$2,type=$3,year=$4,port=$5,owner=$6 where id=$1', [req.params.vid, name, str(b.type), str(b.year, 10), str(b.port), str(b.owner)]);
    res.json({ ok: true });
  }));

  vessel.put('/draft', wrap(async (req, res) => {
    let draft;
    try { draft = cleanDraft(req.body?.draft); } catch (e: any) { return res.status(400).json({ error: e.message }); }
    await db.query('update vessels set draft=$2::jsonb where id=$1', [req.params.vid, JSON.stringify(draft)]);
    res.json({ ok: true });
  }));

  vessel.post('/publish', wrap(async (req, res) => res.json({ version: await publish(db, req.params.vid) })));

  vessel.post('/users', wrap(async (req, res) => {
    const name = str(req.body?.name, 120), role = str(req.body?.role, 40), pin = str(req.body?.pin, 4);
    if (!name || !['Captain', 'Engineer', 'Deckhand'].includes(role) || !/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'Send a name, a role and a 4-digit PIN.' });
    await db.query('insert into users(id,vessel_id,name,role,pin_hash) values($1,$2,$3,$4,$5)', [randomUUID(), req.params.vid, name, role, pinHash(req.params.vid, pin)]);
    res.status(201).json({ ok: true });
  }));

  vessel.post('/equipment', wrap(async (req, res) => {
    const name = str(req.body?.name, 120);
    if (!name) return res.status(400).json({ error: 'Equipment needs a name.' });
    await db.query('insert into equipment(id,vessel_id,name,detail,loc) values($1,$2,$3,$4,$5)', [randomUUID(), req.params.vid, name, str(req.body.detail), str(req.body.loc)]);
    res.status(201).json({ ok: true });
  }));

  vessel.post('/requests/:rid/done', wrap(async (req, res) => {
    await db.query(`update change_requests set status='done' where id=$1 and vessel_id=$2`, [req.params.rid, req.params.vid]);
    res.json({ ok: true });
  }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use(express.static(opts.webDir || path.resolve(process.cwd(), 'web'), { maxAge: 0 }));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(err?.type === 'entity.too.large' ? 413 : 500).json({ error: err?.type === 'entity.too.large' ? 'That upload is too large.' : 'Something went wrong on the server.' });
  });
  return app;
}
