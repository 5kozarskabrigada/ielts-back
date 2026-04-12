import pg from 'pg';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('sslmode=require') ? { rejectUnauthorized: false } : false
});

try {
  const sql = fs.readFileSync('neon-schema.sql', 'utf8');
  await pool.query(sql);
  console.log('Schema applied successfully');

  const tables = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
  );
  console.log('Tables created:', tables.rows.map(r => r.tablename).join(', '));
} catch (err) {
  console.error('Schema error:', err.message);
} finally {
  await pool.end();
}
