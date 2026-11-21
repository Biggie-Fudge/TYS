import type { Q } from './db.js';
const ms = (v: any) => (v == null ? null : +new Date(v));

/** Everything a client needs for one vessel, in the shape the web app uses. */
export async function getState(q: Q, vid: string) {
  const v = (await q.query('select * from vessels where id=$1', [vid])).rows[0];
  if (!v) return null;
  const rows = async (sql: string) => (await q.query(sql, [vid])).rows;
  const [users, equipment, dues, runs, issues, logs, trips, requests, activity] = await Promise.all([
    rows('select * from users where vessel_id=$1 order by name'),
    rows('select * from equipment where vessel_id=$1 order by name'),
    rows(`select * from dues where vessel_id=$1 and (run_id is null or due_at > now() - interval '45 days') order by due_at`),
    rows('select * from runs where vessel_id=$1 order by signed_at desc limit 400'),
    rows('select * from issues where vessel_id=$1 order by raised_at desc limit 400'),
    rows('select * from log_entries where vessel_id=$1 order by at desc limit 400'),
    rows('select * from trips where vessel_id=$1 order by closed_at desc limit 100'),
    rows('select * from change_requests where vessel_id=$1 order by at desc limit 100'),
    rows('select * from activity where vessel_id=$1 order by at desc limit 100'),
  ]);
  return {
    serverTime: Date.now(),
    vessel: { id: v.id, name: v.name, type: v.type, year: v.year, port: v.port, owner: v.owner },
    version: v.version, published: ms(v.published_at), checklists: v.checklists, draft: v.draft,
    users: users.map((u) => ({ id: u.id, name: u.name, role: u.role, pinHash: u.pin_hash })),
    equipment: equipment.map((e) => ({ id: e.id, name: e.name, detail: e.detail, loc: e.loc })),
    due: dues.map((d) => ({ id: d.id, clId: d.checklist_id, dueAt: ms(d.due_at), runId: d.run_id })),
    runs: runs.map((r) => ({ id: r.id, clId: r.checklist_id, clName: r.checklist_name, version: r.version, by: r.signed_by, at: ms(r.signed_at),
      results: r.results, needsCounter: r.needs_counter, counterBy: r.counter_by, tripId: r.trip_id, dueId: r.due_id, synced: true })),
    issues: issues.map((i) => ({ id: i.id, title: i.title, note: i.note, photo: i.photo, by: i.raised_by, at: ms(i.raised_at), from: i.source,
      assignee: i.assignee, due: i.due, status: i.status, fix: i.fix, closedAt: ms(i.closed_at), comments: i.comments, synced: true })),
    logs: logs.map((l) => ({ id: l.id, at: ms(l.at), by: l.by_name, port: l.port, stbd: l.stbd, gen: l.gen, fuel: l.fuel, note: l.note, synced: true })),
    trips: trips.map((t) => ({ id: t.id, name: t.name, startedAt: ms(t.started_at), closedAt: ms(t.closed_at) })),
    requests: requests.map((r) => ({ id: r.id, by: r.by_name, at: ms(r.at), text: r.text, status: r.status })),
    activity: activity.map((a) => ({ id: a.id, at: ms(a.at), text: a.text, synced: true })),
  };
}
