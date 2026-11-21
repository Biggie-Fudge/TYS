import { openDb } from './db.js';
import { SCHEMA } from './schema.js';
import { createApp } from './app.js';
import { seedSample } from './seed.js';

const url = process.env.DATABASE_URL;
const db = await openDb(url, url ? undefined : '.data/pg');
await db.exec(SCHEMA);
// Sample vessel: always in local dev, and on a server only when SEED_SAMPLE=1.
if (!url || process.env.SEED_SAMPLE === '1') { if (await seedSample(db)) console.log('Seeded the sample vessel.'); }
if (url && !process.env.TYS_ACCESS_CODE) console.warn('TYS_ACCESS_CODE is not set. The API is open to anyone with the address.');

const port = Number(process.env.PORT) || 3000;
createApp(db, { accessCode: process.env.TYS_ACCESS_CODE }).listen(port, () => console.log(`TYS listening on ${port} (${url ? 'Postgres' : 'local PGlite in .data/pg'})`));
