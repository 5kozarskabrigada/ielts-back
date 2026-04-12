import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('sslmode=') ? { rejectUnauthorized: false } : false,
  max: 5,
});

const TABLES = [
  "answers",
  "exam_autosaves",
  "writing_responses",
  "violations",
  "monitoring_logs",
  "scoring_configs",
];

async function fetchAll(table) {
  let allRows = [];
  let from = 0;
  const batchSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .range(from, from + batchSize - 1);
    if (error) {
      if (error.code === "42P01") return [];
      console.warn(`  Warning fetching ${table}: ${error.message}`);
      return allRows;
    }
    if (!data || data.length === 0) break;
    allRows = allRows.concat(data);
    if (data.length < batchSize) break;
    from += batchSize;
  }
  return allRows;
}

function prepValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

async function migrateTable(table, rows) {
  if (rows.length === 0) return 0;
  const columns = Object.keys(rows[0]);
  const colNames = columns.map((c) => `"${c}"`).join(", ");
  let totalInserted = 0;
  let errors = 0;

  // Insert row by row but with connection reuse (fast enough for <3000 rows)
  for (const row of rows) {
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
    const values = columns.map((col) => prepValue(row[col]));
    try {
      const result = await pool.query(
        `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        values
      );
      totalInserted += result.rowCount;
    } catch (err) {
      errors++;
      if (errors <= 3) console.warn(`  Error: ${err.message.slice(0, 120)}`);
    }
  }
  if (errors > 3) console.warn(`  ... and ${errors - 3} more errors`);
  return totalInserted;
}

async function migrate() {
  console.log("=== Finishing Remaining Data Migration ===\n");

  for (const table of TABLES) {
    const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM "${table}"`);
    const existingCount = parseInt(countRows[0].count);

    process.stdout.write(`Migrating ${table} (${existingCount} exist)... `);
    const rows = await fetchAll(table);

    if (rows.length === 0) {
      console.log("0 in source");
      continue;
    }

    if (existingCount >= rows.length) {
      console.log(`already complete (${existingCount}/${rows.length})`);
      continue;
    }

    const inserted = await migrateTable(table, rows);

    const { rows: finalCount } = await pool.query(`SELECT COUNT(*) FROM "${table}"`);
    console.log(`${finalCount[0].count}/${rows.length} rows (${inserted} new)`);
  }

  console.log("\n=== Full Table Counts ===");
  const allTables = ['users','classrooms','classroom_students','exams','exam_sections','questions',
    'listening_question_groups','exam_submissions','answers','exam_autosaves','writing_responses',
    'violations','monitoring_logs','admin_logs','scoring_configs','question_banks'];
  for (const t of allTables) {
    const { rows } = await pool.query(`SELECT COUNT(*) FROM "${t}"`);
    console.log(`  ${t}: ${rows[0].count}`);
  }

  await pool.end();
  console.log("\n=== Done ===");
}

migrate().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
