const fs = require('fs');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required to initialize the database.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function runInit() {
  try {
    const sql = fs.readFileSync('init.sql', 'utf8');
    console.log('Connecting to database... running init.sql');
    await pool.query(sql);
    console.log('Successfully executed init.sql! Tables and PostGIS configured.');
  } catch (err) {
    console.error('Error executing init.sql:', err.message);
  } finally {
    await pool.end();
  }
}

runInit();
