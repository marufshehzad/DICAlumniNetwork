/* ============================================================
   DAFFODIL INTERNATIONAL COLLEGE (DIC) ALUMNI PLATFORM
   PostgreSQL Database Connection Pool & Serverless Fallback Layer
   Supports both Local & Cloud PostgreSQL (Neon, Supabase, Render, etc.)
   ============================================================ */

const { Pool, types } = require('pg');

/* A DATE column carries no time and no zone. node-pg's default parser turns it
   into a JS Date at the *server's* local midnight, which then serialises to
   JSON as a UTC instant — so a task due 2026-10-29 reached the browser as
   "2026-10-28T18:00:00Z" on a UTC+6 host and re-saved as the 28th. Handing
   DATE back as the plain 'YYYY-MM-DD' string keeps it zone-free end to end.
   TIMESTAMPTZ (1184) is untouched: those really are instants. */
types.setTypeParser(1082, (v) => v);
const fs = require('fs');
const path = require('path');

/* Auto-load .env file if present.

   DIC_SKIP_DOTENV=1 ignores the file entirely. That exists so the production
   fail-closed behaviour can be tested on a machine that has a .env — without
   it, a developer's file silently supplies the very variable the test is
   trying to remove, and the test passes for the wrong reason.

   It can only ever make the configuration smaller, never weaker-but-running:
   with a variable genuinely absent, production refuses to start. */
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath) && process.env.DIC_SKIP_DOTENV !== '1') {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.substring(0, idx).trim();
        let val = trimmed.substring(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.substring(1, val.length - 1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  });
}

/* The institution's timezone, applied to every connection in the pool.

   Business dates are local dates. An event "today", a task due "today" and a
   grace period that expires "today" all mean today in Dhaka, not today in UTC.
   Without this the session timezone is the database host's, which on a managed
   provider is UTC — and Bangladesh is UTC+6, so between midnight and 06:00
   local, CURRENT_DATE is still yesterday.

   That window is not hypothetical: vercel.json fires the nightly jobs at 20:10
   UTC, which is 02:10 in Dhaka, squarely inside it. The event status
   roll-forward compares starts_on against CURRENT_DATE, so an event beginning
   today was left 'upcoming' until the following night — a full day late, every
   time, for as long as the platform has existed.

   timestamptz comparisons (purge_after, expires_at) are absolute instants and
   are unaffected either way. DATE columns are handed back as plain strings by
   the parser above, so they are unaffected too. What changes is exactly what
   should: CURRENT_DATE and friends now mean the date in Bangladesh. */
const DB_TIMEZONE = process.env.DB_TIMEZONE || 'Asia/Dhaka';

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

let poolConfig;
if (connectionString) {
  poolConfig = {
    connectionString,
    options: `-c timezone=${DB_TIMEZONE}`,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
  };
} else {
  poolConfig = {
    options: `-c timezone=${DB_TIMEZONE}`,
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT || '5432'),
    database: process.env.PGDATABASE || 'dic_alumni_db',
    user: process.env.PGUSER || process.env.USER || 'mohiuddin',
    password: process.env.PGPASSWORD || '',
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 5000,
  };
}

let pool = null;

try {
  pool = new Pool(poolConfig);

  pool.on('error', (err) => {
    console.warn('PostgreSQL Pool Connection Warning:', err.message);
  });
} catch (e) {
  console.warn('PostgreSQL Pool Initialization Warning:', e.message);
}

/**
 * Initializes Database Schema & Populates Dummy Seed Data
 */
async function initDbSchemaAndSeed() {
  if (!pool) throw new Error('Database pool unavailable');
  try {
    const schemaSqlPath = path.join(__dirname, 'schema.sql');
    const seedSqlPath = path.join(__dirname, 'seed.sql');

    if (fs.existsSync(schemaSqlPath)) {
      const schemaSql = fs.readFileSync(schemaSqlPath, 'utf8');
      await pool.query(schemaSql);
      console.log('⚡ Schema tables verified / initialized successfully.');
    }

    if (fs.existsSync(seedSqlPath)) {
      const seedSql = fs.readFileSync(seedSqlPath, 'utf8');
      await pool.query(seedSql);
      console.log('🌱 Seed dummy data uploaded successfully.');
    }
    return { success: true, message: 'Database schema & seed data uploaded successfully.' };
  } catch (err) {
    console.error('Error initializing database schema/seed:', err.message);
    throw err;
  }
}

module.exports = {
  timezone: DB_TIMEZONE,
  query: async (text, params) => {
    if (!pool) throw new Error('Database pool unavailable');
    return await pool.query(text, params);
  },
  pool,
  initDbSchemaAndSeed,
  isCloud: !!connectionString || process.env.PGSSL === 'true'
};

