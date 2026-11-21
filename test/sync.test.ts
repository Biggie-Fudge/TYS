import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.js';
import { SCHEMA } from '../src/schema.js';
import { seedSample } from '../src/seed.js';
import { applyRecords } from '../src/sync.js';
import { getState } from '../src/state.js';
import { createApp, publish } from '../src/app.js';

async function fresh() { const db = await openDb(); await db.exec(SCHEMA); await seedSample(db); return db; }
const VID = 'meridian';

test('seed gives a working vessel', async () => {
  const db = await fresh(), s = (await getState(db, VID))!;
  assert.equal(s.version, 1);
  assert.equal(s.checklists.length, 8);
  assert.equal(s.runs.length, 7);
  assert.equal(s.due.filter((d) => !d.runId).length, 4);
  assert.equal(s.issues.filter((i) => i.status === 'open').length, 1);
  assert.equal(s.issues.find((i) => i.status === 'closed')!.fix, 'Replaced the bulb and tested at dusk.');
  await db.close();
});

test('a retried sync never duplicates, and a signed check schedules the next one', async () => {
  const db = await fresh(), s = (await getState(db, VID))!;
  const weekly = s.checklists.find((c: any) => c.name === 'Weekly engine room check');
  const due = s.due.find((d) => d.clId === weekly.id && !d.runId)!;
  const run = { id: randomUUID(), type: 'run', data: { clId: weekly.id, clName: weekly.name, version: 1, by: 'Marco Ruiz', at: Date.now(), dueId: due.id, needsCounter: true,
    results: [{ text: 'Bilge pump float switches lift and run', type: 'check', val: 'fail', note: 'Stuck', flag: true }] } };
  const issue = { id: randomUUID(), type: 'issue', data: { title: 'Bilge pump float switch', note: 'Stuck', by: 'Marco Ruiz', at: Date.now(), from: weekly.name } };
  const a = await applyRecords(db, VID, [run, issue]);
  assert.deepEqual(a.accepted, [run.id, issue.id]);
  const b = await applyRecords(db, VID, [run, issue]);
  assert.deepEqual(b.duplicate, [run.id, issue.id]);
  const s2 = (await getState(db, VID))!;
  assert.equal(s2.runs.filter((r) => r.id === run.id).length, 1);
  assert.equal(s2.due.find((d) => d.id === due.id)!.runId, run.id);
  const next = s2.due.filter((d) => d.clId === weekly.id && !d.runId);
  assert.equal(next.length, 1);
  assert.ok(next[0].dueAt! > Date.now() + 6 * 864e5);

  // countersign once; a second captain cannot overwrite it
  await applyRecords(db, VID, [{ id: randomUUID(), type: 'countersign', data: { runId: run.id, by: 'Capt. Dana Whitlock', at: Date.now() } }]);
  await applyRecords(db, VID, [{ id: randomUUID(), type: 'countersign', data: { runId: run.id, by: 'Someone Else', at: Date.now() } }]);
  assert.equal((await getState(db, VID))!.runs.find((r) => r.id === run.id)!.counterBy, 'Capt. Dana Whitlock');

  // issue: comment, close, and stays closed
  await applyRecords(db, VID, [
    { id: randomUUID(), type: 'issue_event', data: { issueId: issue.id, kind: 'comment', by: 'Owner', text: 'Thanks', at: Date.now() } },
    { id: randomUUID(), type: 'issue_event', data: { issueId: issue.id, kind: 'close', assignee: 'Marco Ruiz', due: '', fix: 'Freed the switch', at: Date.now() } },
    { id: randomUUID(), type: 'issue_event', data: { issueId: issue.id, kind: 'update', assignee: 'Nobody', due: '', fix: 'changed', at: Date.now() } },
  ]);
  const i = (await getState(db, VID))!.issues.find((x) => x.id === issue.id)!;
  assert.equal(i.status, 'closed'); assert.equal(i.fix, 'Freed the switch'); assert.equal(i.comments.length, 1);
  await db.close();
});

test('bad records are rejected without blocking good ones', async () => {
  const db = await fresh();
  const good = { id: randomUUID(), type: 'log', data: { at: Date.now(), by: 'Tess Okafor', fuel: '50' } };
  const out = await applyRecords(db, VID, [{ id: 'x', type: 'nope', data: {} } as any, { id: randomUUID(), type: 'run', data: { clName: 'No results' } }, good]);
  assert.deepEqual(out.accepted, [good.id]);
  assert.equal(out.rejected.length, 2);
  // the rejected run left nothing behind, so the device can fix and resend it
  assert.equal((await db.query(`select count(*)::int as n from events where type='run' and data->>'clName'='No results'`)).rows[0].n, 0);
  await db.close();
});

test('publishing bumps the version and old runs keep theirs', async () => {
  const db = await fresh();
  const draft = (await getState(db, VID))!.draft;
  draft.push({ id: 'new-list', name: 'Weekly tender check', freq: 'Weekly', role: 'Deckhand', countersign: false, event: '', items: [] });
  await db.query('update vessels set draft=$2::jsonb where id=$1', [VID, JSON.stringify(draft)]);
  assert.equal(await publish(db, VID), 2);
  const s = (await getState(db, VID))!;
  assert.equal(s.version, 2);
  assert.ok(s.runs.every((r) => r.version === 1));
  assert.ok(s.due.some((d) => d.clId === 'new-list' && !d.runId));
  assert.equal((await db.query('select count(*)::int as n from standard_versions where vessel_id=$1', [VID])).rows[0].n, 2);
  await db.close();
});

test('HTTP: access code, sync, photos and the console routes', async () => {
  const db = await fresh();
  const srv = createApp(db, { accessCode: 'pilot-code' }).listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const call = (m: string, p: string, body?: unknown, code = 'pilot-code') => fetch(base + p, { method: m, headers: { 'content-type': 'application/json', 'x-tys-code': code }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await call('GET', '/api/vessels', undefined, 'wrong')).status, 401);
    assert.equal((await fetch(base + '/api/health')).status, 200);
    assert.equal((await call('GET', '/api/vessels/nope/state')).status, 404);
    const pid = randomUUID();
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const r = await (await call('POST', `/api/vessels/${VID}/sync`, { records: [{ id: pid, type: 'photo', data: { dataUrl: png } }] })).json() as any;
    assert.deepEqual(r.accepted, [pid]); assert.equal(r.state.vessel.name, 'M/Y Meridian');
    const img = await fetch(`${base}/api/photos/${pid}`);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal((await call('POST', `/api/vessels/${VID}/users`, { name: 'Sam Lee', role: 'Deckhand', pin: '12' })).status, 400);
    assert.equal((await call('POST', `/api/vessels/${VID}/users`, { name: 'Sam Lee', role: 'Deckhand', pin: '4444' })).status, 201);
    assert.equal((await call('PUT', `/api/vessels/${VID}/draft`, { draft: 'no' })).status, 400);
    assert.equal(((await (await call('POST', `/api/vessels/${VID}/publish`)).json()) as any).version, 2);
    const nv = await (await call('POST', '/api/vessels', { name: 'M/Y Second' })).json() as any;
    const st = await (await call('GET', `/api/vessels/${nv.id}/state`)).json() as any;
    assert.equal(st.version, 0); assert.equal(st.checklists.length, 0);
  } finally { srv.close(); await db.close(); }
});
