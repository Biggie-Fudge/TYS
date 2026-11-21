// Rule one from the brief: devices only add records. Every write from a device
// lands in `events` first, keyed by the id the device generated, so a retried
// sync can never create a duplicate. Rule two: the standard changes only
// through publish, and every run records the version it ran against.
export const SCHEMA = `
create table if not exists vessels(
  id text primary key, name text not null, type text default '', year text default '',
  port text default '', owner text default '',
  version int not null default 0, published_at timestamptz,
  checklists jsonb not null default '[]', draft jsonb not null default '[]',
  created_at timestamptz not null default now());
create table if not exists standard_versions(
  vessel_id text not null references vessels(id), version int not null,
  checklists jsonb not null, published_at timestamptz not null default now(),
  primary key(vessel_id, version));
create table if not exists users(
  id text primary key, vessel_id text not null references vessels(id),
  name text not null, role text not null, pin_hash text not null);
create table if not exists equipment(
  id text primary key, vessel_id text not null references vessels(id),
  name text not null, detail text default '', loc text default '');
create table if not exists events(
  id text primary key, vessel_id text not null references vessels(id),
  type text not null, data jsonb not null, received_at timestamptz not null default now());
create table if not exists dues(
  id text primary key, vessel_id text not null references vessels(id),
  checklist_id text not null, due_at timestamptz not null, run_id text);
create table if not exists runs(
  id text primary key, vessel_id text not null references vessels(id),
  checklist_id text, checklist_name text not null, version int not null,
  signed_by text not null, signed_at timestamptz not null, results jsonb not null,
  needs_counter boolean not null default false, counter_by text, counter_at timestamptz,
  trip_id text, due_id text, received_at timestamptz not null default now());
create table if not exists issues(
  id text primary key, vessel_id text not null references vessels(id),
  title text not null, note text default '', photo text, raised_by text default '',
  raised_at timestamptz not null, source text default '', assignee text default '',
  due text default '', status text not null default 'open', fix text default '',
  closed_at timestamptz, comments jsonb not null default '[]');
create table if not exists log_entries(
  id text primary key, vessel_id text not null references vessels(id),
  at timestamptz not null, by_name text default '', port text default '', stbd text default '',
  gen text default '', fuel text default '', note text default '');
create table if not exists trips(
  id text primary key, vessel_id text not null references vessels(id),
  name text not null, started_at timestamptz not null, closed_at timestamptz not null);
create table if not exists change_requests(
  id text primary key, vessel_id text not null references vessels(id),
  by_name text default '', at timestamptz not null, text text not null, status text not null default 'open');
create table if not exists activity(
  id text primary key, vessel_id text not null references vessels(id),
  at timestamptz not null, text text not null);
create table if not exists photos(
  id text primary key, vessel_id text not null references vessels(id),
  mime text not null, data bytea not null, created_at timestamptz not null default now());
create index if not exists runs_vessel on runs(vessel_id, signed_at desc);
create index if not exists issues_vessel on issues(vessel_id, raised_at desc);
create index if not exists events_vessel on events(vessel_id, received_at);
`;
