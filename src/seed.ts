import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import { applyRecords, pinHash, type Rec } from './sync.js';
import { publish } from './app.js';

// A made-up vessel so the app opens in a working state. Sample PINs: captain 1111, engineer 2222, deckhand 3333.
const I = (text: string, type = 'check', unit = '', min: number | null = null, max: number | null = null) => ({ id: randomUUID(), text, type, unit, min, max });
const cl = (name: string, freq: string, role: string, countersign: boolean, items: ReturnType<typeof I>[], event = '') => ({ id: randomUUID(), name, freq, role, countersign, event, items });

export async function seedSample(db: DB) {
  if ((await db.query('select 1 from vessels limit 1')).rows.length) return false;
  const vid = 'meridian', t = Date.now(), D = 864e5;
  const c1 = cl('Weekly engine room check', 'Weekly', 'Engineer', false, [I('Port main engine oil level within marks'), I('Starboard main engine oil level within marks'), I('Port engine oil pressure at idle', 'reading', 'psi', 40, 70), I('Starboard engine oil pressure at idle', 'reading', 'psi', 40, 70), I('Coolant level, both engines'), I('Bilge pump float switches lift and run'), I('Bilge dry, no fuel or oil sheen'), I('Fire suppression gauge in the green')]);
  const c2 = cl('Weekly deck and safety walk', 'Weekly', 'Deckhand', false, [I('Dock lines and fenders, no chafe'), I('Life jackets aboard', 'reading', 'count', 12, 20), I('Tender secured, plug in, fuel above half'), I('Navigation lights working'), I('Shore power cord and inlet cool to the touch'), I('Teak and non-skid clean and dry', 'photo')]);
  const c3 = cl('Monthly generator service check', 'Monthly', 'Engineer', true, [I('Generator hours', 'reading', 'hrs'), I('Generator oil level'), I('Raw water strainer clear'), I('Belt tension'), I('Voltage after 15 minutes under load', 'reading', 'V', 115, 125)]);
  const c4 = cl('Quarterly fire and safety equipment', 'Quarterly', 'Captain', false, [I('Extinguishers charged and tagged', 'reading', 'count', 8, 12), I('Flares in date'), I('EPIRB battery date and self-test'), I('First aid kit restocked'), I('Life raft service date current')]);
  const lists = [c1, c2, c3, c4,
    cl('Pre-departure', 'On demand', 'Captain', true, [I('Weather and route briefed'), I('Fuel aboard', 'reading', '%', 30, 100), I('Fresh water', 'reading', '%', 25, 100), I('Engine room walk-through complete'), I('Bilges dry'), I('Electronics on, GPS fix confirmed'), I('Lines, fenders and shore power stowed'), I('Guest safety briefing given')], 'pre'),
    cl('Arrival', 'On demand', 'Captain', false, [I('Lines and fenders set'), I('Shore power connected, load transferred'), I('Engines shut down, hours logged'), I('Stabilizer centered and off')], 'arr'),
    cl('Post-trip', 'On demand', 'Deckhand', false, [I('Washdown complete'), I('Engine room walk-through, no leaks'), I('Fuel remaining', 'reading', '%', 0, 100), I('Defects noted for follow-up', 'note'), I('Interior reset to owner standard')], 'post'),
    cl('Owner readiness', 'On demand', 'Deckhand', true, [I('Cabin temperature two hours before arrival', 'reading', '°F', 70, 74), I('Galley provisioned from the preference sheet'), I('Tender fueled and launched'), I('Exterior cushions out'), I('Audio and Wi-Fi tested')], 'owner'),
  ];
  await db.query(`insert into vessels(id,name,type,year,port,owner,draft) values($1,'M/Y Meridian','78 ft motor yacht','2019','Fort Lauderdale, FL','Jonathan Hale',$2::jsonb)`, [vid, JSON.stringify(lists)]);
  for (const [name, role, pin] of [['Capt. Dana Whitlock', 'Captain', '1111'], ['Marco Ruiz', 'Engineer', '2222'], ['Tess Okafor', 'Deckhand', '3333']])
    await db.query('insert into users(id,vessel_id,name,role,pin_hash) values($1,$2,$3,$4,$5)', [randomUUID(), vid, name, role, pinHash(vid, pin)]);
  for (const [name, detail, loc] of [['Main engines', 'Twin diesels, 1,200 hp each', 'Engine room'], ['Generator', '27 kW diesel', 'Engine room, aft'], ['Watermaker', '1,800 gal per day', 'Lazarette'], ['Gyro stabilizer', 'Single unit', 'Engine room, centerline'], ['Tender', '15 ft RIB, 60 hp outboard', 'Swim platform']])
    await db.query('insert into equipment(id,vessel_id,name,detail,loc) values($1,$2,$3,$4,$5)', [randomUUID(), vid, name, detail, loc]);
  await publish(db, vid);
  // Back-date the schedule so Today shows one overdue check, two due today and one coming up.
  await db.query('delete from dues where vessel_id=$1', [vid]);
  for (const [c, off] of [[c3, -2], [c1, 0], [c2, 0], [c4, 3]] as const)
    await db.query('insert into dues(id,vessel_id,checklist_id,due_at) values($1,$2,$3,$4)', [randomUUID(), vid, c.id, new Date(t + off * D).toISOString()]);
  await db.query(`update vessels set published_at=$2 where id=$1`, [vid, new Date(t - 40 * D).toISOString()]);
  await db.query(`delete from activity where vessel_id=$1`, [vid]);

  const run = (c: typeof c1, by: string, at: number): Rec => ({ id: randomUUID(), type: 'run', data: { clId: c.id, clName: c.name, version: 1, by, at,
    results: c.items.map((it) => ({ text: it.text, type: it.type, unit: it.unit, note: '', photo: null, flag: false,
      val: it.type === 'reading' ? String(it.min != null && it.max != null ? Math.round((it.min + it.max) / 2) : 412) : it.type === 'check' ? 'pass' : '' })) } });
  const recs: Rec[] = [];
  for (const d of [21, 14, 7]) recs.push(run(c1, 'Marco Ruiz', t - d * D + 3e6), run(c2, 'Tess Okafor', t - d * D + 5e6));
  recs.push(run(c3, 'Marco Ruiz', t - 32 * D));
  const closedIssue = randomUUID();
  recs.push(
    { id: closedIssue, type: 'issue', data: { title: 'Navigation lights working', note: 'Starboard running light out.', by: 'Tess Okafor', at: t - 14 * D, from: 'Weekly deck and safety walk' } },
    { id: randomUUID(), type: 'issue_event', data: { issueId: closedIssue, kind: 'close', assignee: 'Tess Okafor', due: '', fix: 'Replaced the bulb and tested at dusk.', at: t - 12 * D } },
    { id: randomUUID(), type: 'issue', data: { title: 'Watermaker pre-filter pressure (read 31 psi)', note: 'Reading above range after a 20 minute run. Filter looks loaded.', by: 'Marco Ruiz', at: t - 3 * D, from: 'Engineer walk-through' } },
    { id: randomUUID(), type: 'log', data: { at: t - 9 * D, by: 'Capt. Dana Whitlock', port: '1,402', stbd: '1,399', gen: '2,210', fuel: '64', note: 'Arrived Bimini. Smooth crossing.' } },
    { id: randomUUID(), type: 'log', data: { at: t - 8 * D, by: 'Capt. Dana Whitlock', port: '1,406', stbd: '1,403', gen: '2,231', fuel: '41', note: 'Back at home dock. Fuel ordered for Friday.' } },
    { id: randomUUID(), type: 'trip', data: { name: 'Fort Lauderdale to Bimini and back', startedAt: t - 9 * D, closedAt: t - 8 * D } },
    { id: randomUUID(), type: 'request', data: { by: 'Capt. Dana Whitlock', at: t - 5 * D, text: 'Add a check for the new underwater lights to the weekly deck walk.' } },
    { id: randomUUID(), type: 'activity', data: { at: t - 7 * D + 3e6, text: 'Marco Ruiz signed Weekly engine room check' } },
    { id: randomUUID(), type: 'activity', data: { at: t - 7 * D + 5e6, text: 'Tess Okafor signed Weekly deck and safety walk' } },
    { id: randomUUID(), type: 'activity', data: { at: t - 3 * D, text: 'Marco Ruiz raised an issue: watermaker pre-filter pressure' } },
  );
  const out = await applyRecords(db, vid, recs);
  if (out.rejected.length) throw new Error('seed rejected: ' + JSON.stringify(out.rejected));
  return true;
}
