#!/usr/bin/env node
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createPostgresStore } from '../src/postgres-store.js';

const { Pool } = pg;
const bundledSupabaseCaUrl = new URL('../certs/supabase-prod-ca-2021.crt', import.meta.url);
const databaseUrl = process.env.DATABASE_URL;
const writeTest = process.env.BACKUP_DRILL_WRITE_TEST === 'true';

const tables = [
  'agents',
  'listings',
  'offers',
  'trades',
  'payment_intents',
  'payment_events',
  'audit_events',
  'request_logs',
  'signed_request_nonces'
];

if (!databaseUrl) {
  console.error(JSON.stringify({
    ok: false,
    error: 'DATABASE_URL is required.'
  }, null, 2));
  process.exit(1);
}

async function main() {
  const store = createPostgresStore({ connectionString: databaseUrl });
  const ssl = databaseUrl.includes('supabase.com')
    ? { rejectUnauthorized: true, ca: readFileSync(bundledSupabaseCaUrl, 'utf8') }
    : databaseUrl.includes('sslmode=require')
      ? { rejectUnauthorized: true }
      : undefined;
  const pool = new Pool({ connectionString: databaseUrl, ssl });
  const client = await pool.connect();
  try {
    const counts = {};
    for (const table of tables) {
      try {
        const { rows } = await client.query(`select count(*)::int as count from ${table}`);
        counts[table] = rows[0].count;
      } catch (error) {
        counts[table] = { error: error.message };
      }
    }

    let rollbackWrite = null;
    if (writeTest) {
      await client.query('begin');
      await client.query('create temp table agent_exchange_restore_drill (id text primary key, created_at timestamptz default now())');
      await client.query('insert into agent_exchange_restore_drill (id) values ($1)', [`drill_${Date.now()}`]);
      const { rows } = await client.query('select count(*)::int as count from agent_exchange_restore_drill');
      await client.query('rollback');
      rollbackWrite = { ok: rows[0].count === 1, rolledBack: true };
    }

    const reconciliation = typeof store.listPaymentIntents === 'function'
      ? {
          paymentIntentsReadable: Array.isArray(await store.listPaymentIntents({ limit: 1, offset: 0 }))
        }
      : { paymentIntentsReadable: false };

    console.log(JSON.stringify({
      ok: Object.values(counts).every((value) => typeof value === 'number'),
      checkedAt: new Date().toISOString(),
      tables: counts,
      rollbackWrite,
      reconciliation
    }, null, 2));
  } finally {
    client.release();
    await pool.end();
    await store.close?.();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message
  }, null, 2));
  process.exitCode = 1;
});
