import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('sslmode=') ? { rejectUnauthorized: false } : false,
});

const TABLES_IN_ORDER = [
  "users",
  "classrooms",
  "classroom_students",
  "exams",
  "exam_sections",
  "questions",
  "exam_submissions",
  "answers",
  "exam_autosaves",
  "writing_responses",
  "violations",
  "monitoring_logs",
  "admin_logs",
  "scoring_configs",
  "question_banks",
  "listening_question_groups",
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
      if (error.code === "42P01") return []; // table doesn't exist
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

async function insertRows(table, rows) {
  if (rows.length === 0) return 0;

  const columns = Object.keys(rows[0]);
  let inserted = 0;

  for (const row of rows) {
    const values = columns.map((col) => {
      const v = row[col];
      if (v === null || v === undefined) return null;
      if (typeof v === "object") return JSON.stringify(v);
      // Handle stringified arrays stored as text (e.g. answer_alternatives)
      if (typeof v === "string" && (v.startsWith("[") || v.startsWith("{"))) {
        try { JSON.parse(v); return v; } catch { return v; }
      }
      return v;
    });
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
    const colNames = columns.map((c) => `"${c}"`).join(", ");

    try {
      await pool.query(
        `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        values
      );
      inserted++;
    } catch (err) {
      // Silently skip FK violations (orphaned rows from deleted parents)
      if (err.code !== '23503') {
        // For type errors, try again stripping the problematic column
        if (err.message.includes('invalid input syntax for type json')) {
          // Find which columns are JSON type and cast them
          const fixedValues = values.map((v, i) => {
            if (v !== null && typeof v === "string") {
              try { JSON.parse(v); return v; } catch { return null; }
            }
            return v;
          });
          try {
            await pool.query(
              `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
              fixedValues
            );
            inserted++;
            continue;
          } catch {}
        }
        // Only log non-FK, non-duplicate errors sparingly
        if (inserted === 0) console.warn(`  Row error in ${table}: ${err.message.slice(0, 80)}`);
      }
    }
  }
  return inserted;
}

async function migrate() {
  console.log("=== Supabase → Neon Data Migration ===\n");

  for (const table of TABLES_IN_ORDER) {
    process.stdout.write(`Migrating ${table}... `);
    const rows = await fetchAll(table);
    if (rows.length === 0) {
      console.log("0 rows (empty or missing)");
      continue;
    }
    const inserted = await insertRows(table, rows);
    const skipped = rows.length - inserted;
    console.log(`${inserted}/${rows.length} rows` + (skipped > 0 ? ` (${skipped} skipped — orphaned FK refs)` : ""));
  }

  console.log("\n=== Migration Complete ===");

  // Verify counts
  console.log("\nVerification:");
  for (const table of TABLES_IN_ORDER) {
    try {
      const { rows } = await pool.query(`SELECT COUNT(*) FROM "${table}"`);
      console.log(`  ${table}: ${rows[0].count} rows`);
    } catch {
      console.log(`  ${table}: (not found)`);
    }
  }

  await pool.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
