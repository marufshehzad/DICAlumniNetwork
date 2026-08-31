/* Applies schema_v4.sql. Idempotent.  Usage: node migrate_v4.js */
const fs = require('fs');
const path = require('path');
const db = require('./db');

(async () => {
  await db.query(fs.readFileSync(path.join(__dirname, 'schema_v4.sql'), 'utf8'));
  console.log('⚡ schema_v4 applied.');

  const col = await db.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'events' AND column_name = 'planning_mode'`);
  console.log('📊 events.planning_mode present:', col.rows.length === 1);
})().then(() => process.exit(0)).catch(e => { console.error('❌', e.message); process.exit(1); });
