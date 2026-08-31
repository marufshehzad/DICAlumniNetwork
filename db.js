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

// Auto-load .env file if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
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

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

let poolConfig;
if (connectionString) {
  poolConfig = {
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
  };
} else {
  poolConfig = {
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
  query: async (text, params) => {
    if (!pool) throw new Error('Database pool unavailable');
    return await pool.query(text, params);
  },
  pool,
  initDbSchemaAndSeed,
  isCloud: !!connectionString || process.env.PGSSL === 'true'
};

