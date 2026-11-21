import { randomUUID, createHash } from 'node:crypto';
import type { DB, Q } from './db.js';

export type Rec = { id: string; type: string; data: any };
export const FREQ_DAYS: Record<string, number> = { Weekly: 7, Monthly: 30, Quarterly: 90, 'Every 10 days': 10 };
const D = 864e5;
const ts = (ms: unknown) => new Date(Number(ms) || Date.now()).toISOString();
const s = (v: unknown, max = 4000) => String(v ?? '').slice(0, max);
export const pinHash = (vid: string, pin: string) => createHash('sha256').update(`${vid}:${pin}`).digest('hex');

type Handler = (q: Q, vid: string, id: string, d: any) => Promise<void>;

const HANDLERS: Record<string, Handler> = {
  async run(q, vid, id, d) {
    if (!Array.isArray(d.results)) throw new Error('run needs results');
    await q.query(
      `insert into runs(id,vessel_id,checklist_id,checklist_name,version,signed_by,signed_at,results,needs_counter,trip_id,due_id)
       values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
      [id, vid, s(d.clId, 80), s(d.clName, 200), Number(d.version) || 0, s(d.by, 120), ts(d.at), JSON.stringify(d.results), !!d.needsCounter, d.tripId || null, d.dueId || null]);
    if (!d.dueId) return;
    const hit = await q.query('update dues set run_id=$1 where id=$2 and vessel_id=$3 and run_id is null returning checklist_id, due_at', [id, d.dueId, vid]);
    if (!hit.rows.length) return;
    // Schedule the next occurrence from the checklist's frequency.
    const v = await q.query('select checklists from vessels where id=$1', [vid]);
    const cl = (v.rows[0]?.checklists || []).find((c: any) => c.id === hit.rows[0].checklist_id);
    const days = cl && FREQ_DAYS[cl.freq];
    if (days) await q.query('insert into dues(id,vessel_id,checklist_id,due_at) values($1,$2,$3,$4)',
      [randomUUID(), vid, cl.id, new Date(Math.max(Number(d.at) || Date.now(), +new Date(hit.rows[0].due_at)) + days * D).toISOString()]);
  },
  async issue(q, vid, id, d) {
    await q.query(
      `insert into issues(id,vessel_id,title,note,photo,raised_by,raised_at,source) values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, vid, s(d.title, 300), s(d.note), d.photo || null, s(d.by, 120), ts(d.at), s(d.from, 200)]);
  },
  async issue_event(q, vid, _id, d) {
    const cur = await q.query('select status from issues where id=$1 and vessel_id=$2', [d.issueId, vid]);
    if (!cur.rows.length) throw new Error('unknown issue');
    if (d.kind === 'comment') {
      await q.query(`update issues set comments = comments || $1::jsonb where id=$2`,
        [JSON.stringify([{ by: s(d.by, 120), text: s(d.text, 1000), at: Number(d.at) || Date.now() }]), d.issueId]);
      return;
    }
    if (cur.rows[0].status === 'closed') return; // a closed issue stays closed
    await q.query('update issues set assignee=$1, due=$2, fix=$3 where id=$4', [s(d.assignee, 120), s(d.due, 20), s(d.fix), d.issueId]);
    if (d.kind === 'close') await q.query(`update issues set status='closed', closed_at=$1 where id=$2`, [ts(d.at), d.issueId]);
  },
  async countersign(q, vid, _id, d) {
    await q.query('update runs set counter_by=$1, counter_at=$2 where id=$3 and vessel_id=$4 and counter_by is null', [s(d.by, 120), ts(d.at), d.runId, vid]);
  },
  async log(q, vid, id, d) {
    await q.query('insert into log_entries(id,vessel_id,at,by_name,port,stbd,gen,fuel,note) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, vid, ts(d.at), s(d.by, 120), s(d.port, 20), s(d.stbd, 20), s(d.gen, 20), s(d.fuel, 20), s(d.note, 1000)]);
  },
  async trip(q, vid, id, d) {
    await q.query('insert into trips(id,vessel_id,name,started_at,closed_at) values($1,$2,$3,$4,$5)', [id, vid, s(d.name, 200), ts(d.startedAt), ts(d.closedAt)]);
  },
  async request(q, vid, id, d) {
    await q.query('insert into change_requests(id,vessel_id,by_name,at,text) values($1,$2,$3,$4,$5)', [id, vid, s(d.by, 120), ts(d.at), s(d.text, 2000)]);
  },
  async activity(q, vid, id, d) {
    await q.query('insert into activity(id,vessel_id,at,text) values($1,$2,$3,$4)', [id, vid, ts(d.at), s(d.text, 500)]);
  },
  async photo(q, vid, id, d) {
    const m = /^data:(image\/[a-z0-9.+-]+)(;[a-z0-9=-]+)*?(;base64)?,(.*)$/is.exec(String(d.dataUrl || ''));
    if (!m) throw new Error('photo needs an image data URL');
    const buf = m[3] ? Buffer.from(m[4], 'base64') : Buffer.from(decodeURIComponent(m[4]), 'utf8');
    if (buf.length > 6e6) throw new Error('photo is larger than 6 MB');
    await q.query('insert into photos(id,vessel_id,mime,data) values($1,$2,$3,$4)', [id, vid, m[1].toLowerCase(), buf]);
  },
};

/** Apply a batch from a device. Safe to call twice with the same records. */
export async function applyRecords(db: DB, vid: string, records: Rec[]) {
  const accepted: string[] = [], duplicate: string[] = [], rejected: { id: string; reason: string }[] = [];
  for (const r of records) {
    if (!r || typeof r.id !== 'string' || !r.id || r.id.length > 80 || !HANDLERS[r.type] || !r.data || typeof r.data !== 'object') {
      rejected.push({ id: String(r?.id ?? ''), reason: 'malformed record' });
      continue;
    }
    try {
      const fresh = await db.tx(async (q) => {
        const ledger = r.type === 'photo' ? { stored: 'photos' } : r.data;
        const ins = await q.query('insert into events(id,vessel_id,type,data) values($1,$2,$3,$4::jsonb) on conflict (id) do nothing returning id',
          [r.id, vid, r.type, JSON.stringify(ledger)]);
        if (!ins.rows.length) return false;
        await HANDLERS[r.type](q, vid, r.id, r.data);
        return true;
      });
      (fresh ? accepted : duplicate).push(r.id);
    } catch (e: any) {
      rejected.push({ id: r.id, reason: String(e?.message || e) });
    }
  }
  return { accepted, duplicate, rejected };
}
