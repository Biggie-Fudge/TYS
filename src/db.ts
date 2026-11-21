// One small query interface over two engines: real Postgres (DATABASE_URL set)
// or PGlite, an in-process Postgres used for local dev and tests.
export interface Q { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }
export interface DB extends Q {
  tx<T>(fn: (q: Q) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export async function openDb(url?: string, dataDir?: string): Promise<DB> {
  if (url) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: url,
      ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
    });
    return {
      query: (sql, params) => pool.query(sql, params as any[]),
      exec: async (sql) => { await pool.query(sql); },
      async tx(fn) {
        const c = await pool.connect();
        try {
          await c.query('begin');
          const out = await fn({ query: (s, p) => c.query(s, p as any[]) });
          await c.query('commit');
          return out;
        } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir) (await import('node:fs')).mkdirSync(dataDir, { recursive: true });
  const lite = dataDir ? new PGlite(dataDir) : new PGlite();
  return {
    query: (sql, params) => lite.query(sql, params as any[]),
    exec: async (sql) => { await lite.exec(sql); },
    tx: (fn) => lite.transaction((t) => fn({ query: (s, p) => t.query(s, p as any[]) })) as Promise<any>,
    close: () => lite.close(),
  };
}
