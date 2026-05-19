import pg from 'pg';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

try {
  const sql = fs.readFileSync('migrations/add_speaking_band_score.sql', 'utf8');
  await pool.query(sql);
  console.log('Migration applied successfully');
} catch (err) {
  console.error('Migration error:', err.message);
} finally {
  await pool.end();
}
